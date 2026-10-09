#!/usr/bin/env bash
# Sets up Claude-pi-spawner on this Mac (or Linux) from this checkout:
#   1. links the codex-accounts extension into pi        (~/.pi/agent/extensions)
#   2. links the codex-subagent command into your PATH  (~/.local/bin)
#   3. loads the pi-subagents mod in every Claude Code session, desktop app included
#      (CLAUDE_CODE_PLUGIN_DIRS in the env block of ~/.claude/settings.json)
#
#   ./install.sh              install, or repoint an earlier install at this checkout
#   ./install.sh --uninstall  remove the three links/entries again (accounts and settings in ~/.pi stay)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOD="$REPO/claude/pi-subagents"
EXT="$REPO/pi/codex-accounts"
BIN="$MOD/bin/codex-subagent.mjs"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXT_LINK="$PI_DIR/extensions/codex-accounts"
BIN_DIR="$HOME/.local/bin"
BIN_LINK="$BIN_DIR/codex-subagent"
SETTINGS="$HOME/.claude/settings.json"

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "Node.js is required (https://nodejs.org)."

# Edits CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json, keeping everything else.
# Any other folder named pi-subagents is dropped, so only one copy of the mod loads.
settings() {
	node - "$SETTINGS" "$1" "$MOD" <<'EOF'
const fs = require("fs");
const path = require("path");
const [file, action, mod] = process.argv.slice(2);
let data = {};
if (fs.existsSync(file)) {
	const raw = fs.readFileSync(file, "utf8");
	try {
		data = raw.trim() ? JSON.parse(raw) : {};
	} catch {
		console.error(`error: ${file} is not valid JSON; fix it and run again.`);
		process.exit(1);
	}
	fs.copyFileSync(file, `${file}.bak-claude-pi-spawner`);
}
const env = (data.env ??= {});
const dirs = (env.CLAUDE_CODE_PLUGIN_DIRS ?? "")
	.split(path.delimiter)
	.filter(Boolean)
	.filter((d) => path.basename(d.replace(/\/+$/, "")) !== "pi-subagents");
if (action === "add") dirs.push(mod);
if (dirs.length) env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(path.delimiter);
else delete env.CLAUDE_CODE_PLUGIN_DIRS;
if (!Object.keys(env).length) delete data.env;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
EOF
}

# Points $2 at $1, refusing to replace a real file or folder.
link() {
	local target="$1" at="$2"
	if [ -e "$at" ] && [ ! -L "$at" ]; then
		die "$at exists and is not a link; move it away and run again."
	fi
	mkdir -p "$(dirname "$at")"
	ln -sfn "$target" "$at"
}

unlink_ours() {
	local at="$1"
	if [ -L "$at" ]; then rm "$at" && say "removed $at"; fi
}

if [ "${1:-}" = "--uninstall" ]; then
	unlink_ours "$EXT_LINK"
	unlink_ours "$BIN_LINK"
	settings remove && say "removed the pi-subagents mod from $SETTINGS"
	say "Done. Your pi logins and pool state in $PI_DIR were left alone."
	exit 0
fi
[ -z "${1:-}" ] || die "unknown option $1 (use --uninstall, or nothing)"

if ! command -v pi >/dev/null && [ ! -x "$HOME/.bun/bin/pi" ]; then
	warn "pi is not installed yet. Install it, then run pi once:"
	warn "  bun i -g @earendil-works/pi-coding-agent   (or: npm i -g @earendil-works/pi-coding-agent)"
fi

chmod +x "$BIN"
link "$EXT" "$EXT_LINK" && say "pi extension:   $EXT_LINK -> $EXT"
link "$BIN" "$BIN_LINK" && say "command:        $BIN_LINK -> $BIN"
settings add && say "Claude mod:     CLAUDE_CODE_PLUGIN_DIRS in $SETTINGS -> $MOD (backup: $SETTINGS.bak-claude-pi-spawner)"

case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*) warn "$BIN_DIR is not on your PATH; add it (e.g. in ~/.zshrc) so Claude can run codex-subagent." ;;
esac

if command -v claude >/dev/null; then
	claude plugin validate "$MOD" >/dev/null 2>&1 && say "mod validates." || warn "claude plugin validate $MOD reported problems; run it to see them."
fi

cat <<EOF

Installed. Next:
  1. In pi, sign in each ChatGPT account:  pi  then  /login codex-1, /login codex-2, ...
     (use a private browser window per account so the browser doesn't reuse the last sign-in)
  2. Quit and reopen the Claude desktop app (or start a new Code session).
  3. In Claude: /codex-accounts to see the pool, then ask it to "use a codex subagent to ...".
EOF
