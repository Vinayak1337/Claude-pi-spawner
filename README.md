# Claude-pi-spawner

Lets Claude Code (desktop app or terminal) spawn **pi subagents** that run on a **pool of ChatGPT/Codex accounts**. When one account hits its limit, the pool moves to the next one on its own. The limited account waits until its exact reset time and then rejoins.

```
Claude Code
  ├─ codex_subagent tool   blocking; several calls in one message run in parallel
  ├─ codex-subagent        same run as a command; Claude starts it in the background and is woken with the answer
  └─ /codex-accounts, /codex-subagent
          │
          ▼   pi -p --provider codex-pool --model <model> --thinking <effort> …
pi + codex-accounts extension
  └─ codex-pool → codex-1 … codex-N   (one ChatGPT sign-in each)
```

The repo has two parts:

| Part | Folder | What it is |
|---|---|---|
| Account pool | [`pi/codex-accounts`](pi/codex-accounts) | A [pi](https://github.com/badlogic/pi-mono) extension that adds the `codex-pool` provider and the account slots `codex-1…N` |
| Claude mod | [`claude/pi-subagents`](claude/pi-subagents) | A Claude Code mod (hooks plugin) that adds the `codex_subagent` tool, `/codex-accounts`, `/codex-subagent` and the `codex-subagent` command |

[docs/architecture.md](docs/architecture.md) explains how each piece works and where it is in the code.

## Requirements

- macOS or Linux, with [Node.js](https://nodejs.org) 20 or newer.
- **pi**: `bun i -g @earendil-works/pi-coding-agent` (or `npm i -g …`). Tested with pi 1.0.4.
- **Claude Code** with mods (hooks-module plugins) available, either the desktop app's Code tab or the `claude` CLI. Mods are an early-access feature: if your account doesn't have them, the tool won't appear in Claude, but the pi pool still works in pi.
- One or more ChatGPT accounts with Codex access (Plus, Pro, …).

## Install

```bash
git clone https://github.com/Vinayak1337/Claude-pi-spawner.git ~/Claude-pi-spawner
```

```bash
~/Claude-pi-spawner/install.sh
```

`install.sh` does three things, and running it again is safe:

1. Links `pi/codex-accounts` into `~/.pi/agent/extensions/codex-accounts`.
2. Links `claude/pi-subagents/bin/codex-subagent.mjs` to `~/.local/bin/codex-subagent`.
3. Adds `claude/pi-subagents` to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. That is how the **desktop app** loads a mod from a folder. It removes any other `pi-subagents` folder already listed there, so only one copy loads, and saves a backup at `settings.json.bak-claude-pi-spawner`.

Everything is a link to this checkout, so `git pull` updates it. Restart pi (or `/reload`) and start a new Claude session to pick up changes.

### Sign in your accounts (once)

```bash
pi
```

Inside pi:

```
/login codex-1      ← sign in the first ChatGPT account in the browser
/login codex-2      ← the second, and so on
/codex-accounts     ← check: each account's email, plan, usage and reset times
```

- Use a **private browser window** for each account, or sign out of ChatGPT between them. Otherwise the browser signs you straight back into the previous account.
- There are 5 slots by default; `/codex-accounts slots 8` adds more (then restart pi).
- Give pi its **own** sign-in for each account. Don't copy `auth.json` from the Codex app or other tools: two programs refreshing one shared sign-in can get it revoked.

### Load it in the Claude desktop app

Quit and reopen the Claude app, or start a new Code session. In the new session:

- `/codex-accounts` should list your pool.
- Ask: *"use a codex subagent to review src/ for unused exports"*.

## Using it from Claude

**Blocking subagent (short tasks).** Claude calls `codex_subagent` and waits for the answer. Several calls in one message run in parallel.

| Input | Meaning |
|---|---|
| `task` | Complete, self-contained instructions. The subagent can't see your chat. |
| `cwd` | Folder to work in (default: the session's folder) |
| `access` | `read-only` (default: read/grep/find/ls) or `edit` (also bash/edit/write, **no sandbox**) |
| `model`, `thinking` | Override the saved defaults for this one task |
| `session_id` | Continue an earlier subagent |
| `timeout_minutes` | Default 30, max 120 |

**Background subagents (long tasks).** Ask, for example, *"run 3 codex subagents in the background on X, Y and Z and tell me when they're done."* Claude runs:

```
codex-subagent [--model M] [--effort E] [--access edit] [--cwd DIR] [--session ID] [--timeout MIN] --task-file task.md
```

It runs this as a background Bash job, so each subagent shows in the task list and can be stopped. Whoever started it (Claude, or one of Claude's own subagents) is woken with the answer. Every answer ends with a footer like `[pi subagent · gpt-6-luna · medium · read-only · account codex-2 (…) · 3.1 min · session …]`.

**Slash commands in Claude**

| Command | Does |
|---|---|
| `/codex-subagent` | Shows the default model and effort |
| `/codex-subagent gpt-6.1-sol high` | Saves both; either part alone works (`/codex-subagent xhigh`) |
| `/codex-subagent reset` | Back to `gpt-6-luna` at `medium` |
| `/codex-accounts` | Accounts, usage, reset times, banked resets |
| `/codex-accounts refresh` | Reads usage from ChatGPT now |
| `/codex-accounts resets` | Banked resets per account, with expiry dates |
| `/codex-accounts reset codex-N` | Shows what would be spent; add `confirm` to spend it |
| `/codex-accounts cutoff <percent>` | Switch accounts at this % remaining (default 1) |
| `/codex-accounts slots <n>` | Number of account slots (1–20) |

The same `/codex-accounts …` commands work inside pi, where `reset` asks in a dialog. Efforts are `off`, `minimal`, `low`, `medium`, `high` and `xhigh`.

## Using the pool directly in pi

```bash
pi --provider codex-pool --model gpt-6-luna
```

Or pick a `codex-pool/…` model with `/model`.

## How switching works

- Each request goes to the first ready account. Accounts switch at 1% remaining, before a limit error, using the usage headers on every response.
- A limited account is paused until its **exact** reset time. That time comes from the limit error, the response headers or ChatGPT's usage endpoint. The same request then goes to the next account. Nothing switches once output has started streaming, so nothing is duplicated.
- After the reset, a quick usage check confirms the account before it's used again. If the 5-hour window reset but the weekly one is still full, the account stays paused until the weekly reset.
- If one account's plan doesn't include a model, the request is tried on the others. Brief 429/5xx errors are retried up to 3 times per account.
- When every account is limited, the error names the account that resets first and when.
- Banked resets ("Full reset (Weekly + 5 hr)") are shown but **never spent automatically**.

## Files it keeps

| Path | Contents |
|---|---|
| `~/.pi/agent/auth.json` | pi's sign-ins, including `codex-1…N` (managed by pi) |
| `~/.pi/agent/codex-accounts.json` | Pool state: usage, reset times, banked resets, cutoff, slots |
| `~/.pi/agent/claude-subagents/` | Subagent sessions, plus `defaults.json` (saved model and effort) |

These are local files that don't depend on the Claude account you're signed in with, so they stay when you switch Claude accounts.

## Tests

```bash
npm test
```

The 16 end-to-end tests run the real `pi` (print and RPC modes) and the `codex-subagent` command against a local fake ChatGPT backend. They never touch your `~/.pi` or your real accounts.

Validate the mod with:

```bash
claude plugin validate claude/pi-subagents
```

## Troubleshooting

- **The tool or commands don't appear in Claude:** start a new session after installing. Then check that `~/.claude/settings.json` has `env.CLAUDE_CODE_PLUGIN_DIRS` pointing at `claude/pi-subagents`, and run `claude --debug` for the load error. If mods aren't enabled for your account, nothing loads.
- **`pi was not found`:** install pi, or set `PI_SUBAGENT_BIN` to its path.
- **`codex-subagent: command not found`:** add `~/.local/bin` to your PATH.
- **"usage unknown" in `/codex-accounts`:** run `/codex-accounts refresh`.
- **An account keeps failing to sign in:** run `/login codex-N` again in pi.

## Uninstall

```bash
~/Claude-pi-spawner/install.sh --uninstall
```

This removes the two links and the settings entry. Your pi sign-ins and pool state in `~/.pi/agent` stay; delete them yourself if you want them gone.

## Origin

This was split out of [Vinayak1337/account-router](https://github.com/Vinayak1337/account-router) (branch `fix/codex-compat-macos`), where it was first built next to the HTTP account router. This repo needs only pi, not the router.

## License

MIT
