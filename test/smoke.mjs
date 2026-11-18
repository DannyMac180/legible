// End-to-end smoke test: drives the MCP server over stdio with a fake Codex CLI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-smoke-'));
const fake = path.join(here, 'fake-codex.mjs');
fs.chmodSync(fake, 0o755);

function startServer(codexBin) {
  const server = spawn('node', [path.join(here, '../server/astra-mcp.mjs')], {
    env: { ...process.env, CODEX_BIN: codexBin, FUSION_RUNS_DIR: path.join(tmp, 'runs') },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = new Map();
  readline.createInterface({ input: server.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result;
    return { text: r.content[0].text, isError: !!r.isError };
  };
  return { server, rpc, call };
}

const { server, rpc, call } = startServer(fake);

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
assert.equal(init.result.serverInfo.name, 'astra');
const list = await rpc('tools/list');
assert.deepEqual(list.result.tools.map((t) => t.name), ['astra_start', 'astra_wait', 'astra_reply', 'astra_trace', 'astra_cancel']);

// start → wait → final message, with cited sequence numbers
const started = await call('astra_start', { brief: 'fix the failing test', cwd: tmp });
const runId = started.text.match(/run_id: (\S+)/)[1];
const waited = await call('astra_wait', { run_id: runId, timeout_s: 10 });
assert.match(waited.text, /status: completed \(exit 0\)/);
assert.match(waited.text, /\[1\] ── brief sent to Astra: fix the failing test/);
assert.match(waited.text, /ran `npm test` → exit 1/);
assert.match(waited.text, /file changes \(completed\): update src\/a\.js/);
assert.match(waited.text, /Astra's final message \[\d+\] ---\nDone with: fix the failing test/);

// a second wait returns only new events (none)
const again = await call('astra_wait', { run_id: runId });
assert.match(again.text, /--- new trace events ---\n\(none\)/);

// reply resumes the same thread and appends to the same trace
const replied = await call('astra_reply', { run_id: runId, message: 'also update the docs' });
assert.equal(replied.isError, false);
const waited2 = await call('astra_wait', { run_id: runId, timeout_s: 10 });
assert.match(waited2.text, /follow-up sent to Astra: also update the docs/);
assert.match(waited2.text, /Follow-up handled: also update the docs/);
assert.doesNotMatch(waited2.text, /Done with: fix the failing test/);

// trace range
const trace = await call('astra_trace', { run_id: runId, from_seq: 1, to_seq: 2 });
assert.match(trace.text, /thread started \(thread-123\)/);
assert.doesNotMatch(trace.text, /npm test/);

// a wait that times out reports running; cancel stops it; reply while running is refused
const hang = await call('astra_start', { brief: 'HANG', cwd: tmp });
const hangId = hang.text.match(/run_id: (\S+)/)[1];
const running = await call('astra_wait', { run_id: hangId, timeout_s: 1 });
assert.match(running.text, /status: running/);
const refused = await call('astra_reply', { run_id: hangId, message: 'hello' });
assert.equal(refused.isError, true);
const cancelled = await call('astra_cancel', { run_id: hangId });
assert.match(cancelled.text, /status: cancelled/);

// errors are reported, not thrown
assert.equal((await call('astra_wait', { run_id: 'nope' })).isError, true);
assert.equal((await call('astra_start', { brief: 'x', sandbox: 'danger-full-access' })).isError, true);
server.stdin.end();

// a missing Codex CLI gives an actionable message
const missing = startServer('/nonexistent/codex');
await missing.rpc('initialize', {});
const s = await missing.call('astra_start', { brief: 'x', cwd: tmp });
const w = await missing.call('astra_wait', { run_id: s.text.match(/run_id: (\S+)/)[1], timeout_s: 5 });
assert.match(w.text, /status: failed/);
assert.match(w.text, /npm i -g @openai\/codex/);
missing.server.stdin.end();

fs.rmSync(tmp, { recursive: true, force: true });
console.log('smoke test passed');
