#!/usr/bin/env node
// Astra MCP server: lets Claude Code delegate work to GPT-6.2 Astra through
// `codex exec --json`, and keeps the raw event trace on disk so the
// interface model can ground every claim in what Astra actually did.
//
// Zero dependencies. Speaks MCP over stdio (newline-delimited JSON-RPC).

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const RUNS_DIR = path.resolve(process.env.FUSION_RUNS_DIR || '.fusion/runs');
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const DEFAULT_MODEL = process.env.ASTRA_MODEL || 'gpt-6.2-astra';
const DEFAULT_EFFORT = process.env.ASTRA_EFFORT || 'high';
// Astra runs with its own Codex home so it does not load the user's personal
// MCP servers, plugins, account connectors or global AGENTS.md.
// Set FUSION_CODEX_HOME=inherit to use the personal Codex home instead.
const FUSION_HOME = process.env.FUSION_CODEX_HOME === 'inherit'
  ? null
  : path.resolve(process.env.FUSION_CODEX_HOME || '.fusion/codex-home');
const PERSONAL_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SANDBOXES = ['read-only', 'workspace-write'];
const MAX_WAIT_S = 240;
const MAX_DIGEST_CHARS = 12000;

const live = new Map(); // run_id -> { child, done: Promise }
const cursors = new Map(); // run_id -> last seq returned by astra_wait

// ---------- run storage ----------

const runDir = (id) => path.join(RUNS_DIR, id);
const eventsPath = (id) => path.join(runDir(id), 'events.jsonl');
const metaPath = (id) => path.join(runDir(id), 'meta.json');

function readMeta(id) {
  if (!/^[a-z0-9-]+$/.test(id || '') || !fs.existsSync(metaPath(id))) {
    throw new Error(`Unknown run_id "${id}". Runs live in ${RUNS_DIR}.`);
  }
  return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
}

function writeMeta(id, patch) {
  const current = fs.existsSync(metaPath(id)) ? JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) : {};
  const next = { ...current, ...patch };
  fs.writeFileSync(metaPath(id), JSON.stringify(next, null, 2));
  return next;
}

// Each complete line of events.jsonl is one event; its 1-based line number is
// the sequence number the interface model cites.
function readEvents(id) {
  if (!fs.existsSync(eventsPath(id))) return [];
  const text = fs.readFileSync(eventsPath(id), 'utf8');
  const lines = text.split('\n');
  if (!text.endsWith('\n')) lines.pop(); // drop a partially written line
  const out = [];
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    let ev = null;
    try { ev = JSON.parse(raw); } catch { /* keep as raw text */ }
    out.push({ seq: i + 1, raw, ev });
  });
  return out;
}

// ---------- Codex home ----------

const FUSION_CONFIG = `# Codex config for Legible fusion runs. Created by server/astra-mcp.mjs; edit freely,
# it is only written when missing. Model, reasoning effort and sandbox are passed
# per run on the command line and override anything here.
approval_policy = "never"
sandbox_mode = "read-only"

# No subagents: their work would not appear in the trace.
[agents]
enabled = false

[features]
# ChatGPT account connectors (Gmail, Drive, Linear, ...). They run outside the sandbox.
apps = false
plugins = false
remote_plugin = false
computer_use = false
browser_use = false
browser_use_external = false
goals = false
image_generation = false
tool_suggest = false
skill_mcp_dependency_install = false
`;

// Creates the fusion Codex home if needed and links the user's login into it.
// Returns { home, note } where note describes a login problem, if any.
function ensureCodexHome() {
  if (!FUSION_HOME) return { home: null, note: null };
  fs.mkdirSync(FUSION_HOME, { recursive: true });
  const config = path.join(FUSION_HOME, 'config.toml');
  if (!fs.existsSync(config)) fs.writeFileSync(config, FUSION_CONFIG);
  const source = path.join(PERSONAL_HOME, 'auth.json');
  const link = path.join(FUSION_HOME, 'auth.json');
  let stat = null;
  try { stat = fs.lstatSync(link); } catch { /* not there yet */ }
  if (stat?.isSymbolicLink()) {
    if (fs.existsSync(link)) return { home: FUSION_HOME, note: null };
    fs.unlinkSync(link); // dangling; relink below
    stat = null;
  }
  if (stat) {
    return { home: FUSION_HOME, note: `${link} is a regular file, not a link to ${source}. Codex may have replaced the link when it refreshed the login, so the two copies can drift apart. Delete it to relink, and run \`codex login\` if either side stops working.` };
  }
  if (!fs.existsSync(source)) {
    return { home: FUSION_HOME, note: `No Codex login found at ${source}. Run \`codex login\`, or if your login is kept in the system keychain, run \`CODEX_HOME=${FUSION_HOME} codex login\`.` };
  }
  fs.symlinkSync(source, link);
  return { home: FUSION_HOME, note: null };
}

