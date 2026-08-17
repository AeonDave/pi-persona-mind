/**
 * The memory faculty — pure domain logic, no I/O.
 *
 * Two temporal tiers share this one entry shape:
 *   - LONG-TERM  (identity): durable, persona-scoped, never expires. Who a persona is for this user.
 *   - SHORT-TERM (working context): project-scoped, carries an `expiresAt`, decays on its own.
 * The tier is not stored on the entry — it is implied by which file the entry lives in (LTM vs STM)
 * and by whether it has an `expiresAt`. This module builds, validates, dedups/supersedes, decays,
 * and ranks entries; rendering lives in inject.ts, persistence in store.ts.
 */

import { compatibleContentIds, contentId } from "./ids.ts";

export const MEMORY_KINDS = ["objective", "invariant", "preference", "convention", "gotcha", "rationale", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryTerm = "long" | "short";

/** Default life of a short-term memory before it decays out of view. */
export const DEFAULT_TTL_HOURS = 48;
export const DEFAULT_RECALL_MAX = 8;
export const MAX_RECALL_MAX = 50;
export const MAX_RECALL_QUERY_CHARS = 512;
export const MAX_MEMORY_TEXT_CHARS = 8_192;
export const MAX_MEMORY_TAGS = 64;
export const MAX_MEMORY_TAG_CHARS = 256;
export const MAX_MEMORY_SOURCE_CHARS = 1_024;
export const MAX_MEMORY_DERIVED_IDS = 64;
export const MAX_MEMORY_ID_CHARS = 128;
const MAX_MEMORY_PERSONA_CHARS = 128;
const SAFE_MEMORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** IDs are echoed by tools and may arrive from migrated/out-of-band stores; keep them one safe token. */
export function isMemoryId(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_MEMORY_ID_CHARS && SAFE_MEMORY_ID.test(value);
}

/** Clamp a user-facing recall page to a small, finite range. */
export function clampRecallMax(max: number | undefined): number {
	if (max === undefined || Number.isNaN(max)) return DEFAULT_RECALL_MAX;
	if (max === Number.POSITIVE_INFINITY) return MAX_RECALL_MAX;
	if (max === Number.NEGATIVE_INFINITY) return 1;
	return Math.max(1, Math.min(MAX_RECALL_MAX, Math.floor(max)));
}

/** Flatten and fence text before putting a persisted entry in a tool result. */
export function compactMemoryText(text: string, cap = 240): string {
	const safeCap = Number.isFinite(cap) && cap >= 2 ? Math.floor(cap) : 240;
	const flat = text
		.replace(/<\/?persona-mind\b[^>]*>/gi, "[persona-mind]")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > safeCap ? `${flat.slice(0, safeCap - 1)}…` : flat;
}

export interface MemoryEntry {
	/** Content-addressed (kind + text + tags): re-recording the same fact updates in place. */
	id: string;
	kind: MemoryKind;
	text: string;
	tags: string[];
	recordedAt: string;
	/** Bumped when the fact is re-recorded or promoted; reads stay write-free. */
	lastSeenAt: string;
	/** The id this entry retires (kept as lineage; the retired entry is removed from the active set). */
	supersedes?: string;
	/** Who recorded it (owning persona, or a child agent handle). Mainly meaningful for short-term. */
	persona?: string;
	/** Short-term only: recordedAt + ttl. Absent ⇒ long-term / durable. */
	expiresAt?: string;
	/** Optional human-citable origin ("session 3", "child scout"). NOT part of the content id. */
	source?: string;
	/** Optional ids of the entries this fact was distilled from (an intra-store citation graph). */
	derivedFrom?: string[];
}

export interface MemoryInput {
	term: MemoryTerm;
	kind: MemoryKind;
	text: string;
	tags?: string[];
	/** Short-term only; defaults to {@link DEFAULT_TTL_HOURS}. */
	ttlHours?: number;
	supersedes?: string;
	persona?: string;
	source?: string;
	derivedFrom?: string[];
}

function normalizeText(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeTags(tags: readonly string[]): string[] {
	return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}

/** Semantic equality deliberately ignores historical ID encoding and presentation noise. */
export function memoryContentKey(entry: Pick<MemoryEntry, "kind" | "text" | "tags">): string {
	return JSON.stringify([entry.kind, normalizeText(entry.text), normalizeTags(entry.tags)]);
}

export function sameMemoryContent(a: MemoryEntry, b: MemoryEntry): boolean {
	return memoryContentKey(a) === memoryContentKey(b);
}

/** True when an id can address this entry under either the current or migrated encoding. */
export function memoryIdMatches(entry: MemoryEntry, id: string): boolean {
	return entry.id === id || compatibleContentIds(entry.kind, entry.text, entry.tags).includes(id);
}

function iso(now: number): string {
	return new Date(now).toISOString();
}

function normTags(tags: readonly string[]): string[] {
	return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}

/** Build a memory entry. Long term ⇒ durable; short term ⇒ carries an expiry. */
export function makeMemory(input: MemoryInput, now: number): MemoryEntry {
	const text = input.text.trim();
	const tags = normTags(input.tags ?? []);
	const entry: MemoryEntry = {
		id: contentId(input.kind, text, tags),
		kind: input.kind,
		text,
		tags,
		recordedAt: iso(now),
		lastSeenAt: iso(now),
	};
	if (input.term === "short") {
		const ttl = input.ttlHours ?? DEFAULT_TTL_HOURS;
		entry.expiresAt = iso(now + ttl * 3_600_000);
	}
	if (input.supersedes) entry.supersedes = input.supersedes;
	if (input.persona) entry.persona = input.persona;
	if (input.source) entry.source = input.source;
	if (input.derivedFrom && input.derivedFrom.length > 0) entry.derivedFrom = [...input.derivedFrom];
	return entry;
}

/** Graduate a short-term entry into durable long-term: drop expiry + persona tag, keep id/age. */
export function promoteToLong(entry: MemoryEntry, now: number): MemoryEntry {
	const promoted: MemoryEntry = {
		id: entry.id,
		kind: entry.kind,
		text: entry.text,
		tags: entry.tags,
		recordedAt: entry.recordedAt,
		lastSeenAt: iso(now),
	};
	if (entry.supersedes) promoted.supersedes = entry.supersedes;
	if (entry.source) promoted.source = entry.source;
	if (entry.derivedFrom) promoted.derivedFrom = entry.derivedFrom;
	return promoted;
}

/** True once a short-term entry has passed its expiry. Long-term entries never expire. */
export function isExpired(entry: MemoryEntry, now: number): boolean {
	return entry.expiresAt !== undefined && now >= Date.parse(entry.expiresAt);
}

/** Drop expired short-term entries; keep everything else. */
export function pruneExpired(entries: readonly MemoryEntry[], now: number): MemoryEntry[] {
	return entries.filter((e) => !isExpired(e, now));
}

/** A short-term entry that is still live but within `windowMs` of expiring — flag it "verify". */
export function nearExpiry(entry: MemoryEntry, now: number, windowMs: number): boolean {
	if (entry.expiresAt === undefined || isExpired(entry, now)) return false;
	return Date.parse(entry.expiresAt) - now <= windowMs;
}

export interface SupersedeTargets {
	/** The entries the id may retire — empty when it addresses nothing, or more than one fact. */
	targets: MemoryEntry[];
	/** The id names two or more semantically distinct facts, so it cannot pick between them. */
	ambiguous: boolean;
}

/**
 * Which entries a `supersedes` id is allowed to retire. Ids are matched across the v1/v2 encodings
 * (see {@link memoryIdMatches}), so one historical handle can name several distinct facts — the v1
 * comma-join erased the tag boundary. When it does, NOTHING is retired: this is the same refusal the
 * delete path makes (`MindService.forget` → `ambiguous_id`), for the same reason — a shared handle is
 * no evidence about which fact the caller meant, and guessing destroys a durable memory.
 */
export function supersedeTargets(entries: readonly MemoryEntry[], id: string): SupersedeTargets {
	const targets = entries.filter((e) => memoryIdMatches(e, id));
	const distinct = new Set(targets.map((e) => memoryContentKey(e)));
	return distinct.size > 1 ? { targets: [], ambiguous: true } : { targets, ambiguous: false };
}

/**
 * Insert `entry`, deduping by content id (an update-in-place that preserves the original
 * `recordedAt` and bumps `lastSeenAt`) and retiring the entry named by `entry.supersedes` — unless
 * that id is ambiguous, in which case it retires nothing (see {@link supersedeTargets}).
 */
export function upsertMemory(entries: readonly MemoryEntry[], entry: MemoryEntry): MemoryEntry[] {
	const key = memoryContentKey(entry);
	const existing = entries.find((e) => memoryContentKey(e) === key);
	const merged: MemoryEntry = existing
		? { ...entry, id: existing.id, recordedAt: existing.recordedAt, lastSeenAt: entry.recordedAt }
		: entry;
	// Retire the previous copy under the SAME semantic key it was found by, never by its id: an id
	// carried over from a migrated store can be shared with an unrelated fact, and dropping every
	// entry holding it would erase that fact too.
	const retired = new Set(entry.supersedes ? supersedeTargets(entries, entry.supersedes).targets : []);
	return [...entries.filter((e) => memoryContentKey(e) !== key && !retired.has(e)), merged];
}

export interface RecallOptions {
	max: number;
}

function queryTerms(query: string): string[] {
	return query.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
}

function haystack(e: MemoryEntry): string {
	return `${e.text} ${e.tags.join(" ")}`.toLowerCase();
}

/**
 * Keyword + recency recall (pure). With a query, returns only entries matching ≥1 term, ranked by
 * match count then recency. Without a query, returns the most-recent entries. Always budget-limited.
 */
export function recall(entries: readonly MemoryEntry[], query: string, _now: number, opts: RecallOptions): MemoryEntry[] {
	const terms = queryTerms(query);
	const byRecency = (a: MemoryEntry, b: MemoryEntry): number => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
	if (terms.length === 0) {
		return [...entries].sort(byRecency).slice(0, opts.max);
	}
	const scored = entries
		.map((e) => {
			const hay = haystack(e);
			const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
			return { e, score };
		})
		.filter((x) => x.score > 0);
	scored.sort((a, b) => b.score - a.score || byRecency(a.e, b.e));
	return scored.slice(0, opts.max).map((x) => x.e);
}

/**
 * A COARSE, prompt-cache-stable age label: "today", "2d", "3w", "5mo", "1y".
 *
 * The injected `<persona-mind>` block is folded into the system prompt every turn. A minute/hour
 * granular age ("29m" → "30m" a minute later) would mutate that block every minute and bust provider
 * prompt-caching of the whole system prefix — for zero real signal, since a durable memory is not a
 * log line and never needed sub-day precision. So the entire sub-day range collapses to ONE stable
 * bucket ("today") and the rest steps at day granularity or coarser: the label now flips at most
 * once per day, keeping the block byte-identical across a working session's turns.
 */
export function ageLabel(recordedAt: string, now: number): string {
	const days = Math.floor(Math.max(0, now - Date.parse(recordedAt)) / 86_400_000);
	if (!Number.isFinite(days)) return "?"; // corrupt/unparseable timestamp — never render "NaN…"
	if (days < 1) return "today";
	if (days < 14) return `${days}d`; // day granularity where recency is load-bearing
	if (days < 60) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

function isKind(v: unknown): v is MemoryKind {
	return typeof v === "string" && (MEMORY_KINDS as readonly string[]).includes(v);
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isBoundedStringArray(v: unknown, maxItems: number, maxChars: number): v is string[] {
	return isStringArray(v) && v.length <= maxItems && v.every((value) => value.length <= maxChars);
}

/** A persisted timestamp must be a non-empty string understood by the platform date parser. */
export function isValidTimestamp(v: unknown): v is string {
	return typeof v === "string" && v.length > 0 && Number.isFinite(Date.parse(v));
}

/** Runtime validation for one persisted entry (used as JsonStore.validateEntry). null ⇒ drop. */
export function validateMemory(raw: unknown): MemoryEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (!isMemoryId(o.id) || !isKind(o.kind)) return null;
	if (typeof o.text !== "string" || o.text.length === 0 || o.text.length > MAX_MEMORY_TEXT_CHARS) return null;
	if (!isBoundedStringArray(o.tags, MAX_MEMORY_TAGS, MAX_MEMORY_TAG_CHARS) || !isValidTimestamp(o.recordedAt) || !isValidTimestamp(o.lastSeenAt)) return null;
	const entry: MemoryEntry = { id: o.id, kind: o.kind, text: o.text, tags: o.tags, recordedAt: o.recordedAt, lastSeenAt: o.lastSeenAt };
	if (o.supersedes !== undefined) {
		if (!isMemoryId(o.supersedes)) return null;
		entry.supersedes = o.supersedes;
	}
	if (o.persona !== undefined) {
		if (typeof o.persona !== "string" || o.persona.length === 0 || o.persona.length > MAX_MEMORY_PERSONA_CHARS) return null;
		entry.persona = o.persona;
	}
	if (o.expiresAt !== undefined) {
		if (!isValidTimestamp(o.expiresAt)) return null;
		entry.expiresAt = o.expiresAt;
	}
	if (o.source !== undefined) {
		if (typeof o.source !== "string" || o.source.length > MAX_MEMORY_SOURCE_CHARS) return null;
		entry.source = o.source;
	}
	if (o.derivedFrom !== undefined) {
		if (!isBoundedStringArray(o.derivedFrom, MAX_MEMORY_DERIVED_IDS, MAX_MEMORY_ID_CHARS) || o.derivedFrom.some((id) => !isMemoryId(id))) return null;
		entry.derivedFrom = o.derivedFrom;
	}
	return entry;
}

/** Validator for the durable tier: an LTM record must not carry short-term expiry metadata. */
export function validateLongMemory(raw: unknown): MemoryEntry | null {
	const entry = validateMemory(raw);
	return entry && entry.expiresAt === undefined ? entry : null;
}

/** Validator for the working tier: an STM record must carry a valid expiry timestamp. */
export function validateShortMemory(raw: unknown): MemoryEntry | null {
	const entry = validateMemory(raw);
	return entry && entry.expiresAt !== undefined ? entry : null;
}
