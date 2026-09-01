/**
 * The backlog faculty — pure domain logic, no I/O.
 *
 * A backlog entry is a DEFERRED INTENT: a lead or task the supervisor means to act on but has not
 * yet. It is project-scoped and time-bounded like short-term memory (default 48h, then deleted from
 * the store). The lifecycle (`open`/`taken`/`done`/`dropped`) and optional wake are why it is not
 * just another STM note; durable identity still belongs in long-term memory. The `persona` field is
 * who created it, used only for the view filter.
 */

import { contentId } from "./ids.ts";

export const BACKLOG_STATES = ["open", "taken", "done", "dropped"] as const;
/** Same default life as short-term memory — working intent goes stale just as working notes do. */
export const DEFAULT_BACKLOG_TTL_HOURS = 48;
export type BacklogState = (typeof BACKLOG_STATES)[number];
export const DEFAULT_BACKLOG_MAX = 20;
export const MAX_BACKLOG_MAX = 50;
export const MAX_BACKLOG_TEXT_CHARS = 8_192;
export const MAX_BACKLOG_TAGS = 64;
export const MAX_BACKLOG_TAG_CHARS = 256;
export const MAX_BACKLOG_NOTE_CHARS = 1_024;
export const MAX_BACKLOG_ID_CHARS = 128;
/** Keep a bounded, deterministic terminal history while preserving every active item. */
export const MAX_BACKLOG_TERMINAL_ENTRIES = 1_000;
const MAX_BACKLOG_PERSONA_CHARS = 128;
const SAFE_BACKLOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Clamp a user-facing backlog page to a small, finite range. */
export function clampBacklogMax(max: number | undefined): number {
	if (max === undefined || Number.isNaN(max)) return DEFAULT_BACKLOG_MAX;
	if (max === Number.POSITIVE_INFINITY) return MAX_BACKLOG_MAX;
	if (max === Number.NEGATIVE_INFINITY) return 1;
	return Math.max(1, Math.min(MAX_BACKLOG_MAX, Math.floor(max)));
}

export interface BacklogEntry {
	id: string;
	text: string;
	state: BacklogState;
	tags: string[];
	/** Who created it (for the persona view filter). */
	persona?: string;
	createdAt: string;
	/** Optional wake time — a lightweight in-extension alarm re-armed on session start. */
	dueAtEpochMs?: number;
	/** When this lead is deleted from the store. Absent on legacy rows ⇒ createdAt + 48h. */
	expiresAt?: string;
	/** A note attached on done/drop (why). */
	note?: string;
}

export interface BacklogInput {
	text: string;
	tags?: string[];
	persona?: string;
	/** Arm a wake `dueInSeconds` from now. */
	dueInSeconds?: number;
	/** Hours until auto-delete (default 48). A later due time extends life so the wake can still fire. */
	ttlHours?: number;
}

function iso(now: number): string {
	return new Date(now).toISOString();
}

function normTags(tags: readonly string[]): string[] {
	return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}

/** Build a fresh open backlog entry. */
export function makeBacklog(input: BacklogInput, now: number): BacklogEntry {
	const text = input.text.trim();
	const tags = normTags(input.tags ?? []);
	const entry: BacklogEntry = {
		id: contentId("backlog", text, tags),
		text,
		state: "open",
		tags,
		createdAt: iso(now),
	};
	if (input.persona) entry.persona = input.persona;
	const ttlHours = input.ttlHours ?? DEFAULT_BACKLOG_TTL_HOURS;
	let expiresAtMs = now + ttlHours * 3_600_000;
	if (input.dueInSeconds !== undefined) {
		const dueAtMs = now + Math.round(input.dueInSeconds * 1000);
		entry.dueAtEpochMs = dueAtMs;
		if (dueAtMs > expiresAtMs) expiresAtMs = dueAtMs;
	}
	entry.expiresAt = iso(expiresAtMs);
	return entry;
}

/** True once a backlog item has passed its expiry (legacy rows without expiresAt use createdAt + 48h). */
export function isExpired(entry: BacklogEntry, now: number): boolean {
	const expiryMs =
		entry.expiresAt !== undefined
			? Date.parse(entry.expiresAt)
			: Date.parse(entry.createdAt) + DEFAULT_BACKLOG_TTL_HOURS * 3_600_000;
	return Number.isFinite(expiryMs) && now >= expiryMs;
}

/** Drop expired backlog items (any state) so stale leads do not linger on disk. */
export function pruneExpired(entries: readonly BacklogEntry[], now: number): BacklogEntry[] {
	return entries.filter((e) => !isExpired(e, now));
}

export interface TransitionResult {
	ok: boolean;
	entries: BacklogEntry[];
	reason?: "not_found" | "invalid_transition";
}

function legalTransition(from: BacklogState, to: BacklogState): boolean {
	if (from === "taken" && to === "taken") return true; // take is idempotent — the user/model already claimed it
	if (from === "open") return to === "taken" || to === "done" || to === "dropped";
	if (from === "taken") return to === "done" || to === "dropped";
	return false;
}

