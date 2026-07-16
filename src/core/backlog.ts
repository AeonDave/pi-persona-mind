/**
 * The backlog faculty — pure domain logic, no I/O.
 *
 * A backlog entry is a DEFERRED INTENT: a lead or task the supervisor means to act on but has not
 * yet. Unlike short-term memory it does NOT decay — an intent is completed (`done`) or abandoned
 * (`dropped`), never silently lost to a timeout or a persona switch (which would drop a real lead).
 * Contents are project-scoped; the `persona` field is who created it, used only for the view filter.
 */

import { contentId } from "./ids.ts";

export const BACKLOG_STATES = ["open", "taken", "done", "dropped"] as const;
export type BacklogState = (typeof BACKLOG_STATES)[number];

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
	/** A note attached on done/drop (why). */
	note?: string;
}

export interface BacklogInput {
	text: string;
	tags?: string[];
	persona?: string;
	/** Arm a wake `dueInSeconds` from now. */
	dueInSeconds?: number;
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
	if (input.dueInSeconds !== undefined) entry.dueAtEpochMs = now + Math.round(input.dueInSeconds * 1000);
	return entry;
}

export interface TransitionResult {
	ok: boolean;
	entries: BacklogEntry[];
}

/** Move one entry (by id) to a new state, optionally attaching a note. ok=false ⇒ id not found. */
export function transition(entries: readonly BacklogEntry[], id: string, state: BacklogState, note?: string): TransitionResult {
	let found = false;
	const next = entries.map((e) => {
		if (e.id !== id) return e;
		found = true;
		const updated: BacklogEntry = { ...e, state };
		if (note !== undefined) updated.note = note;
		return updated;
	});
	return { ok: found, entries: next };
}

/** Unfinished work: open + taken (excludes done/dropped). */
export function openItems(entries: readonly BacklogEntry[]): BacklogEntry[] {
	return entries.filter((e) => e.state === "open" || e.state === "taken");
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
	if (typeof o.id !== "string" || typeof o.text !== "string" || !isState(o.state)) return null;
	if (!isStringArray(o.tags) || typeof o.createdAt !== "string") return null;
	const entry: BacklogEntry = { id: o.id, text: o.text, state: o.state, tags: o.tags, createdAt: o.createdAt };
	if (typeof o.persona === "string") entry.persona = o.persona;
	if (typeof o.dueAtEpochMs === "number") entry.dueAtEpochMs = o.dueAtEpochMs;
	if (typeof o.note === "string") entry.note = o.note;
	return entry;
}
