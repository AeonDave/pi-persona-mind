import assert from "node:assert/strict";
import test from "node:test";
import { buildInspectorTimeline, findMemoryRecordingSource, findSessionNoteRecordingSource, MAX_INSPECTOR_BRANCH_ENTRIES } from "../src/core/memory-inspector.ts";

const entry = (id: string, role: string, content: unknown, timestamp = "2026-01-01T00:00:00.000Z") => ({ type: "message", id, parentId: null, timestamp, message: { role, content } });

test("timeline reads only plain user/assistant text and active-branch entries", () => {
	const rows = buildInspectorTimeline([
		entry("u", "user", "needle user"),
		entry("a", "assistant", [{ type: "text", text: "needle answer" }, { type: "thinking", thinking: "needle secret" }, { type: "image", data: "x" }]),
		entry("tool", "toolResult", "needle tool output"),
		entry("system", "system", "needle system"),
		{ type: "custom_message", customType: "foreign", content: "needle foreign" },
	], [], { query: "needle", offset: 0 });
	assert.match(rows.items[0]!.title, /^2026-01-01T00:00:00.000Z · Assistant · needle answer$/);
	assert.match(rows.items[0]!.body, /timestamp: 2026-01-01T00:00:00.000Z/);
	assert.match(rows.items[0]!.body, /role: assistant/);
	assert.match(rows.items[0]!.body, /entry id: a/);
	assert.deepEqual(rows.items.map((item) => item.body.includes("entry id: a") ? "needle answer" : "needle user"), ["needle answer", "needle user"]);
	assert.equal(rows.total, 2);
	assert.match(rows.notice, /searchable text excerpts are clipped to 32000 characters/);
});

test("timeline pages newest-first, caps entries and message detail", () => {
	const input = Array.from({ length: MAX_INSPECTOR_BRANCH_ENTRIES + 2 }, (_, index) => entry(String(index), "user", `row ${index}`, new Date(index * 1000).toISOString()));
	const first = buildInspectorTimeline(input, [], { query: "", offset: 0 });
	assert.equal(first.items.length, 40);
	assert.equal(first.total, MAX_INSPECTOR_BRANCH_ENTRIES);
	assert.equal(first.omittedOlder, 2);
	assert.ok(first.items[0]!.title.includes(String(MAX_INSPECTOR_BRANCH_ENTRIES + 1)));
	const rollback = buildInspectorTimeline([entry("late-clock", "user", "later in branch", "2026-01-02T00:00:00.000Z"), entry("clock-rollback", "user", "newest in branch", "2025-01-01T00:00:00.000Z")], [], { query: "", offset: 0 });
	assert.match(rollback.items[0]!.title, /newest in branch/);
	const clipped = buildInspectorTimeline([entry("long", "user", "x".repeat(33_000))], [], { query: "", offset: 0 });
	assert.ok(clipped.items[0]!.body.length <= 32_000);
	assert.match(clipped.items[0]!.body, /clipped/);
});

