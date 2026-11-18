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

// a stand-in for the user's personal Codex home, holding only a login file
const personal = path.join(tmp, 'personal-codex');
fs.mkdirSync(personal);
fs.writeFileSync(path.join(personal, 'auth.json'), '{}');
const fusionHome = path.join(tmp, 'codex-home');

function startServer(codexBin, extraEnv = {}) {
  const server = spawn('node', [path.join(here, '../server/astra-mcp.mjs')], {
    env: { ...process.env, CODEX_BIN: codexBin, FUSION_RUNS_DIR: path.join(tmp, 'runs'), CODEX_HOME: personal, FUSION_CODEX_HOME: fusionHome, ...extraEnv },
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
// Astra gets its own Codex home: fusion-only config, login linked from the personal home
assert.match(started.text, /codex home: .*codex-home \(fusion-only config/);
assert.match(fs.readFileSync(path.join(fusionHome, 'config.toml'), 'utf8'), /apps = false/);
assert.equal(fs.readlinkSync(path.join(fusionHome, 'auth.json')), path.join(personal, 'auth.json'));
const homeRun = await call('astra_start', { brief: 'WHICH HOME', cwd: tmp });
const homeWait = await call('astra_wait', { run_id: homeRun.text.match(/run_id: (\S+)/)[1], timeout_s: 10 });
assert.ok(homeWait.text.includes(`home=${fusionHome}`));
// an edited config is left alone
fs.appendFileSync(path.join(fusionHome, 'config.toml'), '# mine\n');
const runId = started.text.match(/run_id: (\S+)/)[1];
const waited = await call('astra_wait', { run_id: runId, timeout_s: 10 });
assert.match(waited.text, /status: completed \(exit 0\)/);
assert.match(waited.text, /\[1\] ── brief sent to Astra: fix the failing test/);
// the shell wrapper is stripped, paths are relative to cwd
assert.match(waited.text, /ran `npm test` → exit 1\n      3 passing/);
assert.match(waited.text, /file changes \(completed\): update src\/a\.js, add notes\.md/);
// startup warnings read as notices, not errors, and repeats collapse
assert.equal(waited.text.match(/Codex notice: Under-development features/g).length, 1);
assert.doesNotMatch(waited.text, /\] error:/);
// web search shows the query and result URLs
assert.match(waited.text, /web search: node lts → 1 results\n      https:\/\/nodejs\.org\/en\/download\//);
// commentary before the final message is kept, but is not the final message
assert.match(waited.text, /Astra said: I will run the tests first\./);
assert.match(waited.text, /thread total so far: 10 input tokens \(4 cached\), 5 output/);
assert.match(waited.text, /commands the sandbox blocked do not appear/);
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

// a turn the API rejects: failed status, the reason in the digest, no final message
const bad = await call('astra_start', { brief: 'FAIL', cwd: tmp });
const badWait = await call('astra_wait', { run_id: bad.text.match(/run_id: (\S+)/)[1], timeout_s: 10 });
assert.match(badWait.text, /status: failed \(exit 1\)/);
assert.match(badWait.text, /\] error: .*model_not_found/);
assert.match(badWait.text, /TURN FAILED: .*model_not_found/);
assert.match(badWait.text, /Astra produced no final message/);

assert.match(fs.readFileSync(path.join(fusionHome, 'config.toml'), 'utf8'), /# mine/);

// errors are reported, not thrown
assert.equal((await call('astra_wait', { run_id: 'nope' })).isError, true);
assert.equal((await call('astra_start', { brief: 'x', sandbox: 'danger-full-access' })).isError, true);
server.stdin.end();

// if the login link has become a regular file, astra_start warns
const copiedHome = path.join(tmp, 'codex-home-copied');
fs.mkdirSync(copiedHome);
fs.writeFileSync(path.join(copiedHome, 'auth.json'), '{}');
const copied = startServer(fake, { FUSION_CODEX_HOME: copiedHome });
await copied.rpc('initialize', {});
const cw = await copied.call('astra_start', { brief: 'WHICH HOME', cwd: tmp });
assert.match(cw.text, /warning: .*auth\.json is a regular file/);
await copied.call('astra_wait', { run_id: cw.text.match(/run_id: (\S+)/)[1], timeout_s: 10 });
copied.server.stdin.end();

// FUSION_CODEX_HOME=inherit leaves Codex on the personal home
const inherit = startServer(fake, { FUSION_CODEX_HOME: 'inherit' });
await inherit.rpc('initialize', {});
const ih = await inherit.call('astra_start', { brief: 'WHICH HOME', cwd: tmp });
assert.match(ih.text, /personal config/);
const iw = await inherit.call('astra_wait', { run_id: ih.text.match(/run_id: (\S+)/)[1], timeout_s: 10 });
assert.ok(iw.text.includes(`home=${personal}`));
inherit.server.stdin.end();

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
