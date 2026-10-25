// End-to-end tests: the real `pi -p` with this extension, against a local
// stand-in for the ChatGPT backend. Uses a temporary pi folder; never touches
// ~/.pi or any real account.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PI = process.env.PI_BIN || "pi";
const MODEL = "gpt-5.6-luna";
// The older tests switch the scheduled refresh off so their backend call counts stay exact,
// and expect a refusal (not a wait) when every account is at its limit.
const QUIET = { PI_CODEX_ACCOUNTS_REFRESH_MS: "0", PI_CODEX_ACCOUNTS_WAIT_MS: "0" };

const jwt = (account, email) =>
	`h.${Buffer.from(
		JSON.stringify({
			exp: Math.floor(Date.now() / 1000) + 86400 * 30,
			"https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "pro" },
			"https://api.openai.com/profile": { email },
		}),
	).toString("base64url")}.s`;

const sse = (text) =>
	[
		{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	]
		.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
		.join("");

// A stand-in backend: each account follows a script of replies.
async function backend(t) {
	const calls = [];
	const plans = {}; // account -> array of reply functions, last one repeats
	const usage = {}; // account -> wham/usage body
	const banked = {}; // account -> available banked resets
	const server = http.createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const account = req.headers["chatgpt-account-id"];
		let body;
		try {
			body = raw ? JSON.parse(raw) : undefined;
		} catch {} // model requests may be compressed
		calls.push({ path: req.url.split("?")[0], account, method: req.method, body });
		const json = (body) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (req.url.startsWith("/wham/usage"))
			return json({
				...(usage[account] ?? { rate_limit: { allowed: true, limit_reached: false } }),
				rate_limit_reset_credits: { available_count: (banked[account] ?? []).length },
			});
		if (req.url.startsWith("/wham/rate-limit-reset-credits/consume")) {
			const list = banked[account] ?? [];
			const i = list.findIndex((c) => c.id === body?.credit_id);
			if (i < 0) return json({ code: "no_credit" });
			list.splice(i, 1);
			usage[account] = { rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 0, reset_at: Math.floor(Date.now() / 1000) + 18000, limit_window_seconds: 18000 } } };
			return json({ code: "reset", windows_reset: 2 });
		}
		if (req.url.startsWith("/wham/rate-limit-reset-credits"))
			return json({ credits: (banked[account] ?? []).map((c) => ({ reset_type: "codex_rate_limits", status: "available", is_supported_by_plan: true, title: "Full reset (Weekly + 5 hr)", granted_at: "2026-09-29T17:15:45Z", ...c })), available_count: (banked[account] ?? []).length });
		const script = plans[account] || [];
		const reply = script.length > 1 ? script.shift() : script[0];
		if (!reply) {
			res.writeHead(500);
			return res.end("no plan");
		}
		reply(res);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise((r) => server.close(r)));
	return { base: `http://127.0.0.1:${server.address().port}`, calls, plans, usage, banked };
}
const ok = (text, headers = {}) => (res) => {
	res.writeHead(200, { "content-type": "text/event-stream", ...headers });
	res.end(sse(text));
};
const limit = (resetsAt) => (res) => {
	res.writeHead(429, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { type: "usage_limit_reached", message: "limit", resets_at: resetsAt, plan_type: "pro" } }));
};
const status = (code) => (res) => {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message: `HTTP ${code}` } }));
};

