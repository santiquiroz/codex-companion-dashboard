# codex-companion-dashboard

Terminal and web dashboard for [Codex Companion](https://github.com/openai/codex) background jobs in [Claude Code](https://claude.com/claude-code) — see and manage every job across **all your repos and sessions** at once, with zero LLM tokens spent.

## Why

Codex Companion (the Claude Code plugin that delegates coding tasks to the Codex CLI in the background) tracks each job's status in a small JSON file per repository. If you delegate to Codex from several projects or several Claude Code sessions at once, there's no built-in way to see everything in one place — you'd have to ask Claude to check status in each session, which costs tokens just to answer "is it still running?"

This tool reads those state files directly from disk. No API calls, no LLM involved — just local file reads, so it's free to run as often as you want.

## What's included

- **`codex-dashboard`** — a read-only terminal table. Good for a quick glance or leaving open with `--watch`.
- **`codex-dashboard-gui`** — a local web UI (binds to `127.0.0.1` only) to view jobs across every repo, filter by repo name, and clean up stuck/orphaned jobs (cancel or delete) without hunting through JSON files by hand.

## Install

```bash
npx codex-companion-dashboard
# or
npm install -g codex-companion-dashboard
```

Requires Node.js 18+. No other dependencies.

## Usage

```bash
codex-dashboard              # print the table once and exit
codex-dashboard --watch      # refresh every 3 seconds, Ctrl+C to stop
codex-dashboard --json       # machine-readable output, for scripting

codex-dashboard-gui          # start the web UI at http://127.0.0.1:4317
codex-dashboard-gui --port 5000
codex-dashboard-gui --port 0 --no-open   # any free port, don't open the browser
```

The GUI lets you:
- See every job (running, queued, completed, failed, cancelled) across every repo, auto-refreshing.
- Spot **stale** jobs — entries stuck as "running"/"queued" whose process has actually died (session closed, machine slept, etc.) — flagged automatically by checking whether the recorded PID is still alive.
- Cancel a job (best-effort process kill + marks it cancelled) or bulk-purge every stale one.
- Delete old finished job entries you don't need to keep around.

## How it finds jobs

Codex Companion stores per-repo job state under one of:

```
~/.claude/plugins/data/codex-openai-codex/state/<repo-slug>-<hash>/state.json
<os-tmpdir>/codex-companion/<repo-slug>-<hash>/state.json
```

Both locations are checked automatically. If your install uses a different path, set `CODEX_COMPANION_STATE_DIR` to override.

## License

MIT