// ---------- spawning Codex ----------

function startSegment(id, kind, args, prompt) {
  const meta = readMeta(id);
  fs.appendFileSync(
    eventsPath(id),
    JSON.stringify({ type: 'fusion.segment', kind, at: new Date().toISOString(), prompt }) + '\n',
  );
  const env = meta.codex_home ? { ...process.env, CODEX_HOME: meta.codex_home } : process.env;
  const child = spawn(CODEX_BIN, args, { cwd: meta.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(eventsPath(id), { flags: 'a' });
  const err = fs.createWriteStream(path.join(runDir(id), 'stderr.log'), { flags: 'a' });
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  writeMeta(id, { status: 'running', segment_started_at: Date.now(), exit_code: null, error: null });
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (patch) => {
      if (settled) return;
      settled = true;
      live.delete(id);
      out.end(() => { writeMeta(id, patch); resolve(); });
    };
    child.on('error', (e) => finish({
      status: 'failed',
      error: e.code === 'ENOENT'
        ? `Could not find the Codex CLI ("${CODEX_BIN}"). Install it with: npm i -g @openai/codex`
        : String(e.message || e),
    }));
    child.on('close', (code, signal) => finish({
      status: signal ? 'cancelled' : code === 0 ? 'completed' : 'failed',
      exit_code: code,
    }));
  });
  live.set(id, { child, done });
}

function codexArgs({ resumeThread, model, effort, sandbox, cwd }) {
  const common = ['--json', '--skip-git-repo-check', '-m', model,
    '-c', `model_reasoning_effort="${effort}"`, '-c', `sandbox_mode="${sandbox}"`];
  return resumeThread
    ? ['exec', 'resume', resumeThread, ...common, '-']
    : ['exec', ...common, '-C', cwd, '-'];
}

// ---------- trace digest ----------

const clip = (s, n) => {
  s = String(s ?? '').trim();
  return s.length <= n ? s : `${s.slice(0, Math.floor(n * 0.6))} …[${s.length - n} chars cut]… ${s.slice(-Math.floor(n * 0.4))}`;
};

// Codex wraps every command as `/bin/zsh -lc '<cmd>'`. Show the inner command
// when the quoting is simple enough to strip safely.
function unwrapShell(cmd) {
  const m = /^\/bin\/(?:zsh|bash|sh) -lc (.+)$/s.exec(String(cmd ?? ''));
  if (!m) return String(cmd ?? '');
  const q = m[1];
  if (/^'[^']*'$/.test(q)) return q.slice(1, -1);
  if (/^"(?:[^"\\$`]|\\["\\$`])*"$/.test(q)) return q.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return q;
}

const relPath = (p, cwd) => (cwd && typeof p === 'string' && p.startsWith(cwd + path.sep) ? p.slice(cwd.length + 1) : p);

// Codex reports thread-cumulative token counts on every turn.completed.
const usageText = (u) => `thread total so far: ${u.input_tokens ?? '?'} input tokens (${u.cached_input_tokens ?? 0} cached), ${u.output_tokens ?? '?'} output`;