async function piHome(t, accounts = ["a1", "a2"]) {
	const dir = await mkdtemp(join(tmpdir(), "pi-codex-accounts-"));
	await mkdir(join(dir, "extensions"), { recursive: true });
	await symlink(HERE, join(dir, "extensions", "codex-accounts"));
	const auth = {};
	accounts.forEach((id, i) => {
		auth[`codex-${i + 1}`] = {
			type: "oauth",
			access: jwt(id, `${id}@example.com`),
			refresh: `refresh-${id}`,
			expires: Date.now() + 86400_000 * 30,
			accountId: id,
		};
	});
	await writeFile(join(dir, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
	await writeFile(join(dir, "settings.json"), JSON.stringify({ quietStartup: true }));
	// A pi that was just stopped may still be writing its last files.
	t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	return dir;
}
function runPi(home, base, prompt = "hi", extraEnv = {}) {
	return new Promise((resolve) => {
		const child = execFile(
			PI,
			["-p", "--no-session", "--no-context-files", "--no-skills", "--provider", "codex-pool", "--model", MODEL, prompt],
			{
				env: { ...process.env, PI_CODING_AGENT_DIR: home, PI_CODEX_ACCOUNTS_BASE_URL: base, ...QUIET, ...extraEnv, PI_OFFLINE: "1" },
				timeout: 60_000,
			},
			(error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr, out: stdout + stderr }),
		);
		// Print mode reads a piped prompt from stdin; close it.
		child.stdin.end();
	});
}
const state = async (home) => JSON.parse(await readFile(join(home, "codex-accounts.json"), "utf8"));
const responses = (calls) => calls.filter((c) => c.path === "/codex/responses").map((c) => c.account);

test("a limited account is paused until its exact reset and the request moves to the next account", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const resetsAt = Math.floor(Date.now() / 1000) + 3600;
	b.plans.a1 = [limit(resetsAt)];
	b.plans.a2 = [ok("served-by-a2")];
	const r = await runPi(home, b.base);
	assert.match(r.stdout, /served-by-a2/, r.out);
	assert.deepEqual(responses(b.calls), ["a1", "a2"]);
	const s = await state(home);
	assert.equal(s.accounts["codex-1"].blockedUntil, resetsAt * 1000);
	// The next request skips the paused account entirely.
	const again = await runPi(home, b.base);
	assert.match(again.stdout, /served-by-a2/, again.out);
	assert.deepEqual(responses(b.calls), ["a1", "a2", "a2"]);
});

test("after its reset passes, the account is confirmed with a usage check and used again first", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.plans.a1 = [limit(Math.floor(Date.now() / 1000) + 2), ok("a1-is-back")];
	b.plans.a2 = [ok("a2-meanwhile")];
	assert.match((await runPi(home, b.base)).stdout, /a2-meanwhile/);
	await new Promise((r) => setTimeout(r, 2500));
	b.usage.a1 = { plan_type: "pro", rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 3, reset_at: Math.floor(Date.now() / 1000) + 18000, limit_window_seconds: 18000 } } };
	const r = await runPi(home, b.base);
	assert.match(r.stdout, /a1-is-back/, r.out);
	assert.ok(b.calls.some((c) => c.path === "/wham/usage" && c.account === "a1"));
	const s = await state(home);
	assert.equal(s.accounts["codex-1"].blockedUntil, 0);
	assert.equal(s.accounts["codex-1"].windows.primary.usedPercent, 3);
});

test("a reset that leaves another window exhausted keeps the account paused until the later reset", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.plans.a1 = [limit(Math.floor(Date.now() / 1000) + 2)];
	b.plans.a2 = [ok("a2")];
	await runPi(home, b.base);
	await new Promise((r) => setTimeout(r, 2500));
	const weekly = Math.floor(Date.now() / 1000) + 5 * 86400;
	b.usage.a1 = {
		rate_limit: {
			allowed: false,
			limit_reached: true,
			primary_window: { used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 18000, limit_window_seconds: 18000 },
			secondary_window: { used_percent: 100, reset_at: weekly, limit_window_seconds: 604800 },
		},
	};
	assert.match((await runPi(home, b.base)).stdout, /a2/);
	const s = await state(home);
	assert.equal(s.accounts["codex-1"].blockedUntil, weekly * 1000);
	assert.deepEqual(responses(b.calls), ["a1", "a2", "a2"]);
});

test("an account at 99% usage keeps serving until it hits its limit", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const reset = Math.floor(Date.now() / 1000) + 3600;
	const nearly = {
		"x-codex-primary-used-percent": "99.5",
		"x-codex-primary-reset-at": String(reset),
		"x-codex-primary-window-minutes": "300",
	};
	b.plans.a1 = [ok("a1-first", nearly), ok("a1-again", nearly)];
	b.plans.a2 = [ok("a2-unused")];
	assert.match((await runPi(home, b.base)).stdout, /a1-first/);
	assert.match((await runPi(home, b.base)).stdout, /a1-again/);
	assert.deepEqual(responses(b.calls), ["a1", "a1"]);
});

