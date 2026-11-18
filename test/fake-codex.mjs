#!/usr/bin/env node
// Stand-in for the Codex CLI in tests. Emits the same JSONL event shapes as
// `codex exec --json`, with no network access.
const args = process.argv.slice(2);
const resume = args[1] === 'resume';
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (prompt.includes('HANG')) { emit({ type: 'thread.started', thread_id: 'thread-hang' }); await sleep(60000); return; }
  if (!resume) emit({ type: 'thread.started', thread_id: 'thread-123' });
  emit({ type: 'turn.started' });
  await sleep(150);
  emit({ type: 'item.started', item: { id: 'i0', type: 'command_execution', command: 'npm test', status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'npm test', aggregated_output: '3 passing\n1 failing', exit_code: 1, status: 'failed' } });
  emit({ type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: 'src/a.js', kind: 'update' }], status: 'completed' } });
  await sleep(150);
  emit({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: resume ? `Follow-up handled: ${prompt.trim()}` : `Done with: ${prompt.trim()}` } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
});
