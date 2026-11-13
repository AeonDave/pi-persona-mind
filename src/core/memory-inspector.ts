import type { MemoryEntry } from "./memory.ts";
import { replaySessionNotes, SESSION_NOTE_ENTRY_TYPE } from "./session-memory.ts";

export const MAX_INSPECTOR_BRANCH_ENTRIES = 2_000;
export const INSPECTOR_PAGE_SIZE = 40;
export const MAX_INSPECTOR_MESSAGE_CHARS = 32_000;

export interface InspectorTimelineItem { id: string; title: string; body: string; timestamp: string; source?: { title: string; body: string } }
export interface InspectorTimelinePage { items: InspectorTimelineItem[]; total: number; offset: number; nextOffset?: number; omittedOlder: number; notice: string }
export interface InspectorTimelineOptions { query: string; offset: number }

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function clipped(text: string, max = MAX_INSPECTOR_MESSAGE_CHARS): string {
	const marker = "… [clipped at 32000 chars]";
	if (text.length <= max) return text;
	const cap = Math.max(0, max - marker.length);
	return `${text.slice(0, cap)}${marker}`;
}
function visibleText(content: unknown, max = MAX_INSPECTOR_MESSAGE_CHARS): string {
	if (typeof content === "string") return clipped(content, max);
	if (!Array.isArray(content)) return "";
	const parts = content.flatMap((part) => {
		const item = record(part);
		return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
	});
	return clipped(parts.join("\n"), max);
}
function callParams(call: unknown): Record<string, unknown> | undefined {
	const item = record(call);
	if (!item) return undefined;
	const args = item.arguments ?? item.params;
	return record(args);
}
function normalizedTags(value: unknown): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) return undefined;
	return [...new Set(value.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
}
export interface InspectorRecordingOwner { persona: string; projectRoot: string }
export function findMemoryRecordingSource(memory: MemoryEntry, branch: readonly unknown[], target: "project" | "project-long" | "persona" | "shared", owner: InspectorRecordingOwner): InspectorTimelineItem["source"] {
	for (let index = 0; index < branch.length; index++) {
		const raw = record(branch[index]);
		const message = record(raw?.message);
		if (raw?.type !== "message" || message?.role !== "assistant") continue;
		const calls = Array.isArray(message.toolCalls) ? message.toolCalls : Array.isArray(message.content) ? message.content.filter((part) => record(part)?.type === "toolCall") : [];
		for (const rawCall of calls) {
			const call = record(rawCall);
			const params = callParams(rawCall);
			if (!call || call.name !== "memory" || typeof call.id !== "string" || !params || params.action !== "remember" || params.term === "session") continue;
			const expectedTerm = target === "project" ? "short" : "long";
			const scope = target === "project-long" ? "project" : target;
			if (params.term !== expectedTerm || params.scope !== undefined && params.scope !== scope || (expectedTerm === "long" && params.scope !== scope) || params.kind !== memory.kind || typeof params.text !== "string" || params.text.trim() !== memory.text || JSON.stringify(normalizedTags(params.tags)) !== JSON.stringify(memory.tags)) continue;
			for (let resultIndex = index + 1; resultIndex < branch.length; resultIndex++) {
				const resultRaw = record(branch[resultIndex]);
				const result = record(resultRaw?.message);
				if (result?.role !== "toolResult" || result.toolCallId !== call.id || result.toolName !== "memory") continue;
				if (result.isError !== false) break;
				const output = visibleText(result.content);
				const resultDetails = record(result.details);
				const recording = record(resultDetails?.recording);
				const exactRecording = resultDetails?.ok === true && recording?.version === 1 && recording.target === target && recording.persona === owner.persona && (target === "project" || target === "project-long" ? recording.projectRoot === owner.projectRoot : true);
				const expectedReceipt = `Remembered ${memory.id} — ${expectedTerm}-term ${memory.kind} in ${scope} scope.`;
				if (exactRecording && output.trim().startsWith(expectedReceipt)) {
					const callText = JSON.stringify({ tool: "memory", toolCallId: call.id, action: params.action, term: params.term, scope, kind: params.kind, text: params.text, tags: params.tags ?? [] });
					const recordingText = JSON.stringify(recording);
					return { title: "Recording context (not truth evidence)", body: `Active branch assistant entry ${String(raw.id)}; matching memory toolCall ${call.id}; successful toolResult entry ${String(resultRaw?.id)}. Recording call summary (selected fields): ${clipped(callText)}. Matched native result recording metadata: ${clipped(recordingText)}. Exact successful result text: ${clipped(output)} This is recording context, not proof of factual truth.` };
				}
				break;
			}
		}
	}
	return undefined;
}
export function findSessionNoteRecordingSource(note: { id: string; kind: string; text: string; recordedAt: string; originSessionId: string; source?: string }, branch: readonly unknown[], noteHistory: readonly unknown[]): InspectorTimelineItem["source"] {
	const examined = branch.slice(-MAX_INSPECTOR_BRANCH_ENTRIES);
	const events = examined.flatMap((raw) => {
		const entry = record(raw);
		return entry?.type === "custom" && entry.customType === SESSION_NOTE_ENTRY_TYPE ? [entry.data] : [];
	});
	const replay = replaySessionNotes(events, noteHistory);
	if (replay.error || !replay.notes.some((current) => current.id === note.id && current.kind === note.kind && current.text === note.text && current.recordedAt === note.recordedAt && current.originSessionId === note.originSessionId && current.source === note.source)) return undefined;
	for (let index = examined.length - 1; index >= 0; index--) {
		const entry = record(examined[index]);
		if (entry?.type !== "custom" || entry.customType !== SESSION_NOTE_ENTRY_TYPE) continue;
		const event = record(entry.data);
		const saved = record(event?.note);
		if (event?.version === 1 && event.op === "save" && saved?.id === note.id && saved.kind === note.kind && saved.text === note.text && saved.recordedAt === note.recordedAt && saved.originSessionId === note.originSessionId && saved.source === note.source) {
			return { title: "Validated active-branch save event", body: `Native custom entry ${String(entry.id)} (${SESSION_NOTE_ENTRY_TYPE}), event save, note id ${note.id}. Exact validated saved text: ${clipped(note.text)}${note.source === undefined ? "" : `; literal source metadata: ${clipped(note.source)}`}. Recording context only, not proof of factual truth.` };
		}
	}
	return undefined;
}

export function buildInspectorTimeline(branchInput: readonly unknown[], noteHistory: readonly unknown[], options: InspectorTimelineOptions): InspectorTimelinePage {
	const examined = branchInput.slice(-MAX_INSPECTOR_BRANCH_ENTRIES);
	const omittedOlder = Math.max(0, branchInput.length - examined.length);
	const noteData: unknown[] = [];
	for (const raw of examined) {
		const entry = record(raw);
		if (entry?.type === "custom" && entry.customType === SESSION_NOTE_ENTRY_TYPE) noteData.push(entry.data);
	}
	const replay = replaySessionNotes(noteData, noteHistory);
	const items: InspectorTimelineItem[] = [];
	const itemOrders = new Map<InspectorTimelineItem, number>();
	const addItem = (item: InspectorTimelineItem, order: number): void => { items.push(item); itemOrders.set(item, order); };
	for (let index = 0; index < examined.length; index++) {
		const raw = record(examined[index]);
		if (!raw || typeof raw.id !== "string" || typeof raw.timestamp !== "string") continue;
		if (raw.type === "message") {
			const message = record(raw.message);
			if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
			const body = visibleText(message.content);
			if (!body || !Number.isFinite(Date.parse(raw.timestamp))) continue;
			const role = message.role === "user" ? "User" : "Assistant";
			const preview = body.replace(/\s+/g, " ").trim();
			const shortPreview = preview.length > 120 ? `${preview.slice(0, 119)}…` : preview;
			const metadata = `timestamp: ${raw.timestamp}\nrole: ${role.toLowerCase()}\nentry id: ${raw.id}`;
			const detail = visibleText(message.content, Math.max(0, MAX_INSPECTOR_MESSAGE_CHARS - metadata.length - 2));
			addItem({ id: raw.id, title: `${raw.timestamp} · ${role} · ${shortPreview}`, body: `${metadata}\n\n${detail}`, timestamp: raw.timestamp }, index);
		} else if (raw.type === "custom" && raw.customType === SESSION_NOTE_ENTRY_TYPE && !replay.error) {
			const data = record(raw.data);
			if (!data || data.version !== 1) continue;
			if (data.op === "save") {
				const note = record(data.note);
				if (!note || typeof note.id !== "string" || typeof note.text !== "string") continue;
				const validated = replay.notes.find((active) => active.id === note.id &&
					active.kind === note.kind && active.text === note.text && active.recordedAt === note.recordedAt &&
					active.originSessionId === note.originSessionId && active.source === note.source);
				const source = validated ? findSessionNoteRecordingSource(validated, examined, noteHistory) : undefined;
				if (!Number.isFinite(Date.parse(raw.timestamp))) continue;
				const noteBody = [`timestamp: ${raw.timestamp}`, "role: session note", `entry id: ${raw.id}`, `note id: ${note.id}`, `kind: ${String(note.kind)}`, `recorded: ${String(note.recordedAt)}`, `origin session id: ${String(note.originSessionId)}`, `text: ${clipped(note.text)}`].join("\n");
				const preview = note.text.replace(/\s+/g, " ").trim();
				const shortPreview = preview.length > 120 ? `${preview.slice(0, 119)}…` : preview;
				addItem({ id: raw.id, title: `${raw.timestamp} · Session note saved · ${shortPreview}`, body: `${noteBody}${source ? "" : "\nNo resolvable recording in this active-branch window."}`, timestamp: raw.timestamp, ...(source ? { source } : {}) }, index);
			} else if (data.op === "forget" && typeof data.id === "string") {
				if (!Number.isFinite(Date.parse(raw.timestamp))) continue;
				addItem({ id: raw.id, title: `${raw.timestamp} · Session note forgotten · ${data.id}`, body: `timestamp: ${raw.timestamp}\nrole: session note tombstone\nentry id: ${raw.id}\nnote id: ${data.id}\nEarlier transcript bytes remain.`, timestamp: raw.timestamp }, index);
			}
		}
	}
	const sorted = items.sort((a, b) => itemOrders.get(b)! - itemOrders.get(a)!);
	const query = options.query.trim().toLowerCase();
	const matched = sorted.filter((item) => !query || `${item.title} ${item.body} ${item.source?.title ?? ""} ${item.source?.body ?? ""}`.toLowerCase().includes(query));
	const offset = Number.isSafeInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
	const page = matched.slice(offset, offset + INSPECTOR_PAGE_SIZE);
	return { items: page, total: matched.length, offset, ...(offset + page.length < matched.length ? { nextOffset: offset + page.length } : {}), omittedOlder, notice: `Timeline and recording-source lookup cover at most the newest ${MAX_INSPECTOR_BRANCH_ENTRIES} native active-branch entries; ${omittedOlder} older native entries omitted. Counts and search matches apply only to this bounded window and searchable text excerpts are clipped to ${MAX_INSPECTOR_MESSAGE_CHARS} characters per message. Native branch order is used; timestamps are display-only. Source links are recording context, not proof of truth.` };
}
