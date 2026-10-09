# Architecture and code map

How a Claude request becomes a pi run on one of your ChatGPT accounts, and where each step is in the code.

```
Claude ──codex_subagent tool──▶ register.ts ──$.process.spawn──▶ pi -p --provider codex-pool …
Claude ──Bash (background)────▶ codex-subagent.mjs ──spawn──────▶ pi -p --provider codex-pool …
                                                                     │
                                                    codex-accounts extension (index.ts)
                                                    streamPool → candidates → codex-N
                                                                     │
                                                    chatgpt.com Codex backend (per-account sign-in)
```

## 1. Claude mod: `claude/pi-subagents/`

A Claude Code *mod*, meaning a plugin whose hooks are a TypeScript module. The engine loads it from a folder named in `CLAUDE_CODE_PLUGIN_DIRS` (see [install.sh](../install.sh)). Because the plugin is named `pi-subagents`, the tool appears to the model as `mcp__pi-subagents__codex_subagent`.

| File | Role |
|---|---|
| [.claude-plugin/plugin.json](../claude/pi-subagents/.claude-plugin/plugin.json) | Manifest |
| [hooks/hooks.json](../claude/pi-subagents/hooks/hooks.json) | Names the hooks module |
| [hooks/register.ts](../claude/pi-subagents/hooks/register.ts) | The mod |
| [bin/codex-subagent.mjs](../claude/pi-subagents/bin/codex-subagent.mjs) | The background command (plain Node, no dependencies) |
| [tsconfig.json](../claude/pi-subagents/tsconfig.json) | For type-checking. It extends `.claude-plugin/types/`, which the engine generates once the mod has loaded (git-ignored). |

### register.ts

