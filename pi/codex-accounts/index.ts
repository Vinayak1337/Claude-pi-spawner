/**
 * Codex account pool for pi.
 *
 * - `/login codex-1`, `/login codex-2`, … sign in ChatGPT accounts with pi's own
 *   Codex login. Each slot keeps its own tokens in pi's auth.json.
 * - The `codex-pool` provider serves every Codex model. Each request goes to the
 *   first ready account; an account that reaches its limit is paused until its
 *   exact reset time and the same request moves to the next account. Nothing is
 *   switched once output has started.
 * - Reset times come from response headers, the limit error and the usage
 *   endpoint. A paused account is checked and returned to rotation on its own.
 * - `/codex-accounts` shows each account and any banked resets; `/codex-accounts refresh`
 *   reads usage now.
 * - `/codex-accounts resets` lists each account's banked resets; `/codex-accounts reset
 *   [codex-N]` spends one (after confirmation) to clear that account's limits now.
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	createProvider,
	type Model,
	openAICodexResponsesApi,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const POOL = "codex-pool";
const DEFAULT_SLOTS = 5;
const DEFAULT_CUTOFF_PERCENT = 1;
const ATTEMPTS_PER_ACCOUNT = 3;
const UNKNOWN_RESET_MS = 5 * 60_000;
const AUTH_PAUSE_MS = 60_000;
const VERIFY_EVERY_MS = 60_000;
const QUOTA_CODES = /usage_limit_reached|usage_not_included|insufficient_quota/;
// The backend's answer when an account's plan does not include a model.
const MODEL_NOT_ON_PLAN = /model is not supported when using Codex with a ChatGPT account|not available on your plan|model_not_supported/i;
const MODEL_DENIED_MS = 60 * 60_000;
// Codex models newer than pi's built-in catalog; listed by the pool with the
// closest catalog entry's settings. Override with "extraModels" in the store.
const DEFAULT_EXTRA_MODELS = ["gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"];
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
// Tests point the pool at a local server.
const BASE_URL = process.env.PI_CODEX_ACCOUNTS_BASE_URL;

type Window = { usedPercent: number; resetAt: number | null; windowMinutes: number | null };
type AccountState = {
	blockedUntil: number; // ms; 0 when not paused by a limit
	pausedUntil: number; // ms; brief pause after sign-in or network trouble
	reason: string | null;
	windows: { primary?: Window; secondary?: Window };
	credits: { hasCredits: boolean; unlimited: boolean } | null;
	email: string | null;
	plan: string | null;
	lastUsedAt: number | null;
	deniedModels: Record<string, number>; // model -> until (ms): not on this plan
	checkedAt: number | null; // last usage-endpoint reading
	notifiedReady: boolean;
	banked: Banked[] | null; // available banked resets, from the last reading
};
// A banked rate-limit reset ("Full reset (Weekly + 5 hr)") the account can spend.
type Banked = { id: string; title: string | null; expiresAt: number | null; supported: boolean };
type Store = {
	slots: number;
	cutoffPercent: number;
	extraModels: string[];
	accounts: Record<string, AccountState>;
};

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const storePath = () => join(agentDir(), "codex-accounts.json");
const now = () => Date.now();

function loadStore(): Store {
	try {
		const data = JSON.parse(readFileSync(storePath(), "utf8"));
		return {
			slots: Number.isInteger(data.slots) && data.slots > 0 && data.slots <= 20 ? data.slots : DEFAULT_SLOTS,
			cutoffPercent:
				Number.isFinite(data.cutoffPercent) && data.cutoffPercent >= 0 && data.cutoffPercent < 100
					? data.cutoffPercent
					: DEFAULT_CUTOFF_PERCENT,
			extraModels: Array.isArray(data.extraModels)
				? data.extraModels.filter((m: unknown) => typeof m === "string")
				: DEFAULT_EXTRA_MODELS,
			accounts: data.accounts && typeof data.accounts === "object" ? data.accounts : {},
		};
	} catch {
		return {
			slots: DEFAULT_SLOTS,
			cutoffPercent: DEFAULT_CUTOFF_PERCENT,
			extraModels: DEFAULT_EXTRA_MODELS,
			accounts: {},
		};
	}
}
const store = loadStore();
function save() {
	try {
		mkdirSync(dirname(storePath()), { recursive: true });
		const temp = `${storePath()}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
		renameSync(temp, storePath());
	} catch {}
}
function account(id: string): AccountState {
	return (store.accounts[id] ??= {
		blockedUntil: 0,
		pausedUntil: 0,
		reason: null,
		windows: {},
		credits: null,
		email: null,
		plan: null,
		lastUsedAt: null,
		deniedModels: {},
		checkedAt: null,
		notifiedReady: true,
		banked: null,
	});
}
const slotIds = () => Array.from({ length: store.slots }, (_, i) => `codex-${i + 1}`);

function claims(token: string): Record<string, any> {
	try {
		return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
	} catch {
		return {};
	}
}
function describeToken(id: string, token: string) {
	const c = claims(token);
	const a = account(id);
	a.email = c["https://api.openai.com/profile"]?.email ?? a.email;
	a.plan = c["https://api.openai.com/auth"]?.chatgpt_plan_type ?? a.plan;
	return c["https://api.openai.com/auth"]?.chatgpt_account_id as string | undefined;
}

// ---- Usage tracking ---------------------------------------------------------

function observeHeaders(id: string, headers: Headers) {
	const a = account(id);
	for (const side of ["primary", "secondary"] as const) {
		const used = headers.get(`x-codex-${side}-used-percent`);
		if (used === null || used.trim() === "" || !Number.isFinite(Number(used))) continue;
		const reset = Number(headers.get(`x-codex-${side}-reset-at`));
		const minutes = Number(headers.get(`x-codex-${side}-window-minutes`));
		// An unused slot is reported as 0 with no window; it is not extra allowance.
		if (Number(used) === 0 && !(reset > 0) && !(minutes > 0)) {
			delete a.windows[side];
			continue;
		}
		a.windows[side] = {
			usedPercent: Number(used),
			resetAt: reset > 0 ? reset : null,
			windowMinutes: minutes > 0 ? minutes : null,
		};
	}
	const hasCredits = headers.get("x-codex-credits-has-credits");
	if (hasCredits !== null)
		a.credits = {
			hasCredits: /^true$/i.test(hasCredits),
			unlimited: /^true$/i.test(headers.get("x-codex-credits-unlimited") || ""),
		};
}
// The exact moment a limited account can serve again: the reported reset, else
// the latest full window's reset, else a short retry.
function limitResetMs(id: string, body: any, headers?: Headers) {
	const times: number[] = [];
	const resetsAt = Number(body?.error?.resets_at);
	if (resetsAt > 0) times.push(resetsAt * 1000);
	const resetsIn = Number(body?.error?.resets_in_seconds);
	if (resetsIn > 0) times.push(now() + resetsIn * 1000);
	for (const w of Object.values(account(id).windows))
		if (w && w.usedPercent >= 100 && w.resetAt) times.push(w.resetAt * 1000);
	const retry = Number(headers?.get("retry-after"));
	if (retry > 0) times.push(now() + retry * 1000);
	const future = times.filter((t) => t > now());
	return future.length ? Math.max(...future) : now() + UNKNOWN_RESET_MS;
}
function block(id: string, until: number, reason: string) {
	const a = account(id);
	a.blockedUntil = until;
	a.reason = reason;
	a.notifiedReady = false;
	save();
}
function atCutoff(a: AccountState, t = now()) {
	return Object.values(a.windows).some(
		(w) => w && w.resetAt && w.resetAt * 1000 > t && w.usedPercent >= 100 - store.cutoffPercent,
	);
}
// The earliest time a currently limited account could serve again.
function readyAt(a: AccountState, t = now()) {
	const times = [a.blockedUntil, a.pausedUntil].filter((x) => x > t);
	for (const w of Object.values(a.windows))
		if (w && w.resetAt && w.resetAt * 1000 > t && w.usedPercent >= 100 - store.cutoffPercent)
			times.push(w.resetAt * 1000);
	return times.length ? Math.max(...times) : t;
}

// A call to the ChatGPT backend as one account.
async function backend(id: string, token: string, path: string, init: RequestInit = {}) {
	const accountId = describeToken(id, token);
	const base = BASE_URL || "https://chatgpt.com/backend-api";
	const r = await fetch(`${base}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
			...(init.body ? { "content-type": "application/json" } : {}),
		},
		signal: init.signal ?? AbortSignal.timeout(15_000),
	});
	if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
	return r.json();
}
// The account's banked resets that can be spent now, soonest to expire first.
async function readBanked(id: string, token: string, signal?: AbortSignal) {
	const data = await backend(id, token, "/wham/rate-limit-reset-credits", { signal });
	const banked: Banked[] = (Array.isArray(data?.credits) ? data.credits : [])
		.filter((c: any) => c?.status === "available" && typeof c.id === "string")
		.map((c: any) => ({
			id: c.id,
			title: typeof c.title === "string" ? c.title : null,
			expiresAt: c.expires_at ? Date.parse(c.expires_at) || null : null,
			supported: c.is_supported_by_plan !== false,
		}))
		.sort((a: Banked, b: Banked) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
	account(id).banked = banked;
	save();
	return banked;
}

async function readUsage(id: string, token: string, signal?: AbortSignal) {
	const data = await backend(id, token, "/wham/usage", { signal });
	const a = account(id);
	a.plan = data.plan_type ?? a.plan;
	a.windows = {};
	for (const side of ["primary", "secondary"] as const) {
		const w = data.rate_limit?.[`${side}_window`];
		if (w && Number.isFinite(w.used_percent))
			a.windows[side] = {
				usedPercent: w.used_percent,
				resetAt: typeof w.reset_at === "number" ? w.reset_at : null,
				windowMinutes: typeof w.limit_window_seconds === "number" ? w.limit_window_seconds / 60 : null,
			};
	}
	a.credits = data.credits
		? { hasCredits: data.credits.has_credits === true, unlimited: data.credits.unlimited === true }
		: a.credits;
	a.checkedAt = now();
	// The usage reading only counts banked resets; their details come from their own list.
	const bankedCount = Number(data.rate_limit_reset_credits?.available_count);
	if (bankedCount === 0) a.banked = [];
	else if (!Number.isFinite(bankedCount) || a.banked?.length !== bankedCount)
		try {
			await readBanked(id, token, signal);
		} catch {}
	if (data.rate_limit?.limit_reached === true) {
		const until = limitResetMs(id, {});
		a.blockedUntil = until;
		a.reason = "usage limit reached";
	} else if (data.rate_limit?.allowed !== false) {
		a.blockedUntil = 0;
		if (a.reason === "usage limit reached") a.reason = null;
	}
	save();
}

// ---- Selection --------------------------------------------------------------

let registry: ExtensionContext["modelRegistry"] | undefined;
let notify: ((text: string) => void) | undefined;
let showStatus: ((text: string | undefined) => void) | undefined;

async function token(id: string): Promise<string | undefined> {
	if (!registry) return undefined;
	try {
		const result = await registry.getProviderAuth(id);
		return result?.auth.apiKey;
	} catch (error: any) {
		// A failed refresh: the stored sign-in needs attention, or the network is down.
		const a = account(id);
		a.pausedUntil = now() + AUTH_PAUSE_MS;
		a.reason = /oauth|invalid_grant|refresh/i.test(String(error?.message))
			? "sign-in needs renewal (/login " + id + ")"
			: "sign-in check failed; retrying shortly";
		save();
		return undefined;
	}
}
async function signedInSlots() {
	if (!registry) return [];
	return slotIds().filter((id) => {
		try {
			return registry!.getProviderAuthStatus(id).configured;
		} catch {
			return false;
		}
	});
}
// Accounts in priority order that can take a request now. A paused account whose
// reset has passed is confirmed with a fresh usage reading before it is used.
async function candidates(exclude: Set<string>, modelId: string, signal?: AbortSignal) {
	const ready: { id: string; token: string }[] = [];
	for (const id of await signedInSlots()) {
		if (exclude.has(id)) continue;
		const a = account(id);
		const t = now();
		if ((a.deniedModels ??= {})[modelId] > t) continue;
		if (a.pausedUntil > t || a.blockedUntil > t || atCutoff(a, t)) continue;
		const key = await token(id);
		if (!key) continue;
		describeToken(id, key);
		const wasLimited = a.reason === "usage limit reached" || !a.notifiedReady;
		if (wasLimited && (!a.checkedAt || t - a.checkedAt > VERIFY_EVERY_MS)) {
			try {
				await readUsage(id, key, signal);
			} catch {}
			if (a.blockedUntil > now() || atCutoff(a)) continue;
		}
		if (!a.notifiedReady) {
			a.notifiedReady = true;
			a.reason = null;
			notify?.(`${label(id)} is available again.`);
			save();
		}
		ready.push({ id, token: key });
	}
	return ready;
}
function label(id: string) {
	const a = store.accounts[id];
	return a?.email ? `${id} (${a.email})` : id;
}
function fmtTime(ms: number) {
	const d = new Date(ms);
	const sameDay = d.toDateString() === new Date().toDateString();
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
function fmtIn(ms: number) {
	const s = Math.max(0, Math.round((ms - now()) / 1000));
	const d = Math.floor(s / 86400),
		h = Math.floor((s % 86400) / 3600),
		m = Math.ceil((s % 3600) / 60);
	return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m} min`;
}

// ---- The pool's stream -------------------------------------------------------

const codexApi = openAICodexResponsesApi();
const CONTENT_EVENTS = new Set([
	"text_start",
	"text_delta",
	"text_end",
	"thinking_start",
	"thinking_delta",
	"thinking_end",
	"toolcall_start",
	"toolcall_delta",
	"toolcall_end",
	"done",
]);

function errorMessage(model: Model<Api>, message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: now(),
	};
}

export function streamPool(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	(async () => {
		const tried = new Set<string>();
		let lastError: string | null = null;
		for (;;) {
			if (options?.signal?.aborted) {
				out.push({ type: "error", reason: "aborted", error: { ...errorMessage(model, "Request was aborted"), stopReason: "aborted" } });
				return out.end();
			}
			const [next] = await candidates(tried, model.id, options?.signal);
			if (!next) break;
			tried.add(next.id);
			for (let attempt = 0; attempt < ATTEMPTS_PER_ACCOUNT; attempt++) {
				const seen: { status?: number; body?: any; headers?: Headers } = {};
				const observingFetch: typeof fetch = async (input, init) => {
					const response = await fetch(input, init);
					observeHeaders(next.id, response.headers);
					seen.status = response.status;
					seen.headers = response.headers;
					if (!response.ok) {
						try {
							seen.body = JSON.parse(await response.clone().text());
						} catch {}
					}
					return response;
				};
				const inner = codexApi.streamSimple(
					{ ...model, provider: next.id, ...(BASE_URL ? { baseUrl: BASE_URL } : {}) } as Model<Api>,
					context,
					// SSE keeps the HTTP response (and its usage headers) visible to the pool.
					{ ...options, apiKey: next.token, transport: "sse", fetch: observingFetch } as SimpleStreamOptions,
				);
				let held: AssistantMessageEvent | null = null;
				let committed = false;
				let failure: AssistantMessage | null = null;
				for await (const event of inner) {
					if (committed) {
						out.push(event);
						continue;
					}
					if (event.type === "start") {
						held = event;
						continue;
					}
					if (event.type === "error") {
						failure = event.error;
						break;
					}
					if (CONTENT_EVENTS.has(event.type)) {
						committed = true;
						const a = account(next.id);
						a.lastUsedAt = now();
						save();
						showStatus?.(statusLine(next.id));
						if (held) out.push(held);
						out.push(event);
					}
				}
				if (committed) return out.end();
				if (!failure) {
					// Ended with nothing but a start: treat as a dropped connection.
					failure = errorMessage(model, "The response ended before any output.");
				}
				if (options?.signal?.aborted) {
					out.push({ type: "error", reason: "aborted", error: failure });
					return out.end();
				}
				const text = failure.errorMessage || "";
				const code = `${seen.body?.error?.type || ""} ${seen.body?.error?.code || ""}`;
				if (QUOTA_CODES.test(code) || /usage limit/i.test(text)) {
					const until = limitResetMs(next.id, seen.body, seen.headers);
					block(next.id, until, "usage limit reached");
					notify?.(`${label(next.id)} reached its limit; resets ${fmtTime(until)}. Switching account.`);
					lastError = text;
					break;
				}
				const detail = `${text} ${JSON.stringify(seen.body ?? "")}`;
				if (seen.status === 400 && MODEL_NOT_ON_PLAN.test(detail)) {
					// This account's plan lacks the model; another account may have it.
					const a = account(next.id);
					(a.deniedModels ??= {})[model.id] = now() + MODEL_DENIED_MS;
					save();
					lastError = `${model.id} is not available on the plans of the signed-in accounts.`;
					break;
				}
				if (seen.status === 401 || seen.status === 403) {
					const a = account(next.id);
					a.pausedUntil = now() + AUTH_PAUSE_MS;
					a.reason = `request rejected (HTTP ${seen.status}); try /login ${next.id}`;
					save();
					lastError = text;
					break;
				}
				const transient = seen.status === undefined || TRANSIENT_STATUS.has(seen.status);
				if (!transient) {
					// A request problem, not an account problem: report it as is.
					out.push({ type: "error", reason: "error", error: failure });
					return out.end();
				}
				lastError = text;
				if (attempt < ATTEMPTS_PER_ACCOUNT - 1)
					await new Promise((r) => setTimeout(r, 400 * 3 ** attempt));
			}
		}
		const accounts = await signedInSlots();
		let message: string;
		if (!accounts.length)
			message = `No Codex accounts are signed in. Run /login codex-1 (and codex-2, … for more accounts).`;
		else {
			const soonest = accounts
				.map((id) => ({ id, at: readyAt(account(id)) }))
				.filter((x) => x.at > now())
				.sort((a, b) => a.at - b.at)[0];
			message = soonest
				? `All Codex accounts are at their limit. ${label(soonest.id)} resets at ${fmtTime(soonest.at)} (in ${fmtIn(soonest.at)}).`
				: `No Codex account could serve this request${lastError ? `: ${lastError}` : "."}`;
		}
		out.push({ type: "error", reason: "error", error: errorMessage(model, message) });
		out.end();
	})().catch((error) => {
		out.push({ type: "error", reason: "error", error: errorMessage(model, String(error?.message || error)) });
		out.end();
	});
	return out;
}

// ---- Status -----------------------------------------------------------------

function windowText(w?: Window) {
	return w ? `${Math.round(w.usedPercent)}%` : "–";
}
function statusLine(id?: string) {
	const ready = slotIds().filter((s) => store.accounts[s] && readyAt(store.accounts[s]) <= now());
	const active = id ?? ready[0];
	const a = active ? store.accounts[active] : undefined;
	const used = a?.windows.primary ? ` ${windowText(a.windows.primary)}` : "";
	return active ? `codex ${active}${used}` : undefined;
}
async function report(refresh: boolean) {
	const lines: string[] = [];
	const ids = await signedInSlots();
	if (!ids.length) return "No Codex accounts signed in. Run /login codex-1, /login codex-2, …";
	for (const id of ids) {
		const a = account(id);
		// Accounts never checked (e.g. just signed in) are read now too.
		if (refresh || !a.checkedAt || a.banked == null) {
			const key = await token(id);
			if (key)
				try {
					await readUsage(id, key);
				} catch (error: any) {
					a.reason = `usage check failed (${error.message})`;
				}
		}
		const t = now();
		const at = readyAt(a, t);
		const windows = (["primary", "secondary"] as const)
			.filter((s) => a.windows[s])
			.map((s) => {
				const w = a.windows[s]!;
				const name = w.windowMinutes && w.windowMinutes >= 1440 ? "weekly" : w.windowMinutes ? `${Math.round(w.windowMinutes / 60)}h` : s;
				return `${name} ${windowText(w)}${w.resetAt ? ` · resets ${fmtTime(w.resetAt * 1000)}` : ""}`;
			})
			.join(" · ");
		const state =
			at > t ? `paused until ${fmtTime(at)} (in ${fmtIn(at)})` : a.reason && a.pausedUntil > t ? a.reason : "ready";
		lines.push(`${id.padEnd(8)} ${(a.email || "").padEnd(28)} ${(a.plan || "").padEnd(5)} ${windows || "usage unknown"} — ${state}`);
	}
	return [bankedSummary(ids), ...lines].join("\n");
}
function bankedSummary(ids: string[]) {
	const have = ids.filter((id) => account(id).banked?.length);
	if (!have.length)
		return ids.some((id) => account(id).banked === null) ? "Banked resets: unknown (/codex-accounts refresh)" : "Banked resets: none";
	const parts = have.map((id) => {
		const list = account(id).banked!;
		const soonest = list[0].expiresAt;
		return `${id} ×${list.length}${soonest ? ` (expires ${fmtTime(soonest)})` : ""}`;
	});
	return `Banked resets: ${parts.join(" · ")} — spend one with /codex-accounts reset <slot>`;
}
function limitsText(a: AccountState) {
	return (
		(["primary", "secondary"] as const)
			.filter((s) => a.windows[s])
			.map((s) => {
				const w = a.windows[s]!;
				const name = w.windowMinutes && w.windowMinutes >= 1440 ? "weekly" : w.windowMinutes ? `${Math.round(w.windowMinutes / 60)}h` : s;
				return `${name} ${windowText(w)} used`;
			})
			.join(", ") || "usage unknown"
	);
}

// ---- Banked resets ----------------------------------------------------------

async function listBanked() {
	const lines: string[] = [];
	for (const id of await signedInSlots()) {
		const key = await token(id);
		if (!key) {
			lines.push(`${label(id)}: sign-in unavailable`);
			continue;
		}
		try {
			await readUsage(id, key);
			const list = account(id).banked ?? (await readBanked(id, key));
			if (!list.length) lines.push(`${label(id)}: none — ${limitsText(account(id))}`);
			else {
				lines.push(`${label(id)}: ${list.length} banked — ${limitsText(account(id))}`);
				for (const b of list)
					lines.push(
						`   • ${b.title || "Reset"}${b.expiresAt ? `, expires ${fmtTime(b.expiresAt)} (in ${fmtIn(b.expiresAt)})` : ""}${b.supported ? "" : " — not usable on this plan"}`,
					);
			}
		} catch (error: any) {
			lines.push(`${label(id)}: could not read (${error.message})`);
		}
	}
	return lines.length ? lines.join("\n") : "No Codex accounts signed in. Run /login codex-1, /login codex-2, …";
}

// Spends one banked reset on an account, after the person confirms it. `--dry-run`
// describes what would be spent; `--yes` is the confirmation given in advance (for
// callers without dialogs, such as Claude's /codex-accounts).
async function spendBanked(slot: string | undefined, ctx: ExtensionContext, flags: Set<string>) {
	const dryRun = flags.has("--dry-run");
	const preConfirmed = flags.has("--yes");
	if (!slot && !ctx.hasUI)
		return "Name the account: /codex-accounts reset codex-N (see /codex-accounts resets).";
	if (!dryRun && !preConfirmed && !ctx.hasUI) return "Add --yes to confirm spending the reset.";
	const ids = await signedInSlots();
	if (!slot) {
		// Offer the accounts that have a banked reset, most used first.
		const options: { id: string; text: string }[] = [];
		for (const id of ids) {
			const key = await token(id);
			if (!key) continue;
			try {
				await readUsage(id, key);
			} catch {}
			const a = account(id);
			if (a.banked?.some((b) => b.supported)) options.push({ id, text: `${label(id)} — ${limitsText(a)} — ${a.banked.length} banked` });
		}
		if (!options.length) return "No account has a banked reset to spend.";
		const weekly = (id: string) => account(id).windows.secondary?.usedPercent ?? account(id).windows.primary?.usedPercent ?? 0;
		options.sort((x, y) => weekly(y.id) - weekly(x.id));
		const picked = await ctx.ui.select("Spend a banked reset on which account?", options.map((o) => o.text));
		slot = options.find((o) => o.text === picked)?.id;
		if (!slot) return "Cancelled.";
	}
	if (/^\d+$/.test(slot)) slot = `codex-${slot}`;
	if (!ids.includes(slot)) return `${slot} is not a signed-in account (${ids.join(", ") || "none"}).`;
	const key = await token(slot);
	if (!key) return `${slot}: sign-in unavailable; try /login ${slot}.`;
	await readUsage(slot, key);
	const a = account(slot);
	const credit = (await readBanked(slot, key)).find((b) => b.supported);
	if (!credit) return `${label(slot)} has no banked reset it can spend.`;
	const limited = a.blockedUntil > now() || atCutoff(a) || Object.values(a.windows).some((w) => w && w.usedPercent >= 100);
	const title = `Spend a banked reset on ${label(slot)}?`;
	const details = [
		`${credit.title || "Reset"}${credit.expiresAt ? `, expires ${fmtTime(credit.expiresAt)}` : ""}.`,
		`Now: ${limitsText(a)}.`,
		limited ? "" : "This account is not at its limit yet; the unused part of the current windows is lost.",
		"A spent reset cannot be undone.",
	]
		.filter(Boolean)
		.join("\n");
	if (dryRun) return `${title}\n${details}`;
	const ok = preConfirmed || (await ctx.ui.confirm(title, details));
	if (!ok) return "Cancelled; no reset was spent.";
	let result: any;
	try {
		result = await backend(slot, key, "/wham/rate-limit-reset-credits/consume", {
			method: "POST",
			body: JSON.stringify({ redeem_request_id: randomUUID(), credit_id: credit.id }),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (error: any) {
		return `The reset was not confirmed (${error.message}). Check /codex-accounts resets before trying again.`;
	}
	try {
		await readUsage(slot, key);
		await readBanked(slot, key);
	} catch {}
	switch (result?.code) {
		case "reset":
			a.blockedUntil = 0;
			a.pausedUntil = 0;
			a.reason = null;
			a.notifiedReady = true;
			save();
			showStatus?.(statusLine());
			return `${label(slot)} was reset (${result.windows_reset ?? "its"} limit windows). Now: ${limitsText(a)}. ${a.banked?.length ?? 0} banked reset(s) left.`;
		case "nothing_to_reset":
			return `${label(slot)} had nothing to reset; the banked reset was kept.`;
		case "no_credit":
			return `${label(slot)} has no banked reset available.`;
		case "already_redeemed":
			return "That banked reset was already spent.";
		default:
			return `Unexpected answer: ${JSON.stringify(result)}. Check /codex-accounts resets.`;
	}
}

// ---- Registration -----------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// pi's own Codex provider: its ChatGPT login, model catalog and endpoint.
	const base = builtinProviders().find((p) => p.id === "openai-codex");
	if (!base) throw new Error("This pi build has no openai-codex provider.");
	const catalog = base.getModels();
	const template = catalog.find((m) => m.id === "gpt-6-astra") ?? catalog[catalog.length - 1];
	const extra = store.extraModels
		.filter((id) => !catalog.some((m) => m.id === id))
		.map((id) => ({
			...template,
			id,
			name: id.replace(/^gpt-/, "GPT-").replace(/-(\w)/g, (_, c) => ` ${c.toUpperCase()}`),
		}));
	const models = [...catalog, ...extra];
	for (const id of slotIds())
		pi.registerProvider(
			createProvider({
				id,
				name: `ChatGPT account ${id.slice(6)} (codex-pool)`,
				baseUrl: BASE_URL || base.baseUrl,
				auth: base.auth,
				// Slots are used through codex-pool; keep the model picker uncluttered.
				models: models.map((m) => ({ ...m, provider: id })),
				filterModels: () => [],
				api: codexApi,
			}),
		);
	pi.registerProvider(
		createProvider({
			id: POOL,
			name: "Codex pool (switches accounts)",
			baseUrl: BASE_URL || base.baseUrl,
			auth: {
				apiKey: {
					name: "Codex pool (sign in with /login codex-1, codex-2, …)",
					async resolve() {
						return { auth: { apiKey: POOL }, source: "codex accounts" };
					},
				},
			},
			models: models.map((m) => ({ ...m, provider: POOL })),
			api: { stream: streamPool, streamSimple: streamPool },
		}),
	);

	let timer: ReturnType<typeof setInterval> | undefined;
	pi.on("session_start", async (_event, ctx) => {
		registry = ctx.modelRegistry;
		if (ctx.hasUI) {
			notify = (text) => ctx.ui.notify(text, "info");
			showStatus = (text) => ctx.ui.setStatus("codex-accounts", text);
			showStatus(statusLine());
			clearInterval(timer);
			// Announce accounts whose reset has passed, without waiting for a request.
			timer = setInterval(() => {
				for (const id of slotIds()) {
					const a = store.accounts[id];
					if (a && !a.notifiedReady && readyAt(a) <= now()) {
						a.notifiedReady = true;
						a.reason = null;
						save();
						notify?.(`${label(id)} should be available again (its limit reset).`);
					}
				}
				showStatus?.(statusLine());
			}, 30_000);
			timer.unref?.();
		}
	});
	pi.on("session_shutdown", async () => {
		clearInterval(timer);
	});

	pi.registerCommand("codex-accounts", {
		description: "Codex pool: show accounts; `refresh`, `resets`, `reset [codex-N]`, `cutoff <percent>`, `slots <n>`",
		handler: async (args, ctx) => {
			registry = ctx.modelRegistry;
			// Without a UI (pi -p), answers are printed (pi routes them to stderr) for scripts and Claude.
			const ui = ctx.hasUI ? ctx.ui : { notify: (text: string) => void process.stdout.write(`${text}\n`) };
			const words = (args || "").trim().split(/\s+/);
			const flags = new Set(words.filter((w) => w.startsWith("--")));
			const [cmd, value] = words.filter((w) => !w.startsWith("--"));
			if (cmd === "cutoff" && value !== undefined) {
				const n = Number(value);
				if (!Number.isFinite(n) || n < 0 || n >= 100) return ui.notify("Use a percent from 0 to 99.", "error");
				store.cutoffPercent = n;
				save();
				return ui.notify(`Accounts switch at ${n}% remaining.`, "info");
			}
			if (cmd === "slots" && value !== undefined) {
				const n = Number(value);
				if (!Number.isInteger(n) || n < 1 || n > 20) return ui.notify("Use 1 to 20 slots.", "error");
				store.slots = n;
				save();
				return ui.notify(`${n} account slots. Restart pi to apply.`, "info");
			}
			if (cmd === "resets") return ui.notify(await listBanked(), "info");
			if (cmd === "reset") return ui.notify(await spendBanked(value, ctx, flags), "info");
			ui.notify(await report(cmd === "refresh"), "info");
		},
	});
}
