/**
 * Codex account pool for pi.
 *
 * - `/login codex-1`, `/login codex-2`, … sign in ChatGPT accounts with pi's own
 *   Codex login. Each slot keeps its own tokens in pi's auth.json.
 * - The `codex-pool` provider serves every Codex model. Each request goes to the
 *   first ready account; an account that reaches its limit is paused until its
 *   exact reset time and the same request moves to the next account. Nothing is
 *   switched once output has started. When every account is at its limit, the
 *   request waits for the soonest reset and carries on, instead of failing
 *   (`PI_CODEX_ACCOUNTS_WAIT_MS`, default 6 hours; 0 refuses at once).
 * - Reset times come from response headers, the limit error and the usage
 *   endpoint. A paused account is checked and returned to rotation on its own.
 * - `/codex-accounts` shows each account and any banked resets; `/codex-accounts refresh`
 *   reads usage now.
 * - `/codex-accounts resets` lists each account's banked resets; `/codex-accounts reset
 *   [codex-N]` spends one (after confirmation) to clear that account's limits now.
 *
 * Several pi processes share one pool at the same time, so the state is shared too:
 * - `codex-accounts.json` is the one truth. Every process keeps a working copy,
 *   re-reads the file before it chooses an account or records a limit, and writes
 *   back with a three-way merge (what it last saw, what it changed, what is on disk
 *   now) under a short lock file, so no process overwrites another's newer reading.
 * - While any process uses `codex-pool` (UI or `pi -p`), one of them, elected through
 *   `codex-accounts.lease` (holder pid + expiry), reads every account's usage every
 *   minute (`PI_CODEX_ACCOUNTS_REFRESH_MS`). The others pick the result up from the shared file. A refresh only
 *   reads usage: no model request, no banked reset is spent.
 * - Before the pool reports that every account is at its limit, it reads usage once
 *   more, but only if nobody read it in the last refresh interval (1 minute); a request
 *   asking sooner is turned down and uses the shared reading. A request waiting for a
 *   reset takes up each new shared reading, so it ends as soon as any account is free. An account whose real usage
 *   shows room is used again whatever its stored `blockedUntil` says.
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
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const POOL = "codex-pool";
const DEFAULT_SLOTS = 5;
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
// Shared refresh: one process reads every account's usage this often (0 turns it off).
const envMs = (name: string, fallback: number) => {
	const n = Number(process.env[name]);
	return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};
const REFRESH_MS = envMs("PI_CODEX_ACCOUNTS_REFRESH_MS", 60_000);
// How often each process looks at the shared state and at the lease.
const TICK_MS = Math.max(50, envMs("PI_CODEX_ACCOUNTS_TICK_MS", 30_000));
const LEASE_MS = 3 * TICK_MS;
// A refresh that has not finished by then is treated as abandoned.
const CLAIM_MS = 60_000;
// Before refusing with "all at their limit", usage is re-read at most this often: no more
// often than the scheduled refresh, so many agents asking at once still read usage once.
const REFUSE_REFRESH_MS = REFRESH_MS > 0 ? REFRESH_MS : 60_000;
// A limit error this recent outranks a usage reading that says there is room.
const FRESH_BLOCK_MS = 60_000;
// Longest a scheduled or pre-refusal usage read may take, and the longest a request waits for one.
const USAGE_TIMEOUT_MS = 8_000;
const RECHECK_WAIT_MS = 12_000;
// When every account is at its limit, a request waits for the soonest reset instead of failing,
// as long as that reset is at most this far away (0 turns waiting off and refuses at once).
const WAIT_FOR_RESET_MS = envMs("PI_CODEX_ACCOUNTS_WAIT_MS", 6 * 60 * 60_000);
// Margin after a reported reset, so the first request after it is not refused again.
const RESET_MARGIN_MS = envMs("PI_CODEX_ACCOUNTS_RESET_MARGIN_MS", 15_000);
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
	blockedAt?: number; // when blockedUntil was last set by a limit error (ms)
	updatedAt?: number; // when any process last changed this record (ms); newest wins on conflicts
};
// A banked rate-limit reset ("Full reset (Weekly + 5 hr)") the account can spend.
type Banked = { id: string; title: string | null; expiresAt: number | null; supported: boolean };
type Store = {
	slots: number;
	extraModels: string[];
	accounts: Record<string, AccountState>;
};

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const storePath = () => join(agentDir(), "codex-accounts.json");
const lockPath = () => `${storePath()}.lock`;
const leasePath = () => join(agentDir(), "codex-accounts.lease");
const now = () => Date.now();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
// Key-order independent text of a value, for comparing records.
function canon(v: any): string {
	if (v === undefined) return "u";
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
	return `{${Object.keys(v)
		.filter((k) => v[k] !== undefined)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
		.join(",")}}`;
}
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
};
const sleepSync = (ms: number) => {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {}
};

function normalize(data: any): Store {
	return {
		slots: Number.isInteger(data?.slots) && data.slots > 0 && data.slots <= 20 ? data.slots : DEFAULT_SLOTS,
		extraModels: Array.isArray(data?.extraModels)
			? data.extraModels.filter((m: unknown) => typeof m === "string")
			: DEFAULT_EXTRA_MODELS,
		accounts: data?.accounts && typeof data.accounts === "object" ? data.accounts : {},
	};
}
// The file as written by whichever process saved last, or null when missing or unreadable.
function readDisk(): { raw: any; store: Store } | null {
	try {
		const raw = JSON.parse(readFileSync(storePath(), "utf8"));
		if (!raw || typeof raw !== "object") return null;
		return { raw, store: normalize(raw) };
	} catch {
		return null;
	}
}
const disk0 = readDisk();
const store: Store = disk0?.store ?? normalize(null);
const settingsOf = (s: Store) => ({ slots: s.slots, extraModels: s.extraModels });
// What this process last saw on disk, per account and for the settings. A record that
// differs from it is a change this process still has to write.
let baseSettings = clone(settingsOf(store));
const base: Record<string, any> = clone(store.accounts);

// A short cross-process lock around reading, merging and writing the shared files.
// It is only held for a few milliseconds; a lock left by a dead process is broken.
function withLock<T>(fn: () => T): T {
	const path = lockPath();
	let held = false;
	try {
		mkdirSync(dirname(path), { recursive: true });
	} catch {}
	const deadline = now() + 3000;
	for (;;) {
		try {
			const fd = openSync(path, "wx", 0o600);
			try {
				writeSync(fd, String(process.pid));
			} finally {
				closeSync(fd);
			}
			held = true;
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") break;
			try {
				const age = now() - statSync(path).mtimeMs;
				const pid = Number(readFileSync(path, "utf8"));
				if (age > 5000 || (pid > 0 && age > 50 && !alive(pid))) {
					rmSync(path, { force: true });
					continue;
				}
			} catch {}
			if (now() > deadline) break; // never block a request on a stuck lock
			sleepSync(3 + Math.random() * 8);
		}
	}
	try {
		return fn();
	} finally {
		if (held) {
			try {
				rmSync(path, { force: true });
			} catch {}
		}
	}
}

// Three-way merge of one record (or the settings): what this process holds, what it
// last saw on disk, what is on disk now. A field only one side changed takes that
// side's value; a field both changed keeps this process's value, except readings
// that only move forward (newest wins) and the models denied to an account (union).
function mergeFields(mem: any, last: any, disk: any, isAccount: boolean) {
	const out: any = {};
	for (const k of new Set([...Object.keys(mem), ...Object.keys(disk)])) {
		if (k === "updatedAt") continue;
		const m = mem[k],
			d = disk[k],
			b = last?.[k];
		let v: any;
		if (canon(m) === canon(d)) v = m;
		else if (canon(m) === canon(b)) v = d;
		else if (canon(d) === canon(b)) v = m;
		else if (isAccount && (k === "lastUsedAt" || k === "checkedAt" || k === "blockedAt"))
			v = Math.max(Number(m) || 0, Number(d) || 0) || null;
		else if (isAccount && k === "deniedModels") {
			v = { ...(d ?? {}) };
			for (const [model, until] of Object.entries(m ?? {})) v[model] = Math.max(Number(until) || 0, Number(v[model]) || 0);
		} else v = m;
		if (v !== undefined) out[k] = v;
	}
	if (isAccount && (mem.updatedAt !== undefined || disk.updatedAt !== undefined))
		out.updatedAt = Math.max(Number(mem.updatedAt) || 0, Number(disk.updatedAt) || 0);
	return out;
}
function replaceInPlace(target: any, source: any) {
	for (const k of Object.keys(target)) delete target[k];
	Object.assign(target, source);
}
// Brings what is on disk into this process's copy without losing its unsaved changes.
// Records are changed in place, so objects held across an await stay current.
function reconcile(disk: Store) {
	const merged = mergeFields(settingsOf(store), baseSettings, settingsOf(disk), false);
	store.slots = merged.slots;
	store.extraModels = merged.extraModels;
	baseSettings = clone(settingsOf(disk));
	for (const [id, theirs] of Object.entries(disk.accounts)) {
		if (!theirs || typeof theirs !== "object") continue;
		const mine = store.accounts[id];
		if (!mine) store.accounts[id] = clone(theirs);
		else replaceInPlace(mine, mergeFields(mine, base[id], theirs, true));
		base[id] = clone(theirs);
	}
}
// Re-reads the shared state (cheap; no lock needed since writes are atomic renames).
function sync() {
	const disk = readDisk();
	if (disk) reconcile(disk.store);
}
const withoutStamp = (a: any) => {
	const { updatedAt: _ignored, ...rest } = a ?? {};
	return canon(rest);
};
function save() {
	try {
		withLock(() => {
			const disk = readDisk();
			if (disk) reconcile(disk.store);
			let changed = !disk || canon(settingsOf(store)) !== canon(baseSettings);
			for (const [id, a] of Object.entries(store.accounts)) {
				if (disk && base[id] && withoutStamp(a) === withoutStamp(base[id])) continue;
				// A change made now: it is the newest reading of this account.
				a.updatedAt = Math.max(now(), (Number(base[id]?.updatedAt) || 0) + 1);
				changed = true;
			}
			if (!changed) return;
			const extra = Object.fromEntries(
				Object.entries(disk?.raw ?? {}).filter(([k]) => !["slots", "cutoffPercent", "extraModels", "accounts"].includes(k)),
			);
			const text = JSON.stringify({ ...extra, ...settingsOf(store), accounts: store.accounts }, null, 2) + "\n";
			mkdirSync(dirname(storePath()), { recursive: true });
			const temp = `${storePath()}.${process.pid}.tmp`;
			writeFileSync(temp, text, { mode: 0o600 });
			renameSync(temp, storePath());
			baseSettings = clone(settingsOf(store));
			for (const [id, a] of Object.entries(store.accounts)) base[id] = clone(a);
		});
	} catch {}
}
const newAccount = (): AccountState => ({
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
function account(id: string): AccountState {
	if (!store.accounts[id]) {
		store.accounts[id] = newAccount();
		// A new record is not a change until something sets a value on it.
		base[id] = clone(store.accounts[id]);
	}
	return store.accounts[id];
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
	// Other processes see a live reading as soon as it arrives.
	save();
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
	sync();
	const a = account(id);
	a.blockedUntil = until;
	a.blockedAt = now();
	a.reason = reason;
	a.notifiedReady = false;
	save();
}
function atLimit(a: AccountState, t = now()) {
	return Object.values(a.windows).some((w) => w && w.resetAt && w.resetAt * 1000 > t && w.usedPercent >= 100);
}
// The earliest time a currently limited account could serve again.
function readyAt(a: AccountState, t = now()) {
	const times = [a.blockedUntil, a.pausedUntil].filter((x) => x > t);
	for (const w of Object.values(a.windows))
		if (w && w.resetAt && w.resetAt * 1000 > t && w.usedPercent >= 100)
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
async function fetchBanked(id: string, token: string, signal?: AbortSignal) {
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
	return banked;
}
async function readBanked(id: string, token: string, signal?: AbortSignal) {
	const banked = await fetchBanked(id, token, signal);
	sync();
	account(id).banked = banked;
	save();
	return banked;
}

async function readUsage(id: string, token: string, signal?: AbortSignal) {
	const data = await backend(id, token, "/wham/usage", { signal });
	// The reading is applied on top of the latest shared state, all in one step.
	sync();
	// The usage reading only counts banked resets; their details come from their own list.
	const bankedCount = Number(data.rate_limit_reset_credits?.available_count);
	let banked: Banked[] | undefined = bankedCount === 0 ? [] : undefined;
	if (bankedCount !== 0 && (!Number.isFinite(bankedCount) || account(id).banked?.length !== bankedCount))
		try {
			banked = await fetchBanked(id, token, signal);
		} catch {}
	sync();
	const a = account(id);
	if (banked) a.banked = banked;
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
	if (data.rate_limit?.limit_reached === true) {
		const until = limitResetMs(id, {});
		a.blockedUntil = until;
		a.reason = "usage limit reached";
	} else if (data.rate_limit?.allowed !== false) {
		// Real usage shows room, whatever the stored block says. Only a limit error that
		// came in a moment ago is kept: the reading may have been taken before it.
		const fresh = a.blockedUntil > now() && a.blockedAt && now() - a.blockedAt < FRESH_BLOCK_MS;
		if (!fresh) {
			a.blockedUntil = 0;
			if (a.reason === "usage limit reached") a.reason = null;
		}
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
	// Other processes may have read newer usage or hit a limit since this one last looked.
	sync();
	for (const id of await signedInSlots()) {
		if (exclude.has(id)) continue;
		const a = account(id);
		const t = now();
		if ((a.deniedModels ??= {})[modelId] > t) continue;
		if (a.pausedUntil > t || a.blockedUntil > t || atLimit(a, t)) continue;
		const key = await token(id);
		if (!key) continue;
		describeToken(id, key);
		const wasLimited = a.reason === "usage limit reached" || !a.notifiedReady;
		if (wasLimited && (!a.checkedAt || t - a.checkedAt > VERIFY_EVERY_MS)) {
			try {
				await readUsage(id, key, signal);
			} catch {}
			if (a.blockedUntil > now() || atLimit(a)) continue;
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

// ---- Shared refresh -----------------------------------------------------------
//
// One process at a time holds the lease (codex-accounts.lease: holder pid and expiry)
// and reads every account's usage on a schedule. The lease also records when usage was
// last read and who is reading it now, so refreshes never overlap or repeat across
// processes. The lease is taken over when its holder has died or let it expire.

type Lease = { pid: number; expiresAt: number; lastRefreshAt: number; attemptAt: number; claimPid: number; claimUntil: number };
function readLease(): Lease {
	try {
		const l = JSON.parse(readFileSync(leasePath(), "utf8"));
		const n = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
		return { pid: n(l.pid), expiresAt: n(l.expiresAt), lastRefreshAt: n(l.lastRefreshAt), attemptAt: n(l.attemptAt), claimPid: n(l.claimPid), claimUntil: n(l.claimUntil) };
	} catch {
		return { pid: 0, expiresAt: 0, lastRefreshAt: 0, attemptAt: 0, claimPid: 0, claimUntil: 0 };
	}
}
function writeLease(l: Lease) {
	const temp = `${leasePath()}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(l) + "\n", { mode: 0o600 });
	renameSync(temp, leasePath());
}
const holderIsOther = (l: Lease, t = now()) => l.pid > 0 && l.pid !== process.pid && l.expiresAt > t && alive(l.pid);
const claimIsOther = (l: Lease, t = now()) => l.claimPid > 0 && l.claimPid !== process.pid && l.claimUntil > t && alive(l.claimPid);

// Takes or renews the lease unless a live process holds it. Returns whether this
// process is the holder, and the lease as it stands.
function holdLease(): { holder: boolean; lease: Lease } {
	try {
		return withLock(() => {
			const l = readLease();
			if (holderIsOther(l)) return { holder: false, lease: l };
			l.pid = process.pid;
			l.expiresAt = now() + LEASE_MS;
			writeLease(l);
			return { holder: true, lease: l };
		});
	} catch {
		return { holder: false, lease: readLease() };
	}
}
function releaseLease() {
	try {
		withLock(() => {
			const l = readLease();
			let changed = false;
			if (l.pid === process.pid) {
				l.pid = 0;
				l.expiresAt = 0;
				changed = true;
			}
			if (l.claimPid === process.pid) {
				l.claimPid = 0;
				l.claimUntil = 0;
				changed = true;
			}
			if (changed) writeLease(l);
		});
	} catch {}
}
// Reserves the right to read usage now, unless usage was read less than `minMs` ago or
// another live process is reading it. `holderOnly` is for the scheduled refresh.
function claimRefresh(minMs: number, holderOnly: boolean): "claimed" | "recent" | "busy" | "other-holder" {
	try {
		return withLock(() => {
			const t = now();
			const l = readLease();
			const other = holderIsOther(l, t);
			if (holderOnly && other) return "other-holder";
			if (claimIsOther(l, t)) return "busy";
			// Usage was read recently, or a refresh was started a minute ago and may have been cut short.
			if (t - l.lastRefreshAt < minMs || t - l.attemptAt < Math.min(minMs, 60_000)) return "recent";
			if (!other) {
				l.pid = process.pid;
				l.expiresAt = t + LEASE_MS;
			}
			l.claimPid = process.pid;
			l.claimUntil = t + CLAIM_MS;
			l.attemptAt = t;
			writeLease(l);
			return "claimed";
		});
	} catch {
		return "busy";
	}
}
// Records that usage was just read (by the claimed refresh, or by a manual one).
function noteRefreshed() {
	try {
		withLock(() => {
			const l = readLease();
			if (l.claimPid === process.pid) {
				l.claimPid = 0;
				l.claimUntil = 0;
			}
			l.lastRefreshAt = now();
			writeLease(l);
		});
	} catch {}
}

// Reads every signed-in account's usage. Only reads: no model request, no banked reset.
async function readAllUsage(signal?: AbortSignal) {
	// A slow usage endpoint must not hold a request, or the process, for long.
	signal = AbortSignal.any([AbortSignal.timeout(USAGE_TIMEOUT_MS), ...(signal ? [signal] : [])]);
	await Promise.all(
		(await signedInSlots()).map(async (id) => {
			const key = await token(id);
			if (!key) return;
			try {
				await readUsage(id, key, signal);
			} catch {}
		}),
	);
}
let refreshing: Promise<void> | undefined;
// Runs the refresh this process has just claimed.
function runClaimedRefresh(signal?: AbortSignal) {
	refreshing ??= readAllUsage(signal).finally(() => {
		noteRefreshed();
		refreshing = undefined;
	});
	return refreshing;
}
// Before the pool says "all accounts are at their limit": read usage once more, but
// at most once per refresh interval across all processes, then take the shared state as it is.
async function recheckBeforeRefusing(signal?: AbortSignal) {
	let giveUp: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<void>((resolve) => (giveUp = setTimeout(resolve, RECHECK_WAIT_MS)));
	await Promise.race([recheck(signal), limit]);
	clearTimeout(giveUp);
	sync();
}
async function recheck(signal?: AbortSignal) {
	sync();
	if (refreshing) await refreshing.catch(() => {});
	else {
		const claim = claimRefresh(REFUSE_REFRESH_MS, false);
		if (claim === "claimed") await runClaimedRefresh(signal);
		else if (claim === "busy") {
			// Another process is reading right now; wait for its result.
			const until = now() + 10_000;
			while (now() < until && !signal?.aborted && claimIsOther(readLease())) await new Promise((r) => setTimeout(r, 200));
		}
	}
}

let poolInUse = false;
let wantsTicks = false;
let showAnnouncements = false;
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let nextTickMs = TICK_MS;
let exitHooked = false;

// Announces accounts whose reset has passed, without waiting for a request.
function announceReady() {
	for (const id of slotIds()) {
		const a = store.accounts[id];
		if (a && !a.notifiedReady && readyAt(a) <= now()) {
			a.notifiedReady = true;
			a.reason = null;
			save();
			notify?.(`${label(id)} should be available again (its limit reset).`);
		}
	}
}
async function tick() {
	sync();
	if (showAnnouncements) announceReady();
	nextTickMs = TICK_MS;
	if (poolInUse && REFRESH_MS > 0) {
		const { holder, lease } = holdLease();
		if (holder) {
			nextTickMs = Math.max(100, Math.min(TICK_MS, lease.lastRefreshAt + REFRESH_MS - now()));
			if (claimRefresh(REFRESH_MS, true) === "claimed") {
				await runClaimedRefresh();
				nextTickMs = Math.min(TICK_MS, REFRESH_MS);
			}
		}
	}
	showStatus?.(statusLine());
}
function scheduleTick() {
	tickTimer = setTimeout(() => {
		tick()
			.catch(() => {})
			.finally(() => {
				if (wantsTicks) scheduleTick();
			});
	}, nextTickMs);
	tickTimer.unref?.();
}
// Starts the periodic work; the first round runs at once.
function startTicks() {
	if (wantsTicks) return;
	wantsTicks = true;
	if (!exitHooked) {
		exitHooked = true;
		process.once("exit", releaseLease);
	}
	tickTimer = undefined;
	tick()
		.catch(() => {})
		.finally(() => {
			if (wantsTicks) scheduleTick();
		});
}
function stopTicks() {
	wantsTicks = false;
	poolInUse = false;
	clearTimeout(tickTimer);
	releaseLease();
}
// This process uses codex-pool: it takes part in the shared refresh.
function markPoolInUse() {
	poolInUse = true;
	startTicks();
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

// The signed-in account whose limit resets first, when every one of them is limited now.
async function soonestReset(): Promise<{ id: string; at: number } | undefined> {
	const t = now();
	const times = (await signedInSlots()).map((id) => ({ id, at: readyAt(account(id), t) }));
	if (!times.length || times.some((x) => x.at <= t)) return undefined;
	return times.sort((a, b) => a.at - b.at)[0];
}

// Waits until [at] (plus a margin), waking every tick to take up the shared state: when the
// scheduled refresh shows an account free sooner, the wait ends then. False when aborted.
async function waitForReset(at: number, signal?: AbortSignal): Promise<boolean> {
	for (;;) {
		const left = at + RESET_MARGIN_MS - now();
		if (left <= 0) return true;
		if (!(await pause(Math.min(left, TICK_MS), signal))) return false;
		sync();
		const soonest = await soonestReset();
		if (!soonest) return true;
		at = Math.min(at, soonest.at);
	}
}

// Sleeps [ms]; false when [signal] aborts first.
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const done = (ok: boolean) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(ok);
		};
		const onAbort = () => done(false);
		const timer = setTimeout(() => done(true), Math.max(0, ms));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function streamPool(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	(async () => {
		const tried = new Set<string>();
		let lastError: string | null = null;
		let rechecked = false;
		markPoolInUse();
		for (;;) {
			if (options?.signal?.aborted) {
				out.push({ type: "error", reason: "aborted", error: { ...errorMessage(model, "Request was aborted"), stopReason: "aborted" } });
				return out.end();
			}
			let [next] = await candidates(tried, model.id, options?.signal);
			if (!next && !rechecked && (await signedInSlots()).length) {
				// Everything looks blocked: read real usage once before refusing.
				rechecked = true;
				await recheckBeforeRefusing(options?.signal);
				[next] = await candidates(tried, model.id, options?.signal);
			}
			if (!next) {
				const soonest = await soonestReset();
				if (soonest && soonest.at - now() <= WAIT_FOR_RESET_MS) {
					notify?.(`All Codex accounts are at their limit. Waiting for ${label(soonest.id)} at ${fmtTime(soonest.at)} (in ${fmtIn(soonest.at)}).`);
					if (!(await waitForReset(soonest.at, options?.signal))) continue;
					// A new window: every account may serve again, and usage is worth reading once more.
					tried.clear();
					rechecked = false;
					continue;
				}
				break;
			}
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
					context as never,
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
			const soonest = await soonestReset();
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
	sync();
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
	if (refresh) noteRefreshed();
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
	const limited = a.blockedUntil > now() || atLimit(a) || Object.values(a.windows).some((w) => w && w.usedPercent >= 100);
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

	pi.on("session_start", async (_event, ctx) => {
		registry = ctx.modelRegistry;
		showAnnouncements = ctx.hasUI;
		if (ctx.hasUI) {
			notify = (text) => ctx.ui.notify(text, "info");
			showStatus = (text) => ctx.ui.setStatus("codex-accounts", text);
			showStatus(statusLine());
		}
		// UI sessions watch the shared state; any session using the pool also shares the refresh.
		if (ctx.model?.provider === POOL) markPoolInUse();
		else if (ctx.hasUI) startTicks();
	});
	pi.on("model_select", async (event) => {
		if (event.model?.provider === POOL) markPoolInUse();
	});
	pi.on("session_shutdown", async () => {
		stopTicks();
	});

	pi.registerCommand("codex-accounts", {
		description: "Codex pool: show accounts; `refresh`, `resets`, `reset [codex-N]`, `slots <n>`",
		handler: async (args, ctx) => {
			registry = ctx.modelRegistry;
			// Without a UI (pi -p), answers are printed (pi routes them to stderr) for scripts and Claude.
			const ui = ctx.hasUI ? ctx.ui : { notify: (text: string) => void process.stdout.write(`${text}\n`) };
			const words = (args || "").trim().split(/\s+/);
			const flags = new Set(words.filter((w) => w.startsWith("--")));
			const [cmd, value] = words.filter((w) => !w.startsWith("--"));
			if (cmd === "slots" && value !== undefined) {
				const n = Number(value);
				if (!Number.isInteger(n) || n < 1 || n > 20) return ui.notify("Use 1 to 20 slots.", "error");
				sync();
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