test("malformed native entries and unsafe note events fail closed without leaking tool or reasoning text", () => {
	const malformed = buildInspectorTimeline([
		null,
		{ type: "message", id: "bad", timestamp: "not-a-time", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret reasoning" }] } },
		{ type: "custom", id: "unsafe", timestamp: "2026-01-01T00:00:00.000Z", customType: "pi-persona-mind-session-note", data: { version: 9, op: "save", note: { text: "unsafe note" } } },
	], [{ version: 9 }], { query: "", offset: 0 });
	assert.deepEqual(malformed.items, []);
});

test("session note provenance requires exact validated active save event", () => {
	const note = { version: 1, op: "save", note: { id: "session:12345678-1234-1234-1234-123456789012", kind: "note", text: "saved fact", recordedAt: "2026-01-01T00:00:00.000Z", originSessionId: "active" } };
	const noteEntry = { type: "custom", id: "note-entry", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "pi-persona-mind-session-note", data: note };
	const linked = buildInspectorTimeline([noteEntry], [note], { query: "", offset: 0 });
	assert.equal(linked.items[0]!.source?.title, "Validated active-branch save event");
	assert.match(linked.items[0]!.source!.body, /note-entry/);
	assert.match(linked.items[0]!.source!.body, /session:12345678-1234-1234-1234-123456789012/);
	assert.match(linked.items[0]!.source!.body, /saved fact/);
	const forgotten = { version: 1, op: "forget", id: note.note.id };
	const replacement = { ...note, note: { ...note.note, text: "different later fact", recordedAt: "2026-01-02T00:00:00.000Z" } };
	const reused = buildInspectorTimeline([
		noteEntry,
		{ ...noteEntry, id: "forget-entry", data: forgotten },
		{ ...noteEntry, id: "replacement-entry", data: replacement },
	], [note, forgotten, replacement], { query: "", offset: 0 });
	assert.equal(reused.items.find((item) => item.id === "note-entry")!.source, undefined, "old timeline recording must not link another fact under a reused note ID");
	assert.match(reused.items.find((item) => item.id === "replacement-entry")!.source!.body, /different later fact/);
	const stale = findSessionNoteRecordingSource(note.note, [{ ...noteEntry, data: { ...note, note: { ...note.note, text: "changed" } } }], [note]);
	assert.equal(stale, undefined);
	const ancient = { ...noteEntry, id: "old-note-entry" };
	const bounded = [ancient, ...Array.from({ length: MAX_INSPECTOR_BRANCH_ENTRIES }, (_, i) => entry(String(i), "user", "later"))];
	assert.equal(findSessionNoteRecordingSource(note.note, bounded, [note]), undefined);
});

test("memory provenance requires exact paired successful call, target, owner and current content", () => {
	const memory = { id: "mem1", kind: "note", text: "exact fact", tags: ["alpha"], recordedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" };
	const assistant = { type: "message", id: "a1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: "", toolCalls: [{ id: "call1", name: "memory", arguments: { action: "remember", term: "long", scope: "persona", kind: "note", text: "exact fact", tags: ["alpha"] } }] } };
	const result = { type: "message", id: "r1", parentId: "a1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "call1", toolName: "memory", isError: false, details: { ok: true, recording: { version: 1, persona: "owner", projectRoot: "C:/project", target: "persona" } }, content: [{ type: "text", text: "Remembered mem1 — long-term note in persona scope." }] } };
	const branch = [assistant, result];
	const owner = { persona: "owner", projectRoot: "C:/project" };
	const exact = findMemoryRecordingSource(memory as never, branch, "persona", owner);
	assert.match(exact!.body, /recording context/);
	assert.match(exact!.body, /assistant entry a1/);
	assert.match(exact!.body, /toolCall call1/);
	assert.match(exact!.body, /toolResult entry r1/);
	assert.match(exact!.body, /exact fact/);
	assert.match(exact!.body, /persona/);
	assert.equal(findMemoryRecordingSource({ ...memory, text: "changed fact" } as never, branch, "persona", owner), undefined);
	assert.equal(findMemoryRecordingSource(memory as never, [assistant, { ...result, message: { ...result.message, toolCallId: "wrong" } }], "persona", owner), undefined);
	assert.equal(findMemoryRecordingSource(memory as never, branch, "shared", owner), undefined);
	assert.equal(findMemoryRecordingSource(memory as never, branch, "persona", { persona: "someone-else", projectRoot: "C:/project" }), undefined);
	assert.equal(findMemoryRecordingSource(memory as never, [assistant, { ...result, message: { ...result.message, details: { ok: true } } }], "persona", owner), undefined);
	const projectLongCall = { ...assistant, message: { ...assistant.message, content: [{ type: "toolCall", id: "project-call", name: "memory", arguments: { action: "remember", term: "long", scope: "project", kind: "note", text: "exact fact", tags: ["alpha"] } }] } };
	const projectLongResult = { ...result, id: "project-result", message: { ...result.message, toolCallId: "project-call", content: [{ type: "text", text: "Remembered mem1 — long-term note in project scope." }], details: { ok: true, recording: { version: 1, persona: "owner", projectRoot: "C:/elsewhere", target: "project-long" } } } };
	assert.equal(findMemoryRecordingSource(memory as never, [projectLongCall, projectLongResult], "project-long", owner), undefined);
});