test("brief upstream failures are retried on the same account", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.plans.a1 = [status(503), ok("a1-after-503")];
	const r = await runPi(home, b.base);
	assert.match(r.stdout, /a1-after-503/, r.out);
	assert.deepEqual(responses(b.calls), ["a1", "a1"]);
});

test("when every account is limited the error names the earliest reset", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const soon = Math.floor(Date.now() / 1000) + 1800;
	b.plans.a1 = [limit(soon + 7200)];
	b.plans.a2 = [limit(soon)];
	const r = await runPi(home, b.base);
	assert.notEqual(r.code, 0);
	assert.match(r.out, /All Codex accounts are at their limit\. codex-2 \(a2@example\.com\) resets at/);
});

test("when every account is limited, the request waits for the soonest reset and carries on", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const soon = Math.floor(Date.now() / 1000) + 2;
	b.plans.a1 = [limit(soon + 7200)];
	b.plans.a2 = [limit(soon), ok("a2-after-its-reset")];
	b.usage.a2 = { plan_type: "pro", rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 1, reset_at: soon + 18000, limit_window_seconds: 18000 } } };
	const started = Date.now();
	const r = await runPi(home, b.base, "hi", { PI_CODEX_ACCOUNTS_WAIT_MS: "60000", PI_CODEX_ACCOUNTS_RESET_MARGIN_MS: "200" });
	assert.equal(r.code, 0, r.out);
	assert.match(r.stdout, /a2-after-its-reset/, r.out);
	assert.ok(Date.now() - started >= 1500, "it waited for the reset");
	assert.deepEqual(responses(b.calls), ["a1", "a2", "a2"]);
});

test("a reset further away than the wait limit is refused at once", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const soon = Math.floor(Date.now() / 1000) + 1800;
	b.plans.a1 = [limit(soon + 7200)];
	b.plans.a2 = [limit(soon)];
	const r = await runPi(home, b.base, "hi", { PI_CODEX_ACCOUNTS_WAIT_MS: "60000" });
	assert.notEqual(r.code, 0);
	assert.match(r.out, /All Codex accounts are at their limit\. codex-2 \(a2@example\.com\) resets at/);
});

test("a request error that is not about the account is reported without switching", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.plans.a1 = [status(400)];
	b.plans.a2 = [ok("should-not-run")];
	const r = await runPi(home, b.base);
	assert.doesNotMatch(r.stdout, /should-not-run/);
	assert.deepEqual(responses(b.calls), ["a1"]);
});

test("a model missing from one account's plan is served by another account", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.plans.a1 = [
		(res) => {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ detail: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." }));
		},
	];
	b.plans.a2 = [ok("sol-on-a2")];
	const r = await new Promise((resolve) => {
		const child = execFile(
			PI,
			["-p", "--no-session", "--no-context-files", "--no-skills", "--provider", "codex-pool", "--model", "gpt-6.1-sol", "hi"],
			{ env: { ...process.env, PI_CODING_AGENT_DIR: home, PI_CODEX_ACCOUNTS_BASE_URL: b.base, ...QUIET, PI_OFFLINE: "1" } },
			(error, stdout, stderr) => resolve({ stdout, out: stdout + stderr }),
		);
		child.stdin.end();
	});
	assert.match(r.stdout, /sol-on-a2/, r.out);
	const s = await state(home);
	assert.ok(s.accounts["codex-1"].deniedModels["gpt-6.1-sol"] > Date.now());
	// The account is not paused for other models.
	assert.equal(s.accounts["codex-1"].blockedUntil, 0);
});

// Runs one slash command in pi's RPC mode, answering its dialogs with `answer`,
// and returns the dialogs asked and the notifications shown.
function runCommand(home, base, command, answer = () => ({ cancelled: true })) {
	return new Promise((resolve, reject) => {
		const child = spawn(PI, ["--mode", "rpc", "--no-session", "--no-context-files", "--no-skills", "--provider", "codex-pool", "--model", MODEL], {
			env: { ...process.env, PI_CODING_AGENT_DIR: home, PI_CODEX_ACCOUNTS_BASE_URL: base, ...QUIET, PI_OFFLINE: "1" },
		});
		const dialogs = [];
		const notes = [];
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`timed out; notes: ${JSON.stringify(notes)}`));
		}, 30_000);
		const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
		createInterface({ input: child.stdout }).on("line", (line) => {
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (msg.type === "extension_ui_request" && (msg.method === "confirm" || msg.method === "select")) {
				dialogs.push(msg);
				send({ type: "extension_ui_response", id: msg.id, ...answer(msg) });
			}
			if (msg.type === "extension_ui_request" && msg.method === "notify") notes.push(msg.message);
			if (msg.type === "response" && msg.command === "prompt") {
				// The command has run; give its notification a moment, then stop.
				setTimeout(() => {
					clearTimeout(timer);
					child.once("exit", () => resolve({ dialogs, notes, text: notes.join("\n") }));
					child.kill();
				}, 300);
			}
		});
		send({ id: "cmd", type: "prompt", message: command });
	});
}