- [L5-L8](../claude/pi-subagents/hooks/register.ts#L5): the tool name `codex_subagent`, default model `gpt-6-luna`, and the read-only tool set `read,grep,find,ls`.
- [L20-L34](../claude/pi-subagents/hooks/register.ts#L20): saved defaults (model and effort) in `~/.pi/agent/claude-subagents/defaults.json`. They're stored with pi, not Claude, so they survive switching Claude accounts.
- [L37-L45](../claude/pi-subagents/hooks/register.ts#L37): `poolModels` asks `pi --list-models codex-pool`, so `/codex-subagent` can check model names.
- [L47-L58](../claude/pi-subagents/hooks/register.ts#L47): `findPi` looks in `PI_SUBAGENT_BIN`, `~/.bun/bin/pi`, `/opt/homebrew/bin/pi` and `/usr/local/bin/pi`.
- [L62-L71](../claude/pi-subagents/hooks/register.ts#L62): `runPoolCommand` runs the extension's `/codex-accounts …` through `pi -p`, where the extension prints its answer.
- [L74-L104](../claude/pi-subagents/hooks/register.ts#L74): `registerTool` is the `$.tool.register` call. The description ([L83-L85](../claude/pi-subagents/hooks/register.ts#L83)) tells Claude to use the background `codex-subagent` command for long work. The schema shows the current saved defaults, so it's registered again whenever they change.
- [L107-L121](../claude/pi-subagents/hooks/register.ts#L107): on `session.start`, registers `/codex-accounts`, the tool and `/codex-subagent`.
- [L123-L139](../claude/pi-subagents/hooks/register.ts#L123): `/codex-accounts`. Spending a banked reset takes two steps: `reset codex-N` runs `--dry-run`, then `reset codex-N confirm` runs `--yes`.
- [L141-L168](../claude/pi-subagents/hooks/register.ts#L141): `/codex-subagent` shows, saves or resets the defaults.
- [L170-L256](../claude/pi-subagents/hooks/register.ts#L170): the spawn itself, a `tool.call` hook:
  - [L190-L199](../claude/pi-subagents/hooks/register.ts#L190): argv `pi -p --provider codex-pool --model … --thinking … --session-dir ~/.pi/agent/claude-subagents --session-id … [--tools read,grep,find,ls]`
  - [L220](../claude/pi-subagents/hooks/register.ts#L220): `$.process.spawn`. The task goes in on **stdin**, so text starting with `@` or `-` is never read as a flag or a file.
  - [L212-L235](../claude/pi-subagents/hooks/register.ts#L212): a running-count status line and the timeout
  - [L238-L243](../claude/pi-subagents/hooks/register.ts#L238): which account served the run, found by comparing `lastUsedAt` in `codex-accounts.json` before and after, plus the footer

### bin/codex-subagent.mjs

The same run as a command, for Claude's background Bash jobs. Each job is a task Claude can list and stop, and it wakes the agent that started it when it exits.

- [L43-L60](../claude/pi-subagents/bin/codex-subagent.mjs#L43): options. The task comes from `--task-file`, the arguments, or stdin.
- [L62-L71](../claude/pi-subagents/bin/codex-subagent.mjs#L62): saved defaults and checks. The timeout can be up to 240 minutes.
- [L94-L105](../claude/pi-subagents/bin/codex-subagent.mjs#L94): the same pi argv as the tool
- [L111-L118](../claude/pi-subagents/bin/codex-subagent.mjs#L111): stopping: on timeout or SIGTERM/SIGINT/SIGHUP it sends SIGTERM, then SIGKILL after 5 seconds
- [L120-L139](../claude/pi-subagents/bin/codex-subagent.mjs#L120): prints the answer and footer. Exit codes: 0 done, 124 stopped or timed out, anything else means pi failed.

## 2. pi extension: `pi/codex-accounts/`

[index.ts](../pi/codex-accounts/index.ts) is loaded by pi from `~/.pi/agent/extensions/codex-accounts`. pi itself is not modified: the extension reuses pi's built-in `openai-codex` provider (its ChatGPT sign-in, model catalog and endpoint).

- [L1-L16](../pi/codex-accounts/index.ts#L1): overview.
- [L43](../pi/codex-accounts/index.ts#L43): `QUOTA_CODES`, the error codes that mean "this account can't serve this" (`usage_limit_reached`, `usage_not_included`, `insufficient_quota`).
- [L78-L114](../pi/codex-accounts/index.ts#L78): the persistent store `~/.pi/agent/codex-accounts.json`.
- [L149](../pi/codex-accounts/index.ts#L149): `observeHeaders` reads the percent used and reset time of each window from every response (`x-codex-primary-*`, `x-codex-secondary-*`).
- [L176-L209](../pi/codex-accounts/index.ts#L176): `limitResetMs`, `block`, `atCutoff` and `readyAt` decide when an account is paused, and until when.
- [L211-L283](../pi/codex-accounts/index.ts#L211): backend calls, including `readBanked` (`wham/rate-limit-reset-credits`) and `readUsage` (`wham/usage`).
- [L313](../pi/codex-accounts/index.ts#L313): `candidates` picks the next ready account. An account whose reset has passed gets a usage check first.
- [L396](../pi/codex-accounts/index.ts#L396): **`streamPool`**, the switching core. For each candidate account it makes up to 3 attempts (retrying 429/5xx), watching status, headers and the error body, and moves to the next account on a quota or plan error. It only switches before any output has streamed.
- [L535-L704](../pi/codex-accounts/index.ts#L535): `report`, `listBanked` and `spendBanked`, which produce the text and dialogs behind `/codex-accounts`.
- [L705-L749](../pi/codex-accounts/index.ts#L705): providers. Each slot `codex-1…N` is a copy of `openai-codex` with its own sign-in, hidden from the model picker. `codex-pool` serves every model through `streamPool`.
- [L751-L773](../pi/codex-accounts/index.ts#L751): a 30-second timer that announces accounts whose reset has passed (interactive pi only).
- [L778](../pi/codex-accounts/index.ts#L778): the `/codex-accounts` command. Under `pi -p` (no UI) it prints to stdout, which is how the Claude mod reads it.

Environment variables the extension reads: `PI_CODING_AGENT_DIR` (pi's folder) and `PI_CODEX_ACCOUNTS_BASE_URL` (the backend URL, which the tests override).

## 3. Tests: `pi/codex-accounts/test.mjs`

[test.mjs](../pi/codex-accounts/test.mjs) starts a fake ChatGPT backend and a throwaway `PI_CODING_AGENT_DIR`, then drives the real `pi` binary.

- [L165-L267](../pi/codex-accounts/test.mjs#L165): pausing until the exact reset, recovery with a usage check, a window still exhausted after another resets, the 1% cutoff, retries, the all-limited message, non-account errors, and a model missing from one plan.
- [L332-L411](../pi/codex-accounts/test.mjs#L332): showing, listing and spending banked resets (dialogs over RPC), `--dry-run`/`--yes`, and print mode.
- [L436-L452](../pi/codex-accounts/test.mjs#L436): the `codex-subagent` command, covering saved defaults, the account footer, and rejecting bad options.

## Design choices

- **pi extension, not a proxy.** pi already speaks the Codex protocol and has ChatGPT sign-in built in, so the pool lives inside pi and needs no local server.
- **Separate sign-ins per program.** Each slot is pi's own `/login`. Copying one refresh token between programs leads to it being revoked.
- **Switch only before streaming starts.** A request can move to another account only while it has produced no output, so no answer is ever duplicated or spliced together.
- **Never spend banked resets automatically.** Spending one is always explicit, and it warns you when the account isn't at its limit yet.
- **Read-only by default.** `edit` access runs pi's bash, edit and write tools without a sandbox, in `cwd`.