function digestEvent({ seq, raw, ev }, full, cwd) {
  const n = full ? 4000 : 500;
  const tag = `[${seq}]`;
  if (!ev) return `${tag} raw: ${clip(raw, n)}`;
  switch (ev.type) {
    case 'fusion.segment':
      return `${tag} ── ${ev.kind === 'reply' ? 'follow-up sent to Astra' : 'brief sent to Astra'}: ${clip(ev.prompt, full ? 4000 : 200)}`;
    case 'thread.started':
      return `${tag} thread started (${ev.thread_id})`;
    case 'turn.started':
    case 'item.started':
    case 'item.updated':
      return null;
    case 'turn.completed':
      return `${tag} turn completed${ev.usage ? ` (${usageText(ev.usage)})` : ''}`;
    case 'turn.failed':
      return `${tag} TURN FAILED: ${clip(ev.error?.message ?? JSON.stringify(ev.error), n)}`;
    case 'error':
      return `${tag} error: ${clip(ev.message, n)}`;
    case 'item.completed': {
      const it = ev.item || {};
      switch (it.type) {
        case 'agent_message': return `${tag} Astra said: ${clip(it.text, full ? 8000 : 1200)}`;
        case 'reasoning': return `${tag} reasoning: ${clip(it.text, n)}`;
        case 'command_execution':
          return `${tag} ran \`${clip(unwrapShell(it.command), 300)}\` → exit ${it.exit_code ?? '?'}${it.aggregated_output ? `\n      ${clip(it.aggregated_output, n).replace(/\n/g, '\n      ')}` : ''}`;
        case 'file_change':
          return `${tag} file changes${it.status ? ` (${it.status})` : ''}: ${(it.changes || []).map((c) => `${c.kind} ${relPath(c.path, cwd)}`).join(', ')}`;
        case 'mcp_tool_call': return `${tag} tool call ${it.server}.${it.tool} (${it.status ?? 'done'})`;
        case 'web_search': {
          const urls = (it.results || []).map((r) => r.url).filter(Boolean);
          const shown = urls.slice(0, full ? 20 : 5);
          return `${tag} web search: ${clip(it.query || it.action?.query, 300)}${urls.length ? ` → ${urls.length} results${shown.map((u) => `\n      ${u}`).join('')}${urls.length > shown.length ? `\n      … ${urls.length - shown.length} more in the raw trace` : ''}` : ''}`;
        }
        case 'todo_list':
          return `${tag} plan: ${(it.items || []).map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('; ')}`;
        // Codex sends its non-fatal startup warnings (config, feature flags) as
        // error items. Real failures arrive as top-level error / turn.failed.
        case 'error': return `${tag} Codex notice: ${clip(it.message, full ? n : 160)}`;
        default: return `${tag} ${it.type ?? 'item'}: ${clip(JSON.stringify(it), n)}`;
      }
    }
    default:
      return `${tag} ${ev.type ?? 'event'}: ${clip(JSON.stringify(ev), n)}`;
  }
}

function digest(events, full, cwd) {
  const lines = [];
  let size = 0;
  let lastError = null;
  for (const e of events) {
    const line = digestEvent(e, full, cwd);
    if (!line) continue;
    // Codex repeats "Reconnecting..." errors; keep one of each run of duplicates.
    const body = line.replace(/^\[\d+\] /, '');
    const repeatable = /^(error|Codex notice):/.test(body);
    if (repeatable && body === lastError) continue;
    lastError = repeatable ? body : null;
    if (size + line.length > MAX_DIGEST_CHARS) {
      lines.push(`… digest cut here. Call astra_trace with from_seq=${e.seq} for the rest.`);
      break;
    }
    lines.push(line);
    size += line.length;
  }
  return lines.join('\n');
}

function lastSegment(events) {
  let start = 0;
  events.forEach((e, i) => { if (e.ev?.type === 'fusion.segment') start = i; });
  return events.slice(start);
}

function finalMessage(events) {
  const msgs = lastSegment(events).filter((e) => e.ev?.type === 'item.completed' && e.ev.item?.type === 'agent_message');
  return msgs.length ? msgs[msgs.length - 1] : null;
}

function threadId(events) {
  return events.find((e) => e.ev?.type === 'thread.started')?.ev.thread_id ?? null;
}

function statusOf(id) {
  const meta = readMeta(id);
  if (live.has(id)) return { meta, status: 'running' };
  if (meta.status === 'running') return { meta, status: 'interrupted (the MCP server restarted mid-run; the trace on disk is still valid)' };
  return { meta, status: meta.status };
}

// ---------- tools ----------