test("the account list shows banked resets above the accounts", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.banked.a2 = [{ id: "credit-a2", expires_at: "2026-12-29T17:15:45Z" }];
	const r = await runCommand(home, b.base, "/codex-accounts");
	const lines = r.text.split("\n");
	assert.match(lines[0], /^Banked resets: codex-2 ×1 \(expires .+\)/, r.text);
	assert.match(lines[1], /^codex-1/);
	const list = await runCommand(home, b.base, "/codex-accounts resets");
	assert.match(list.text, /codex-1 \(a1@example\.com\): none/, list.text);
	assert.match(list.text, /codex-2 \(a2@example\.com\): 1 banked[\s\S]*Full reset \(Weekly \+ 5 hr\), expires/, list.text);
});

test("spending a banked reset asks first, then clears the account's limit", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const weekly = Math.floor(Date.now() / 1000) + 5 * 86400;
	b.usage.a1 = { rate_limit: { allowed: false, limit_reached: true, secondary_window: { used_percent: 100, reset_at: weekly, limit_window_seconds: 604800 } } };
	b.banked.a1 = [
		{ id: "credit-late", expires_at: "2027-01-30T00:00:00Z" },
		{ id: "credit-soon", expires_at: "2026-12-01T00:00:00Z" },
	];
	// Declining spends nothing.
	const no = await runCommand(home, b.base, "/codex-accounts reset 1", () => ({ confirmed: false }));
	assert.equal(no.dialogs.length, 1);
	assert.match(no.dialogs[0].title, /Spend a banked reset on codex-1/);
	assert.match(no.text, /Cancelled; no reset was spent/);
	assert.ok(!b.calls.some((c) => c.path.endsWith("/consume")));
	// Confirming spends the reset that expires soonest and unblocks the account.
	const yes = await runCommand(home, b.base, "/codex-accounts reset codex-1", () => ({ confirmed: true }));
	const consumed = b.calls.filter((c) => c.path.endsWith("/consume"));
	assert.equal(consumed.length, 1);
	assert.equal(consumed[0].method, "POST");
	assert.equal(consumed[0].account, "a1");
	assert.equal(consumed[0].body.credit_id, "credit-soon");
	assert.match(consumed[0].body.redeem_request_id, /^[0-9a-f-]{36}$/);
	assert.match(yes.text, /codex-1 \(a1@example\.com\) was reset \(2 limit windows\)\. Now: 5h 0% used\. 1 banked reset\(s\) left\./, yes.text);
	const s = await state(home);
	assert.equal(s.accounts["codex-1"].blockedUntil, 0);
	// The pool uses the account again.
	b.plans.a1 = [ok("a1-after-reset")];
	assert.match((await runPi(home, b.base)).stdout, /a1-after-reset/);
});

test("reset without a slot offers only accounts that have a banked reset", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.banked.a2 = [{ id: "credit-a2" }];
	const r = await runCommand(home, b.base, "/codex-accounts reset", (msg) => (msg.method === "select" ? { value: msg.options[0] } : { confirmed: true }));
	assert.equal(r.dialogs[0].method, "select");
	assert.equal(r.dialogs[0].options.length, 1);
	assert.match(r.dialogs[0].options[0], /^codex-2/);
	assert.equal(b.calls.filter((c) => c.path.endsWith("/consume"))[0].body.credit_id, "credit-a2");
	assert.match(r.text, /codex-2 \(a2@example\.com\) was reset/);
});

