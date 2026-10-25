import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MAX_SESSION_NOTE_CHARS, SESSION_MEMORY_KINDS, SESSION_NOTE_ENTRY_TYPE, MAX_SESSION_SOURCE_CHARS } from "../core/session-memory.ts";
import { renderExpandableCard } from "./presentation.ts";

interface SessionNoteCardModel {
	title: string;
	body: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sessionNoteCardModel(value: unknown): SessionNoteCardModel | undefined {
	const event = record(value);
	if (event?.version !== 1) return undefined;
	if (event.op === "forget" && typeof event.id === "string" && event.id.startsWith("session:")) {
		return { title: "Session note retired", body: `${event.id}\nNo longer active on this branch.` };
	}
	if (event.op !== "save") return undefined;
	const note = record(event.note);
	if (!note || typeof note.id !== "string" || !note.id.startsWith("session:") ||
		typeof note.kind !== "string" || !(SESSION_MEMORY_KINDS as readonly string[]).includes(note.kind) ||
		typeof note.text !== "string" || note.text.length === 0 || note.text.length > MAX_SESSION_NOTE_CHARS ||
		typeof note.recordedAt !== "string" || !Number.isFinite(Date.parse(note.recordedAt)) ||
		typeof note.originSessionId !== "string" || note.originSessionId.length === 0 || note.originSessionId.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(note.originSessionId) ||
		(note.source !== undefined && (typeof note.source !== "string" || note.source.length > MAX_SESSION_SOURCE_CHARS))) {
		return undefined;
	}
	return {
		title: `Session note · ${note.kind}`,
		body: [
			`id: ${note.id}`,
			`recorded: ${note.recordedAt}`,
			`origin session: ${note.originSessionId} (provenance only; not auto-resolved)`,
			note.source === undefined ? "" : `source: ${note.source}`,
			"",
		note.text,
		].filter((line) => line !== "").join("\n"),
	};
}

/** Register a semantic standalone card for session-note save and forget events. */
export function registerSessionNoteRenderer(pi: Pick<ExtensionAPI, "registerEntryRenderer">): void {
	pi.registerEntryRenderer<unknown>(SESSION_NOTE_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const model = sessionNoteCardModel(entry.data);
		return model ? renderExpandableCard(model.title, model.body, expanded, theme) : undefined;
	});
}