/** Move one entry (by id) through the legal state machine, optionally attaching a note. */
export function transition(entries: readonly BacklogEntry[], id: string, state: BacklogState, note?: string): TransitionResult {
	const found = entries.find((e) => e.id === id);
	if (!found) return { ok: false, entries: [...entries], reason: "not_found" };
	if (!legalTransition(found.state, state)) return { ok: false, entries: [...entries], reason: "invalid_transition" };
	if (found.state === state) return { ok: true, entries: [...entries] };
	const next = entries.map((e) => {
		if (e.id !== id) return e;
		const updated: BacklogEntry = { ...e, state };
		if (note !== undefined) updated.note = note;
		return updated;
	});
	return { ok: true, entries: next };
}

/** Unfinished work: open + taken (excludes done/dropped). */
export function openItems(entries: readonly BacklogEntry[]): BacklogEntry[] {
	return entries.filter((e) => e.state === "open" || e.state === "taken");
}

/**
 * Compact completed backlog history without ever dropping actionable work.
 *
 * Terminal entries are retained newest-first by creation time, with the id as a deterministic
 * tie-breaker. The returned array keeps the source order so compaction does not perturb the normal
 * backlog ordering; only terminal entries older than the explicit history limit are removed.
 */
export function compactTerminal(entries: readonly BacklogEntry[]): BacklogEntry[] {
	const terminal = entries.filter((entry) => entry.state === "done" || entry.state === "dropped");
	if (terminal.length <= MAX_BACKLOG_TERMINAL_ENTRIES) return [...entries];
	const keep = new Set(
		[...terminal]
			.sort((a, b) => {
				const createdB = Date.parse(b.createdAt);
				const createdA = Date.parse(a.createdAt);
				const created = (Number.isFinite(createdB) ? createdB : 0) - (Number.isFinite(createdA) ? createdA : 0);
				return created !== 0 ? created : b.id.localeCompare(a.id);
			})
			.slice(0, MAX_BACKLOG_TERMINAL_ENTRIES),
	);
	return entries.filter((entry) => entry.state === "open" || entry.state === "taken" || keep.has(entry));
}

/** Deterministic actionable ordering: claimed work, due work, then most recently created. */
export function orderBacklog(entries: readonly BacklogEntry[], now: number): BacklogEntry[] {
	const stateRank = (state: BacklogState): number => (state === "taken" ? 0 : state === "open" ? 1 : state === "done" ? 2 : 3);
	const dueRank = (entry: BacklogEntry): number => {
		if (entry.dueAtEpochMs === undefined) return 2;
		return entry.dueAtEpochMs <= now ? 0 : 1;
	};
	return [...entries].sort((a, b) => {
		const state = stateRank(a.state) - stateRank(b.state);
		if (state !== 0) return state;
		const due = dueRank(a) - dueRank(b);
		if (due !== 0) return due;
		if (a.dueAtEpochMs !== undefined && b.dueAtEpochMs !== undefined) {
			const dueTime = a.dueAtEpochMs - b.dueAtEpochMs;
			if (Number.isFinite(dueTime) && dueTime !== 0) return dueTime;
		}
		const createdA = Date.parse(a.createdAt);
		const createdB = Date.parse(b.createdAt);
		const recency = (Number.isFinite(createdB) ? createdB : 0) - (Number.isFinite(createdA) ? createdA : 0);
		if (recency !== 0) return recency;
		return a.id.localeCompare(b.id);
	});
}

/** The persona's view by default (its own entries); `all` shows every persona's. */
export function viewFor(entries: readonly BacklogEntry[], persona: string, all: boolean): BacklogEntry[] {
	if (all) return [...entries];
	return entries.filter((e) => e.persona === persona);
}

function isState(v: unknown): v is BacklogState {
	return typeof v === "string" && (BACKLOG_STATES as readonly string[]).includes(v);
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Runtime validation for one persisted entry (JsonStore.validateEntry). null ⇒ drop. */
export function validateBacklog(raw: unknown): BacklogEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length > MAX_BACKLOG_ID_CHARS || !SAFE_BACKLOG_ID.test(o.id) || !isState(o.state)) return null;
	if (typeof o.text !== "string" || o.text.length === 0 || o.text.length > MAX_BACKLOG_TEXT_CHARS) return null;
	if (!isStringArray(o.tags) || o.tags.length > MAX_BACKLOG_TAGS || o.tags.some((tag) => tag.length > MAX_BACKLOG_TAG_CHARS)) return null;
	if (typeof o.createdAt !== "string" || !Number.isFinite(Date.parse(o.createdAt))) return null;
	const entry: BacklogEntry = { id: o.id, text: o.text, state: o.state, tags: o.tags, createdAt: o.createdAt };
	if (o.persona !== undefined) {
		if (typeof o.persona !== "string" || o.persona.length === 0 || o.persona.length > MAX_BACKLOG_PERSONA_CHARS) return null;
		entry.persona = o.persona;
	}
	if (o.dueAtEpochMs !== undefined) {
		if (typeof o.dueAtEpochMs !== "number" || !Number.isFinite(o.dueAtEpochMs)) return null;
		entry.dueAtEpochMs = o.dueAtEpochMs;
	}
	if (o.note !== undefined) {
		if (typeof o.note !== "string" || o.note.length > MAX_BACKLOG_NOTE_CHARS) return null;
		entry.note = o.note;
	}
	if (o.expiresAt !== undefined) {
		if (typeof o.expiresAt !== "string" || !Number.isFinite(Date.parse(o.expiresAt))) return null;
		entry.expiresAt = o.expiresAt;
	}
	return entry;
}