test("with no banked resets, nothing is offered or spent", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const r = await runCommand(home, b.base, "/codex-accounts reset");
	assert.equal(r.dialogs.length, 0);
	assert.match(r.text, /No account has a banked reset to spend/);
	assert.ok(!b.calls.some((c) => c.path.endsWith("/consume")));
});

test("--dry-run describes the reset without spending; --yes spends it without a dialog", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.banked.a1 = [{ id: "credit-a1", expires_at: "2026-12-01T00:00:00Z" }];
	const dry = await runCommand(home, b.base, "/codex-accounts reset codex-1 --dry-run");
	assert.equal(dry.dialogs.length, 0);
	assert.match(dry.text, /Spend a banked reset on codex-1[\s\S]*not at its limit yet[\s\S]*cannot be undone/, dry.text);
	assert.ok(!b.calls.some((c) => c.path.endsWith("/consume")));
	const yes = await runCommand(home, b.base, "/codex-accounts reset 1 --yes");
	assert.equal(yes.dialogs.length, 0);
	assert.equal(b.calls.filter((c) => c.path.endsWith("/consume")).length, 1);
	assert.match(yes.text, /codex-1 \(a1@example\.com\) was reset/, yes.text);
});

test("without a UI (pi -p) the commands print their answer", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.banked.a1 = [{ id: "credit-a1" }];
	const list = await runPi(home, b.base, "/codex-accounts resets");
	assert.match(list.out, /codex-1 \(a1@example\.com\): 1 banked/, list.out);
	const noConfirm = await runPi(home, b.base, "/codex-accounts reset codex-1");
	assert.match(noConfirm.out, /Add --yes to confirm/, noConfirm.out);
	assert.ok(!b.calls.some((c) => c.path.endsWith("/consume")));
});

// Claude's background command for subagents (claude/pi-subagents/bin).
const SUBAGENT = new URL("../../claude/pi-subagents/bin/codex-subagent.mjs", import.meta.url).pathname;
function runSubagent(home, base, args, input) {
	return new Promise((resolve) => {
		const child = execFile(
			process.execPath,
			[SUBAGENT, ...args],
			{ env: { ...process.env, PI_CODING_AGENT_DIR: home, PI_CODEX_ACCOUNTS_BASE_URL: base, ...QUIET, PI_OFFLINE: "1", PI_SUBAGENT_BIN: PI }, timeout: 60_000 },
			(error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
		);
		child.stdin.end(input ?? "");
	});
}

test("codex-subagent runs a task on the pool with the saved defaults and names the account", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	await mkdir(join(home, "claude-subagents"), { recursive: true });
	await writeFile(join(home, "claude-subagents", "defaults.json"), JSON.stringify({ model: MODEL, thinking: "high" }));
	b.plans.a1 = [ok("subagent-answer")];
	const r = await runSubagent(home, b.base, [], "say hi");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /^subagent-answer\n\n\[pi subagent · gpt-5\.6-luna · high · read-only · account codex-1 \(a1@example\.com\) · [\d.]+ min · session [0-9a-f-]{36}\]\n$/);
	// Options override the defaults; a limited account still switches.
	b.plans.a1 = [limit(Math.floor(Date.now() / 1000) + 3600)];
	b.plans.a2 = [ok("from-a2")];
	const r2 = await runSubagent(home, b.base, ["--effort", "low", "--access", "edit", "say", "hi"]);
	assert.match(r2.stdout, /from-a2[\s\S]*· low · edit · account codex-2/, r2.stdout);
});

test("codex-subagent rejects bad options before starting pi", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const r = await runSubagent(home, b.base, ["--effort", "huge", "task"]);
	assert.equal(r.code, 2);
	assert.match(r.stderr, /effort must be one of/);
	assert.ok(!b.calls.length);
});

// ---- Shared state, shared refresh, check before refusing ---------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const okSlow = (text, ms) => async (res) => {
	await sleep(ms);
	ok(text)(res);
};
const usageCalls = (calls) => calls.filter((c) => c.path === "/wham/usage").map((c) => c.account);
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const leaseFile = (home) => join(home, "codex-accounts.lease");
const writeState = (home, accounts, extra = {}) =>
	writeFile(join(home, "codex-accounts.json"), JSON.stringify({ slots: 5, accounts, ...extra }), { mode: 0o600 });
