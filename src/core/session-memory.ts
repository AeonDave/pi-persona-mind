export const SESSION_NOTE_ENTRY_TYPE = "pi-persona-mind-session-note";
export const MAX_SESSION_NOTE_CHARS = 8_000;

import { MEMORY_KINDS, type MemoryKind } from "./memory.ts";
import { scanContent } from "./scanner.ts";

export const MAX_SESSION_NOTES = 64;
export const MAX_SESSION_NOTE_EVENTS = 256;
export const MAX_SESSION_NOTE_BYTES = 512 * 1024;
export const MAX_SESSION_SOURCE_CHARS = 1_000;
export interface SessionNoteInput { kind: MemoryKind; text: string; source?: string }
export interface SessionNote extends SessionNoteInput { id: string; recordedAt: string; originSessionId: string }
export type SessionNoteEvent = { version: 1; op: "save"; note: SessionNote } | { version: 1; op: "forget"; id: string };
export interface SessionReplay { notes: SessionNote[]; events: number; bytes: number; error?: string }
export const SESSION_MEMORY_KINDS = MEMORY_KINDS;
const KINDS: ReadonlySet<string> = new Set(SESSION_MEMORY_KINDS);
const ID = /^session:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The scanner is applied on admission and replay; provenance is data too. */
export function sessionNoteError(input: SessionNoteInput): string | undefined {
	if (!KINDS.has(input.kind)) return "invalid session note kind";
	if (typeof input.text !== "string" || !input.text.trim() || input.text.length > MAX_SESSION_NOTE_CHARS) return `session note text must contain 1..${MAX_SESSION_NOTE_CHARS} characters`;
	if (input.source !== undefined && (typeof input.source !== "string" || input.source.length > MAX_SESSION_SOURCE_CHARS)) return `session note source exceeds ${MAX_SESSION_SOURCE_CHARS} characters`;
	for (const text of [input.text, input.source]) {
		if (text === undefined) continue;
		const scanned = scanContent(text);
		if (!scanned.ok) return `session note rejected: ${scanned.reason ?? "content policy"}`;
	}
	return undefined;
}

function parseEvent(value: unknown): SessionNoteEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.version !== 1) return undefined;
	if (record.op === "forget") return typeof record.id === "string" && ID.test(record.id) ? { version: 1, op: "forget", id: record.id } : undefined;
	if (record.op !== "save" || !record.note || typeof record.note !== "object" || Array.isArray(record.note)) return undefined;
	const note = record.note as SessionNote;
	if (typeof note.id !== "string" || !ID.test(note.id) || typeof note.recordedAt !== "string" || !Number.isFinite(Date.parse(note.recordedAt)) || typeof note.originSessionId !== "string" || !note.originSessionId || note.originSessionId.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(note.originSessionId) || sessionNoteError(note)) return undefined;
	return { version: 1, op: "save", note: { id: note.id, kind: note.kind, text: note.text, recordedAt: note.recordedAt, originSessionId: note.originSessionId, ...(note.source === undefined ? {} : { source: note.source }) } };
}

/** All history owns the lifetime budget; only the selected branch owns visible notes. */
export function replaySessionNotes(branch: readonly unknown[], history: readonly unknown[]): SessionReplay {
	let bytes = 0;
	try {
		for (const value of history) {
			const encoded = JSON.stringify(value);
			if (encoded === undefined) return { notes: [], events: history.length, bytes, error: "unaccountable session note history" };
			bytes += new TextEncoder().encode(encoded).length;
			if (!parseEvent(value)) return { notes: [], events: history.length, bytes, error: "unsupported or unsafe session note history" };
		}
	} catch { return { notes: [], events: history.length, bytes, error: "unaccountable session note history" }; }
	if (history.length > MAX_SESSION_NOTE_EVENTS || bytes > MAX_SESSION_NOTE_BYTES) return { notes: [], events: history.length, bytes, error: "session note history exceeds its lifetime budget" };
	const active = new Map<string, SessionNote>();
	for (const value of branch) {
		const event = parseEvent(value);
		if (!event) return { notes: [], events: history.length, bytes, error: "unsupported or unsafe session note branch" };
		if (event.op === "forget") active.delete(event.id);
		else {
			if (active.has(event.note.id)) return { notes: [], events: history.length, bytes, error: "duplicate session note identity" };
			active.set(event.note.id, event.note);
		}
	}
	if (active.size > MAX_SESSION_NOTES) return { notes: [], events: history.length, bytes, error: "session note count exceeds its limit" };
	return { notes: [...active.values()], events: history.length, bytes };
}

export function sessionEventFits(state: SessionReplay, event: SessionNoteEvent): boolean {
	return state.events < MAX_SESSION_NOTE_EVENTS && state.bytes + new TextEncoder().encode(JSON.stringify(event)).length <= MAX_SESSION_NOTE_BYTES;
}
