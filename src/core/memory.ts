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

import { contentId } from "./ids.ts";

export const MEMORY_KINDS = ["objective", "invariant", "preference", "convention", "gotcha", "rationale", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryTerm = "long" | "short";

/** Default life of a short-term memory before it decays out of view. */
export const DEFAULT_TTL_HOURS = 48;

export interface MemoryEntry {
	/** Content-addressed (kind + text + tags): re-recording the same fact updates in place. */
	id: string;
	kind: MemoryKind;
	text: string;
	tags: string[];
	recordedAt: string;
	/** Bumped on recall/injection — drives recency ranking. */
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

/**
 * Insert `entry`, deduping by content id (an update-in-place that preserves the original
 * `recordedAt` and bumps `lastSeenAt`) and retiring any entry named by `entry.supersedes`.
 */
export function upsertMemory(entries: readonly MemoryEntry[], entry: MemoryEntry): MemoryEntry[] {
	const existing = entries.find((e) => e.id === entry.id);
	const merged: MemoryEntry = existing
		? { ...entry, recordedAt: existing.recordedAt, lastSeenAt: entry.recordedAt }
		: entry;
	return [...entries.filter((e) => e.id !== entry.id && e.id !== entry.supersedes), merged];
}

/** Mark entries as seen now (bumps lastSeenAt) — returns a new array, never mutates the input. */
export function touch(entries: readonly MemoryEntry[], ids: ReadonlySet<string>, now: number): MemoryEntry[] {
	if (ids.size === 0) return [...entries];
	return entries.map((e) => (ids.has(e.id) ? { ...e, lastSeenAt: iso(now) } : e));
}

export interface RecallOptions {
	max: number;
}

function queryTerms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 0);
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

/** Runtime validation for one persisted entry (used as JsonStore.validateEntry). null ⇒ drop. */
export function validateMemory(raw: unknown): MemoryEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== "string" || !isKind(o.kind) || typeof o.text !== "string") return null;
	if (!isStringArray(o.tags) || typeof o.recordedAt !== "string" || typeof o.lastSeenAt !== "string") return null;
	const entry: MemoryEntry = { id: o.id, kind: o.kind, text: o.text, tags: o.tags, recordedAt: o.recordedAt, lastSeenAt: o.lastSeenAt };
	if (typeof o.supersedes === "string") entry.supersedes = o.supersedes;
	if (typeof o.persona === "string") entry.persona = o.persona;
	if (typeof o.expiresAt === "string") entry.expiresAt = o.expiresAt;
	if (typeof o.source === "string") entry.source = o.source;
	if (isStringArray(o.derivedFrom)) entry.derivedFrom = o.derivedFrom;
	return entry;
}
