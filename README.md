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

## Known gaps

- Opus sees progress only when `astra_wait` returns, so mid-run narration is in steps of up to the wait timeout.
- A follow-up can only be sent between Astra turns, not while it is working.
- Codex runs with no approval prompts in non-interactive mode; the sandbox setting is the only guard on what Astra can change.
