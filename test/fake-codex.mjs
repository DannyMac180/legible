#!/usr/bin/env node
// Stand-in for the Codex CLI in tests. Emits the same JSONL event shapes as
// `codex exec --json`, with no network access.
const args = process.argv.slice(2);
const resume = args[1] === 'resume';
const cdAt = args.indexOf('-C');
if (cdAt !== -1) process.chdir(args[cdAt + 1]);
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (prompt.includes('FAIL')) {
    // Captured from codex-cli 0.155 rejecting a model it does not know.
    const message = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported.","code":"model_not_found"}}';
    emit({ type: 'thread.started', thread_id: 'thread-fail' });
    emit({ type: 'turn.started' });
    emit({ type: 'error', message });
    emit({ type: 'turn.failed', error: { message } });
    process.exit(1);
  }
  if (prompt.includes('WHICH HOME')) {
    emit({ type: 'thread.started', thread_id: 'thread-home' });
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `home=${process.env.CODEX_HOME}` } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  }
  if (prompt.includes('HANG')) { emit({ type: 'thread.started', thread_id: 'thread-hang' }); await sleep(60000); return; }
  // Shapes below were captured from codex-cli 0.169 with gpt-6.2-astra.
  // The real CLI emits thread.started on resume too, with the same thread id.
  emit({ type: 'thread.started', thread_id: 'thread-123' });
  const notice = 'Under-development features enabled: chronicle. Under-development features are incomplete and may behave unpredictably.';
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: notice } });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'error', message: notice } });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'I will run the tests first.' } });
  await sleep(150);
  emit({ type: 'item.started', item: { id: 'item_3', type: 'command_execution', command: "/bin/zsh -lc 'npm test'", aggregated_output: '', exit_code: null, status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: "/bin/zsh -lc 'npm test'", aggregated_output: '3 passing\n1 failing\n', exit_code: 1, status: 'failed' } });
  emit({ type: 'item.started', item: { id: 'item_4', type: 'web_search', id: 'exec-1', query: '', action: { type: 'other' } } });
  emit({ type: 'item.completed', item: { id: 'item_4', type: 'web_search', id: 'exec-1', query: 'node lts', action: { type: 'search', query: 'node lts' }, results: [{ type: 'text_result', domain: 'nodejs.org', ref_id: 'turn0search0', snippet: 's', title: 'Node.js', url: 'https://nodejs.org/en/download/' }] } });
  emit({ type: 'item.started', item: { id: 'item_5', type: 'file_change', changes: [{ path: `${process.cwd()}/src/a.js`, kind: 'update' }, { path: `${process.cwd()}/notes.md`, kind: 'add' }], status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'item_5', type: 'file_change', changes: [{ path: `${process.cwd()}/src/a.js`, kind: 'update' }, { path: `${process.cwd()}/notes.md`, kind: 'add' }], status: 'completed' } });
  await sleep(150);
  emit({ type: 'item.completed', item: { id: 'item_6', type: 'agent_message', text: resume ? `Follow-up handled: ${prompt.trim()}` : `Done with: ${prompt.trim()}` } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } });
});