const blocked = (until, extra = {}) => ({
	blockedUntil: until,
	pausedUntil: 0,
	reason: "usage limit reached",
	windows: {},
	credits: null,
	email: null,
	plan: null,
	lastUsedAt: null,
	deniedModels: {},
	checkedAt: null,
	notifiedReady: false,
	banked: null,
	...extra,
});
const room = { plan_type: "pro", rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 4, reset_at: Math.floor(Date.now() / 1000) + 18000, limit_window_seconds: 18000 } } };
const full = (resetAt) => ({ plan_type: "pro", rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: resetAt, limit_window_seconds: 18000 } } });

// A long-lived pi (RPC mode) that answers several commands, like an open agent.
function rpcSession(home, base, env = {}) {
	const child = spawn(PI, ["--mode", "rpc", "--no-session", "--no-context-files", "--no-skills", "--provider", "codex-pool", "--model", MODEL], {
		env: { ...process.env, PI_CODING_AGENT_DIR: home, PI_CODEX_ACCOUNTS_BASE_URL: base, ...QUIET, ...env, PI_OFFLINE: "1" },
	});
	let notes = [];
	let waiting;
	createInterface({ input: child.stdout }).on("line", (line) => {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.type === "extension_ui_request" && msg.method === "notify") notes.push(msg.message);
		if (msg.type === "response" && msg.command === "prompt") waiting?.();
	});
	let n = 0;
	return {
		child,
		async run(command) {
			notes = [];
			const done = new Promise((r) => (waiting = r));
			child.stdin.write(JSON.stringify({ id: `c${++n}`, type: "prompt", message: command }) + "\n");
			await done;
			await sleep(300);
			return notes.join("\n");
		},
		close() {
			if (child.exitCode !== null || child.signalCode) return Promise.resolve();
			const gone = once(child, "exit");
			child.kill();
			return gone;
		},
	};
}

test("a running pi picks up another process's newer account state instead of using its stale copy", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const p1 = rpcSession(home, b.base);
	t.after(() => p1.close());
	// p1 has read the state once and now holds its own copy.
	assert.match(await p1.run("/codex-accounts"), /codex-1 .*— ready/);
	// Another pi process finds codex-1 at its limit and records it (and a setting the file did not know of).
	const resetsAt = Math.floor(Date.now() / 1000) + 3600;
	const file = join(home, "codex-accounts.json");
	await writeFile(file, JSON.stringify({ ...(await readJson(file)), futureField: { keep: true } }));
	b.plans.a1 = [limit(resetsAt)];
	b.plans.a2 = [ok("from-a2")];
	assert.match((await runPi(home, b.base)).stdout, /from-a2/);
	// p1 sees it without being restarted.
	assert.match(await p1.run("/codex-accounts"), /codex-1 .*— paused until/);
	// p1's later writes keep the other process's record and the fields it does not know.
	await p1.run("/codex-accounts slots 6");
	const s = await readJson(file);
	assert.equal(s.accounts["codex-1"].blockedUntil, resetsAt * 1000);
	assert.equal(s.slots, 6);
	assert.deepEqual(s.futureField, { keep: true });
	assert.ok(s.accounts["codex-1"].updatedAt > 0);
});

test("two pi processes writing at once keep each other's updates", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const resetsAt = Math.floor(Date.now() / 1000) + 3600;
	// Both requests reach codex-1 before either reply is processed: one learns the account is
	// at its limit, the other that its plan lacks the model. Both facts belong to codex-1.
	let arrivals = 0;
	let release;
	const gate = new Promise((r) => (release = r));
	b.plans.a1 = [
		async (res) => {
			const mine = ++arrivals;
			if (arrivals >= 2) release();
			await gate;
			if (mine === 1) return limit(resetsAt)(res);
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ detail: "The model is not supported when using Codex with a ChatGPT account." }));
		},
	];
	b.plans.a2 = [ok("served")];
	const [x, y] = await Promise.all([runPi(home, b.base), runPi(home, b.base)]);
	assert.match(x.stdout, /served/, x.out);
	assert.match(y.stdout, /served/, y.out);
	const s = (await state(home)).accounts["codex-1"];
	assert.equal(s.blockedUntil, resetsAt * 1000);
	assert.ok(s.deniedModels[MODEL] > Date.now());
	assert.ok((await state(home)).accounts["codex-2"].lastUsedAt > 0);
	assert.ok(!existsSync(join(home, "codex-accounts.json.lock")));
});

