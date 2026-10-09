#!/usr/bin/env node
// Runs one Codex subagent: pi on the codex-pool provider, the same run as Claude's
// codex_subagent tool, as a plain command. Claude starts it as a background shell
// job (Bash with run_in_background), so the job shows in its task list, can be
// stopped, and wakes whoever started it when it exits, with this output.
//
//   codex-subagent [--model M] [--effort E] [--access read-only|edit] [--cwd DIR]
//                  [--session ID] [--timeout MIN] [--task-file FILE | TASK... | < task]
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_MODEL = "gpt-6-luna";
const READ_ONLY_TOOLS = "read,grep,find,ls";
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

function fail(message) {
	process.stderr.write(`codex-subagent: ${message}\n`);
	process.exit(2);
}
function usage() {
	process.stdout.write(`Usage: codex-subagent [options] [TASK...]

Runs a pi subagent on the Codex account pool and prints its final answer.
The task comes from --task-file, the remaining arguments, or stdin.

  --model M          codex-pool model (default: saved default, else ${DEFAULT_MODEL})
  --effort E         ${EFFORTS.join(", ")} (default: saved default, else medium)
  --access A         read-only (default) or edit (bash, edit, write; no sandbox)
  --cwd DIR          folder the subagent works in (default: current folder)
  --session ID       continue an earlier subagent (its id is printed at the end)
  --timeout MIN      stop after MIN minutes (default 30, max 240)
  --task-file FILE   read the task from FILE

Saved defaults: /codex-subagent in Claude Code (${join(agentDir, "claude-subagents", "defaults.json")}).
`);
	process.exit(0);
}

const opts = { access: "read-only", timeout: 30 };
const rest = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	const value = () => (i + 1 < argv.length ? argv[++i] : fail(`${arg} needs a value`));
	if (arg === "-h" || arg === "--help") usage();
	else if (arg === "--model") opts.model = value();
	else if (arg === "--effort" || arg === "--thinking") opts.effort = value();
	else if (arg === "--access") opts.access = value();
	else if (arg === "--cwd") opts.cwd = value();
	else if (arg === "--session") opts.session = value();
	else if (arg === "--timeout") opts.timeout = Number(value());
	else if (arg === "--task-file") opts.taskFile = value();
	else if (arg === "--") rest.push(...argv.slice(i + 1)), (i = argv.length);
	else if (arg.startsWith("--")) fail(`unknown option ${arg} (see --help)`);
	else rest.push(arg);
}

let defaults = {};
try {
	defaults = JSON.parse(readFileSync(join(agentDir, "claude-subagents", "defaults.json"), "utf8"));
} catch {}
const model = opts.model || defaults.model || DEFAULT_MODEL;
const effort = opts.effort || defaults.thinking || "medium";
if (!EFFORTS.includes(effort)) fail(`effort must be one of ${EFFORTS.join(", ")}`);
if (!["read-only", "edit"].includes(opts.access)) fail("access must be read-only or edit");
if (!(opts.timeout > 0)) fail("timeout must be a number of minutes");
const timeoutMs = Math.min(240, opts.timeout) * 60_000;

let task = opts.taskFile ? readFileSync(opts.taskFile, "utf8") : rest.join(" ");
if (!task.trim() && !process.stdin.isTTY) task = readFileSync(0, "utf8");
if (!task.trim()) fail("give a task (arguments, --task-file, or stdin)");

const pi =
	[process.env.PI_SUBAGENT_BIN, join(homedir(), ".bun", "bin", "pi"), "/opt/homebrew/bin/pi", "/usr/local/bin/pi"].find(
		(p) => p && existsSync(p),
	) || fail("pi was not found (bun i -g @earendil-works/pi-coding-agent, or set PI_SUBAGENT_BIN)");

const statePath = join(agentDir, "codex-accounts.json");
const readState = () => {
	try {
		return JSON.parse(readFileSync(statePath, "utf8"));
	} catch {
		return {};
	}
};
const before = readState();
const session = opts.session || randomUUID();
const started = Date.now();

const args = [
	"-p",
	"--provider", "codex-pool",
	"--model", model,
	"--thinking", effort,
	"--session-dir", join(agentDir, "claude-subagents"),
	"--session-id", session,
	...(opts.access === "edit" ? [] : ["--tools", READ_ONLY_TOOLS]),
];
// The task goes over stdin, so text starting with "@" or "-" is never read as a flag or file.
const child = spawn(pi, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
child.stdin.end(task);
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));

let stopped = null;
const stop = (why) => {
	stopped ??= why;
	child.kill("SIGTERM");
	setTimeout(() => child.kill("SIGKILL"), 5000).unref();
};
const timer = setTimeout(() => stop("timeout"), timeoutMs);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => stop("stopped"));

child.on("close", (code) => {
	clearTimeout(timer);
	const after = readState();
	const served = Object.entries(after.accounts ?? {})
		.filter(([id, a]) => (a.lastUsedAt ?? 0) > (before.accounts?.[id]?.lastUsedAt ?? 0))
		.map(([id, a]) => (a.email ? `${id} (${a.email})` : id));
	const minutes = ((Date.now() - started) / 60_000).toFixed(1);
	const footer = `[pi subagent · ${model} · ${effort} · ${opts.access} · ${served.length ? `account ${served.join(", ")}` : "account unknown"} · ${minutes} min · session ${session}]`;
	const answer = stdout.trim();
	if (stopped) {
		process.stdout.write(`${answer || "(no answer yet)"}\n\n${stopped === "timeout" ? `Stopped after ${minutes} minutes (timeout).` : "Stopped."}\n${footer}\n`);
		return process.exit(124);
	}
	if (code !== 0 || !answer) {
		process.stdout.write(`The subagent failed${code === null ? "" : ` (exit ${code})`}:\n${(stderr.trim() || answer || "no output").slice(-4000)}\n${footer}\n`);
		return process.exit(code || 1);
	}
	process.stdout.write(`${answer}\n\n${footer}\n`);
	process.exit(0);
});
