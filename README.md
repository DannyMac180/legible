# Legible

A prototype of one idea: GPT-6.2 Astra methodically drives to the solution, and Opus 5.5 translates Astra's work in a way that takes human attention into account.

Claude Code is the harness. Opus 5.5 is the main loop and owns the conversation. Astra runs behind an MCP server and does the work. Opus reads Astra's raw event trace, not just its summary, so its reports can be checked against what actually happened.

```
you ⇄ Opus 5.5 (Claude Code) ── brief ──▶ astra MCP server ──▶ codex exec --json ──▶ GPT-6.2 Astra
            ▲                                    │
            └──── numbered trace digest ◀── .fusion/runs/<run_id>/events.jsonl
```

## Setup

You need Node 18+, Claude Code, and the Codex CLI signed in to an account with access to `gpt-6.2-astra`.

The Codex CLI must be new enough to know `gpt-6.2-astra`: 0.155.1 rejects it ("not supported when using Codex with a ChatGPT account"), 0.169.0 accepts it. If the `codex` on your PATH is older, either upgrade it or point the server at a newer binary by adding `CODEX_BIN` to the `env` block in `.mcp.json`. The ChatGPT desktop app bundles one at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`.

```bash
npm i -g @openai/codex
```

```bash
codex login
```

```bash
npm test
```

Then start Claude Code in this folder and approve the `astra` MCP server when asked:

```bash
claude
```

Give it any task, coding or otherwise. `CLAUDE.md` holds the protocol Opus follows: brief, delegate, watch, verify, report.

To work on another repository, tell Opus its path; it passes that as `cwd` to Astra.

## What is here

| Path | What it is |
|---|---|
| `CLAUDE.md` | The fusion protocol: roles, the brief template, when to interrupt, how to verify, how to report. This is the part to iterate on. |
| `server/astra-mcp.mjs` | Zero-dependency MCP server wrapping `codex exec --json`. |
| `.mcp.json` | Registers the server with Claude Code. Model and reasoning effort are set here. |
| `.claude/settings.json` | Pins the main loop to Opus 5.5 and pre-approves the `astra` tools. |
| `test/` | Smoke test that drives the server with a fake Codex CLI. |
| `.fusion/runs/` | One folder per run: raw `events.jsonl`, `stderr.log`, `meta.json`. Not committed. |

## Tools

| Tool | What it does |
|---|---|
| `astra_start` | Hands Astra a brief and returns a `run_id` at once. Sandbox is `read-only` unless the task needs file edits. |
| `astra_wait` | Blocks until the run ends or a timeout passes, then returns the new trace events and, when finished, Astra's final message. |
| `astra_reply` | Sends a follow-up into the same Astra thread. |
| `astra_trace` | Returns any range of the trace as a numbered digest. |
| `astra_cancel` | Stops a run and keeps the trace. |

Every trace event carries a sequence number, its line number in `events.jsonl`. Opus cites these as `[seq]` in its reports, so any statement can be traced to the raw event.

## Why a custom MCP server

Codex CLI removed its built-in `codex mcp-server` in 0.154.0 (September 2026). Wrapping `codex exec --json` replaces it and puts the full event stream on disk, which is what Opus needs in order to check Astra's account of its own work.

## Testing the idea

The question is whether the fusion's reports are better than Astra's own. A simple first pass:

1. Pick five to ten real tasks, mixing code changes with research or analysis.
2. Run each one twice: Astra alone (`codex exec`), and through this project.
3. For each report, time how long it takes you to correctly answer: what happened, what do I need to do, and what is still unverified?
4. Check each report against the trace for statements the trace does not support.

Faster correct answers with no unsupported statements means the split is earning its cost.

## What has been checked against the real CLI

Checked on 2026-11-18 with codex-cli 0.169.0-alpha.11.1 (the ChatGPT.app bundle) and `gpt-6.2-astra`, by driving the server over stdio:

- A read-only run and a workspace-write run, each with follow-ups through `astra_reply`, complete end to end.
- The sandbox and reasoning effort passed with `-c` take effect on every turn, including `exec resume`, even though the user config defaulted to `danger-full-access`. Read-only blocked writes in the working directory; workspace-write allowed them there and blocked a write to the home directory; a follow-up switched to read-only was blocked again. Checked both on disk and in the `permission_profile` Codex records for each turn in `~/.codex/sessions`.
- The digest matches the live shapes for `agent_message`, `command_execution`, `file_change`, `web_search`, `error` items, `turn.completed` and `turn.failed`. The fake Codex in `test/` now emits those captured shapes.
- A full 240-second `astra_wait` returns normally through Claude Code's own MCP client (checked with `gpt-6-astra` on codex-cli 0.155.1, which is what `codex` resolved to in that session).

Not seen from the real CLI, so their digest lines are still guesses: `reasoning`, `todo_list`, `mcp_tool_call`. Astra wrote its plan as an ordinary message and no reasoning items were emitted at effort high.

## Known gaps

- **The event stream is not complete.** A command the sandbox blocks never appears in `codex exec --json`; it shows up only in Astra's own account and in the session file under `~/.codex/sessions`. Ordinary failing commands (non-zero exit) do appear. So "Astra tried X and was blocked" cannot be confirmed from the trace. `astra_wait` says so in its closing note.
- **Astra inherits the whole user Codex config.** Every MCP server and plugin in `~/.codex/config.toml` is loaded for it, and MCP tools run outside the sandbox. A read-only run may therefore still be able to call a mail or issue-tracker tool if one is configured (not tested). Something Codex starts, most likely one of those servers, wrote a multi-megabyte `logs/` folder into the working directory of every run, read-only included; it will appear in any repository Astra works in. It also costs context: a one-line task used about 30,000 input tokens per model call.
- workspace-write also allows writes to `/tmp` and `$TMPDIR`, not only the working directory.

- Opus sees progress only when `astra_wait` returns, so mid-run narration is in steps of up to the wait timeout.
- A follow-up can only be sent between Astra turns, not while it is working.
- Codex runs with no approval prompts in non-interactive mode; the sandbox setting is the only guard on what Astra can change.