test("a lease held by a dead process is taken over and usage is read once", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const dead = spawn(process.execPath, ["-e", "0"]);
	await once(dead, "exit");
	await writeFile(leaseFile(home), JSON.stringify({ pid: dead.pid, expiresAt: Date.now() + 600_000, lastRefreshAt: 0, claimPid: 0, claimUntil: 0 }));
	b.plans.a1 = [okSlow("served", 1200)];
	const r = await runPi(home, b.base, "hi", { PI_CODEX_ACCOUNTS_REFRESH_MS: "300000" });
	assert.match(r.stdout, /served/, r.out);
	assert.deepEqual(usageCalls(b.calls).sort(), ["a1", "a2"]);
	assert.deepEqual(responses(b.calls), ["a1"]);
	const lease = await readJson(leaseFile(home));
	assert.equal(lease.pid, 0, "the lease is given back when the process ends");
	assert.ok(Date.now() - lease.lastRefreshAt < 30_000);
	assert.equal(lease.claimPid, 0);
	const s = await state(home);
	assert.ok(s.accounts["codex-1"].checkedAt > 0 && s.accounts["codex-2"].checkedAt > 0);
});

test("a live holder keeps the lease: other processes do not read usage, and take over when it is gone", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const holder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
	t.after(() => holder.kill());
	await writeFile(leaseFile(home), JSON.stringify({ pid: holder.pid, expiresAt: Date.now() + 600_000, lastRefreshAt: 0, claimPid: 0, claimUntil: 0 }));
	b.plans.a1 = [okSlow("served", 1000)];
	const env = { PI_CODEX_ACCOUNTS_REFRESH_MS: "300000" };
	assert.match((await runPi(home, b.base, "hi", env)).stdout, /served/);
	assert.deepEqual(usageCalls(b.calls), []);
	assert.equal((await readJson(leaseFile(home))).pid, holder.pid);
	// The holder goes away: the next process takes over.
	holder.kill();
	await once(holder, "exit");
	assert.match((await runPi(home, b.base, "hi", env)).stdout, /served/);
	assert.deepEqual(usageCalls(b.calls).sort(), ["a1", "a2"]);
});

test("an expired lease is taken over even if its holder still runs; a recent refresh is not repeated", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const idle = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
	t.after(() => idle.kill());
	await writeFile(leaseFile(home), JSON.stringify({ pid: idle.pid, expiresAt: Date.now() - 1000, lastRefreshAt: 0, claimPid: 0, claimUntil: 0 }));
	b.plans.a1 = [okSlow("served", 1000)];
	const env = { PI_CODEX_ACCOUNTS_REFRESH_MS: "300000" };
	await runPi(home, b.base, "hi", env);
	assert.deepEqual(usageCalls(b.calls).sort(), ["a1", "a2"]);
	// Usage was read a moment ago, so the next process leaves it alone.
	await runPi(home, b.base, "hi", env);
	assert.equal(usageCalls(b.calls).length, 2);
});

test("with four agents open there is one refresh per interval, not one per agent", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.usage.a1 = room;
	b.usage.a2 = room;
	const env = { PI_CODEX_ACCOUNTS_REFRESH_MS: "1500", PI_CODEX_ACCOUNTS_TICK_MS: "200" };
	const agents = [0, 1, 2, 3].map(() => rpcSession(home, b.base, env));
	t.after(() => agents.forEach((a) => a.close()));
	await sleep(6500);
	const perAccount = { a1: 0, a2: 0 };
	for (const account of usageCalls(b.calls)) perAccount[account]++;
	// Roughly one per 1.5 s per account: 3 to 5 in this window. One per agent would be 12 or more.
	for (const [account, n] of Object.entries(perAccount)) assert.ok(n >= 2 && n <= 6, `${account} was read ${n} times`);
	assert.equal(perAccount.a1, perAccount.a2);
	// The others pick the readings up from the shared file.
	const s = await state(home);
	assert.equal(s.accounts["codex-1"].windows.primary.usedPercent, 4);
	await Promise.all(agents.map((a) => a.close()));
	assert.equal((await readJson(leaseFile(home))).pid, 0);
});