const tools = {
  astra_start: {
    description:
      'Hand a task to GPT-6.2 Astra (the solver). Returns a run_id immediately; Astra works in the background. ' +
      'Follow with astra_wait. The brief is the only context Astra gets, so make it complete: goal, context, constraints, what done looks like.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'The full task brief for Astra.' },
        cwd: { type: 'string', description: 'Absolute path of the directory Astra works in. Defaults to the directory Claude Code was started in.' },
        sandbox: { type: 'string', enum: SANDBOXES, description: 'read-only (default): Astra can read and run commands but not write files. workspace-write: Astra may edit files under cwd.' },
        model: { type: 'string', description: `Codex model id. Default ${DEFAULT_MODEL}.` },
        effort: { type: 'string', description: `Reasoning effort. Default ${DEFAULT_EFFORT}.` },
      },
      required: ['brief'],
    },
    async run({ brief, cwd, sandbox = 'read-only', model = DEFAULT_MODEL, effort = DEFAULT_EFFORT }) {
      if (!brief?.trim()) throw new Error('brief is empty.');
      if (!SANDBOXES.includes(sandbox)) throw new Error(`sandbox must be one of: ${SANDBOXES.join(', ')}.`);
      let dir = path.resolve(cwd || process.cwd());
      if (!fs.existsSync(dir)) throw new Error(`cwd does not exist: ${dir}`);
      dir = fs.realpathSync(dir); // Codex reports resolved paths (/private/tmp, not /tmp)
      const id = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
      fs.mkdirSync(runDir(id), { recursive: true });
      const { home, note } = ensureCodexHome();
      writeMeta(id, { run_id: id, cwd: dir, sandbox, model, effort, codex_home: home, created_at: Date.now() });
      startSegment(id, 'start', codexArgs({ model, effort, sandbox, cwd: dir }), brief);
      return `run_id: ${id}\nstatus: running\nmodel: ${model} (effort ${effort}), sandbox: ${sandbox}, cwd: ${dir}\ncodex home: ${home ? `${home} (fusion-only config; login linked from ${PERSONAL_HOME})` : `${PERSONAL_HOME} (personal config, including its MCP servers and plugins)`}${note ? `\nwarning: ${note}` : ''}\nraw trace: ${eventsPath(id)}\nnext: call astra_wait with this run_id.`;
    },
  },

  astra_wait: {
    description:
      'Wait for an Astra run to finish, or for timeout_s to pass, then return its status and a digest of the trace events since the last astra_wait. ' +
      'Each event has a [seq] number: cite these when reporting what Astra did. When the run is finished the result includes Astra\'s final message.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        timeout_s: { type: 'number', description: `Seconds to wait before returning a progress digest. Default 120, max ${MAX_WAIT_S}.` },
      },
      required: ['run_id'],
    },
    async run({ run_id, timeout_s = 120 }) {
      readMeta(run_id);
      const entry = live.get(run_id);
      if (entry) {
        const ms = Math.min(Math.max(Number(timeout_s) || 0, 1), MAX_WAIT_S) * 1000;
        let timer;
        await Promise.race([entry.done, new Promise((r) => { timer = setTimeout(r, ms); })]);
        clearTimeout(timer);
      }
      const { meta, status } = statusOf(run_id);
      const events = readEvents(run_id);
      const from = cursors.get(run_id) ?? 0;
      const fresh = events.filter((e) => e.seq > from);
      if (events.length) cursors.set(run_id, events[events.length - 1].seq);
      const elapsed = Math.round((Date.now() - meta.segment_started_at) / 1000);
      const parts = [
        `run_id: ${run_id}`,
        `status: ${status}${meta.exit_code != null ? ` (exit ${meta.exit_code})` : ''}${status === 'running' ? `, ${elapsed}s so far` : ''}`,
      ];
      if (meta.error) parts.push(`error: ${meta.error}`);
      parts.push(`raw trace: ${eventsPath(run_id)}`, '', '--- new trace events ---', digest(fresh, false, meta.cwd) || '(none)');
      if (status === 'running') {
        parts.push('', 'next: Astra is still working. Call astra_wait again. Tell the user something only if a decision, deviation or risk showed up above.');
      } else {
        const fm = finalMessage(events);
        parts.push('', `--- Astra's final message${fm ? ` [${fm.seq}]` : ''} ---`, fm ? fm.ev.item.text : '(Astra produced no final message; see stderr.log in the run folder)');
        parts.push('', 'next: verify the claims that matter against the trace or the files themselves, then report. Use astra_reply to send Astra back for anything missing or wrong.',
          'note: commands the sandbox blocked do not appear in this trace (Codex leaves them out of its event stream). If Astra reports a blocked or failed command you cannot find above, say you could not confirm it.');
      }
      return parts.join('\n');
    },
  },

  astra_reply: {
    description:
      'Send a follow-up message to Astra in the same thread (it keeps its context): a correction, an answer to its question, or a request for more work. ' +
      'Only valid when the run is not currently running. Follow with astra_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        message: { type: 'string', description: 'The follow-up for Astra.' },
        sandbox: { type: 'string', enum: SANDBOXES, description: 'Change the sandbox for this follow-up. Defaults to the one the run started with.' },
      },
      required: ['run_id', 'message'],
    },
    async run({ run_id, message, sandbox }) {
      const meta = readMeta(run_id);
      if (live.has(run_id)) throw new Error('Astra is still working on this run. Wait for it with astra_wait, or stop it with astra_cancel.');
      if (!message?.trim()) throw new Error('message is empty.');
      if (sandbox && !SANDBOXES.includes(sandbox)) throw new Error(`sandbox must be one of: ${SANDBOXES.join(', ')}.`);
      const thread = threadId(readEvents(run_id));
      if (!thread) throw new Error('This run never started a Codex thread, so there is nothing to reply to. Start a new run with astra_start.');
      const sb = sandbox || meta.sandbox;
      if (sandbox) writeMeta(run_id, { sandbox });
      if (meta.codex_home) ensureCodexHome(); // the thread lives in the home the run started with
      startSegment(run_id, 'reply', codexArgs({ resumeThread: thread, model: meta.model, effort: meta.effort, sandbox: sb }), message);
      return `run_id: ${run_id}\nstatus: running (follow-up sent, sandbox: ${sb})\nnext: call astra_wait.`;
    },
  },

  astra_trace: {
    description:
      'Read the trace of an Astra run as a numbered digest, for checking a claim or answering a user question about what Astra did. ' +
      'Set full=true for longer command output and messages. The raw JSONL path is included for anything the digest cuts.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        from_seq: { type: 'number', description: 'First sequence number to include. Default 1.' },
        to_seq: { type: 'number', description: 'Last sequence number to include. Default: the end.' },
        full: { type: 'boolean', description: 'Longer excerpts per event. Default false.' },
      },
      required: ['run_id'],
    },
    async run({ run_id, from_seq = 1, to_seq = Infinity, full = false }) {
      const { meta, status } = statusOf(run_id);
      const events = readEvents(run_id).filter((e) => e.seq >= from_seq && e.seq <= to_seq);
      return `run_id: ${run_id}\nstatus: ${status}\nraw trace: ${eventsPath(run_id)}\n\n${digest(events, full, meta.cwd) || '(no events in that range)'}`;
    },
  },

  astra_cancel: {
    description: 'Stop a running Astra run. The trace so far is kept.',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
    async run({ run_id }) {
      readMeta(run_id);
      const entry = live.get(run_id);
      if (!entry) return `run_id: ${run_id}\nNothing to cancel: status is ${statusOf(run_id).status}.`;
      entry.child.kill('SIGTERM');
      await entry.done;
      return `run_id: ${run_id}\nstatus: cancelled. The trace so far is at ${eventsPath(run_id)}.`;
    },
  },
};

// ---------- MCP plumbing ----------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'astra', version: '0.1.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const tool = tools[params?.name];
      if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        const text = await tool.run(params.arguments || {});
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    }
    default:
      if (id !== undefined) fail(-32601, `Method not found: ${method}`);
  }
}

const pending = new Set();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const p = handle(msg).catch((e) => process.stderr.write(`astra-mcp: ${e.stack || e}\n`));
  pending.add(p);
  p.finally(() => pending.delete(p));
});
rl.on('close', async () => {
  await Promise.allSettled([...pending]);
  for (const { child } of live.values()) child.kill('SIGTERM');
  process.exit(0);
});