test("usage that shows room is used again whatever the stored block says; one refresh before refusing", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	// Both accounts were blocked an hour ago for another three; OpenAI has since reset codex-1.
	const until = Date.now() + 3 * 3600_000;
	await writeState(home, {
		"codex-1": blocked(until, { blockedAt: Date.now() - 3600_000 }),
		"codex-2": blocked(until, { blockedAt: Date.now() - 3600_000 }),
	});
	const resetAt = Math.floor(Date.now() / 1000) + 3 * 3600;
	b.usage.a1 = room;
	b.usage.a2 = full(resetAt);
	b.plans.a1 = [ok("a1-after-early-reset")];
	b.plans.a2 = [ok("must-not-run")];
	const r = await runPi(home, b.base);
	assert.match(r.stdout, /a1-after-early-reset/, r.out);
	assert.deepEqual(responses(b.calls), ["a1"]);
	assert.deepEqual(usageCalls(b.calls).sort(), ["a1", "a2"]);
	const s = await state(home);
	assert.equal(s.accounts["codex-1"].blockedUntil, 0);
	assert.equal(s.accounts["codex-2"].blockedUntil, resetAt * 1000);
});

test("when usage confirms every account is at its limit, the same message is given and usage is read once a minute", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const resetAt = Math.floor(Date.now() / 1000) + 3600;
	await writeState(home, {
		"codex-1": blocked(resetAt * 1000 + 7200_000, { blockedAt: Date.now() - 600_000 }),
		"codex-2": blocked(resetAt * 1000, { blockedAt: Date.now() - 600_000 }),
	});
	b.usage.a1 = full(resetAt + 7200);
	b.usage.a2 = full(resetAt);
	for (let i = 0; i < 2; i++) {
		const r = await runPi(home, b.base);
		assert.notEqual(r.code, 0);
		assert.match(r.out, /All Codex accounts are at their limit\. codex-2 \(a2@example\.com\) resets at/, r.out);
	}
	assert.deepEqual(responses(b.calls), []);
	assert.deepEqual(usageCalls(b.calls).sort(), ["a1", "a2"], "the second refusal reuses the reading from a few seconds before");
});

test("a limit error that just came in is not undone by a usage reading that says there is room", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const resetsAt = Math.floor(Date.now() / 1000) + 3600;
	b.plans.a1 = [limit(resetsAt)];
	b.plans.a2 = [limit(resetsAt + 60)];
	b.usage.a1 = room; // lags behind the error
	b.usage.a2 = room;
	const r = await runPi(home, b.base);
	assert.match(r.out, /All Codex accounts are at their limit\. codex-1 \(a1@example\.com\) resets at/, r.out);
});

test("a request waiting for a reset carries on as soon as a shared refresh shows an account free", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const resetAt = Math.floor(Date.now() / 1000) + 3600;
	await writeState(home, {
		"codex-1": blocked(resetAt * 1000 + 7200_000, { blockedAt: Date.now() - 600_000 }),
		"codex-2": blocked(resetAt * 1000, { blockedAt: Date.now() - 600_000 }),
	});
	b.usage.a1 = full(resetAt + 7200);
	b.usage.a2 = full(resetAt);
	b.plans.a2 = [ok("a2-freed-early")];
	const running = runPi(home, b.base, "hi", { PI_CODEX_ACCOUNTS_WAIT_MS: String(2 * 3600_000), PI_CODEX_ACCOUNTS_TICK_MS: "100" });
	await new Promise((r) => setTimeout(r, 1500));
	// Another process's refresh found that codex-2's limit was reset early (say, a banked reset).
	b.usage.a2 = room;
	await writeState(home, {
		"codex-1": blocked(resetAt * 1000 + 7200_000, { blockedAt: Date.now() - 600_000 }),
		"codex-2": blocked(0, { reason: null, notifiedReady: true, checkedAt: Date.now(), windows: { primary: { usedPercent: 4, resetAt: resetAt + 18000, windowMinutes: 300 } } }),
	});
	const r = await running;
	assert.equal(r.code, 0, r.out);
	assert.match(r.stdout, /a2-freed-early/, r.out);
	assert.deepEqual(responses(b.calls), ["a2"]);
});
