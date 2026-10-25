import assert from "node:assert/strict";
import { test } from "node:test";

import { makeMemory } from "../src/core/memory.ts";
import { registerMemoryTool } from "../src/tools/memory.ts";
import { createMindActivityRunner } from "../src/extension/activity.ts";
import type { MindActivityEvent, MindActivityRunner } from "../src/extension/activity.ts";

const now = Date.parse("2026-10-25T12:00:00.000Z");
const nativeEntry = {
	...makeMemory({ term: "long", kind: "preference", text: "The user prefers small reviewable changes.", tags: ["workflow"] }, now),
	source: "user said this",
	derivedFrom: ["memory-source-1", "memory-source-2"],
};
const sessionNote = {
	id: "session:00000000-0000-4000-8000-000000000001",
	kind: "note" as const,
	text: "The current review is waiting on the offline host fixture.",
	source: "result:opaque-current-session-ref",
	recordedAt: "2026-10-25T12:00:00.000Z",
	originSessionId: "native-session-id",
};

function makeToolHarness(activity?: MindActivityRunner) {
	let tool: Record<string, unknown> | undefined;
	const calls: { mindRecall: string[]; sessionRecall: string[]; remember: number; nativeForget: number; sessionForget: number; optimizeInspect: number; inspectOffsets: number[]; optimizeStage: number; optimizeApply: number } = {
		mindRecall: [], sessionRecall: [], remember: 0, nativeForget: 0, sessionForget: 0, optimizeInspect: 0, inspectOffsets: [], optimizeStage: 0, optimizeApply: 0,
	};
	const state = { sessionCurrent: true, ownerGeneration: 0, holdInspection: false, releaseInspection: undefined as ((value: typeof inspection) => void) | undefined };
	const mind = {
		remember: async () => { calls.remember++; return { ok: true, entry: nativeEntry }; },
		recall: async (_query: string, scope: string) => { calls.mindRecall.push(scope); return { hits: [nativeEntry], total: 1, withheldUnsafe: 0 }; },
		readMemory: async (id: string, scope: string) => ({ ok: true, entries: [{ entry: { ...nativeEntry, id }, target: scope === "short" ? "project" : "persona" }], total: 1, withheld: 0 }),
		forget: async () => { calls.nativeForget++; return { removed: 1 }; },
		promote: async () => ({ ok: true, entry: nativeEntry }),
	};
	const sessionMemory = {
		activate() {}, deactivate() {}, isCurrent: () => state.sessionCurrent, captureOwner: () => { const generation = state.ownerGeneration; return () => state.sessionCurrent && generation === state.ownerGeneration; }, remember: (_ctx: unknown, _input: unknown) => { calls.remember++; return { ok: true, storage: "session", entry: sessionNote }; },
		recall: (_ctx: unknown, options: { query?: string }) => { calls.sessionRecall.push(options.query ?? ""); return { ok: true, notes: [sessionNote], hits: [sessionNote], total: 1, withheld: 0, max: 8, storage: "session" }; },
		read: () => ({ ok: true, entry: sessionNote, storage: "session" }), forget: () => { calls.sessionForget++; return { ok: true, removed: 1, storage: "session" }; },
		snapshot: () => ({ ok: true, notes: [sessionNote], storage: "session" }), injection: () => "",
	};
	const inspection = { ok: true as const, target: "project" as const, fingerprint: "fingerprint-1", entries: [nativeEntry], total: 4, withheld: 3, candidates: [], offset: 0, matched: 3, nextOffset: 1 };
	const plan = { ok: true as const, planId: "plan-1", target: "project" as const, fingerprint: "fingerprint-1", expiresAt: "2026-10-25T12:10:00.000Z", changes: [{ before: [nativeEntry], after: { ...nativeEntry, text: "The user prefers small changes." } }], beforeCount: 1, afterCount: 1 };
	const optimizer = {
		history: async (target: string) => ({ ok: true, target, receipts: [{ receiptId: "receipt-1", planId: "plan-1", target, persona: "elite", createdAt: "2026-10-25T12:00:00Z", state: "prepared", changes: plan.changes }], retained: 1, omitted: 0, limit: 32, maxBytes: 2097152 }),
		undo: async (_receiptId: string, target: string) => ({ ok: true, receiptId: "receipt-1", target, restored: 1 }),
		inspect: async (_target: string, options?: { offset?: number }) => { calls.optimizeInspect++; const offset = options?.offset ?? 0; calls.inspectOffsets.push(offset); if (state.holdInspection) return await new Promise((resolve) => { state.releaseInspection = resolve; }); return { ...inspection, offset, nextOffset: offset < 2 ? offset + 1 : undefined }; },
		preview: async () => { calls.optimizeStage++; return plan; },
		getPlan: () => plan,
		apply: async () => { calls.optimizeApply++; return { ok: true, planId: "plan-1", target: "project", changed: 1, beforeCount: 1, afterCount: 1 }; },
	};
	const pi = { registerTool: (definition: { name: string }) => { tool = definition as unknown as Record<string, unknown>; } };
	registerMemoryTool(pi as never, (() => mind) as never, sessionMemory as never, (() => optimizer) as never, () => activity);
	assert.ok(tool);
	return {
		tool: tool as {
			execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
			renderResult: (result: { content: { text: string }[]; details: Record<string, unknown> }, options: { expanded: boolean }, theme: { fg: (_name: string, text: string) => string; bold: (text: string) => string }) => { render(width: number): { toString(): string } };
		}, calls, ctx: {}, state,
		releaseInspection: () => state.releaseInspection?.(inspection),
	};
}

async function execute(harness: ReturnType<typeof makeToolHarness>, params: Record<string, unknown>) {
	return harness.tool.execute("call", params, undefined, undefined, harness.ctx);
}

test("memory remember and recall route explicit session scope to session notes only", async () => {
	const h = makeToolHarness();
	const saved = await execute(h, { action: "remember", term: "session", kind: "note", text: sessionNote.text, source: sessionNote.source });
	assert.equal(saved.details.storage, "session");
	assert.equal(saved.details.action, "remember");
	assert.equal(saved.details.id, sessionNote.id);
	assert.equal(h.calls.remember, 1);
	assert.match(saved.content[0]!.text, /session note/i);
	const savedCard = h.tool.renderResult(saved, { expanded: true }, { fg: (_name, text) => text, bold: (text) => text }).render(240).toString();
	assert.match(savedCard, /Session note saved/);
	assert.doesNotMatch(savedCard, /belongs to this active session/);

	const recalled = await execute(h, { action: "recall", scope: "session", query: "offline host" });
	assert.equal(recalled.details.count, 1);
	assert.deepEqual(h.calls.sessionRecall, ["offline host"]);
	assert.deepEqual(h.calls.mindRecall, []);
	assert.equal(JSON.stringify(recalled.details).includes(sessionNote.text), false, "recall returns bounded snippets, not the full session-note archive");

	await execute(h, { action: "recall", scope: "both", query: "small changes" });
	assert.deepEqual(h.calls.mindRecall, ["both"], "both keeps its existing long+short meaning");
});

test("memory optimizer history exposes full recovery facts and undo requires an explicit target", async () => {
	const events: MindActivityEvent[] = [];
	const activity = createMindActivityRunner({ sessionId: "native-session", enabled: () => true, isCurrent: () => true, emit: (_channel, payload) => events.push(payload) });
	const h = makeToolHarness(activity);
	const history = await execute(h, { action: "optimize", mode: "history", target: "project-long" });
	assert.equal(history.details.ok, true);
	assert.match(history.content[0]!.text, /prepared.*interrupted/i);
	assert.match(history.content[0]!.text, /The user prefers small reviewable changes/);
	const missingTarget = await execute(h, { action: "optimize", mode: "undo", receiptId: "receipt-1" });
	assert.equal(missingTarget.details.ok, false);
	const undone = await execute(h, { action: "optimize", mode: "undo", receiptId: "receipt-1", target: "project-long" });
	assert.equal(undone.details.ok, true);
	assert.equal(undone.details.mode, "undo");
	assert.deepEqual(events.map((event) => event.phase), ["inspect", "inspect", "apply", "apply"]);
	for (const params of [
		{ action: "optimize", mode: "history", operations: [] },
		{ action: "optimize", mode: "undo", receiptId: "receipt-1", target: "project", planId: "plan-1" },
	]) assert.equal((await execute(h, params)).details.ok, false);
});

test("memory read exposes a complete bounded entry and its provenance", async () => {
	const h = makeToolHarness();
	const result = await execute(h, { action: "read", id: nativeEntry.id, scope: "long" });
	assert.equal(result.details.ok, true);
	assert.match(result.content[0]!.text, /The user prefers small reviewable changes\./);
	assert.match(result.content[0]!.text, /source: user said this/);
	assert.match(result.content[0]!.text, /derived from: memory-source-1, memory-source-2/);
	const entries = result.details.entries as Array<{ entry: typeof nativeEntry; target: string }>;
	assert.equal(entries[0]?.entry.text, nativeEntry.text);
	assert.equal(entries[0]?.entry.source, nativeEntry.source);
	assert.equal(entries[0]?.target, "persona");
});

test("memory read uses the session journal for session ids and never imports them into persona stores", async () => {
	const h = makeToolHarness();
	const result = await execute(h, { action: "read", id: sessionNote.id, scope: "session" });
	assert.equal(result.details.storage, "session");
	assert.match(result.content[0]!.text, /result:opaque-current-session-ref/);
	assert.match(result.content[0]!.text, /origin session: native-session-id.*not auto-resolved or imported/i);
	assert.equal(h.calls.remember, 0);
});

test("memory forget routes session note ids to an active-branch tombstone only", async () => {
	const h = makeToolHarness();
	const result = await execute(h, { action: "forget", id: sessionNote.id });
	assert.equal(result.details.storage, "session");
	assert.match(result.content[0]!.text, /transcript history remains/i);
	assert.equal(h.calls.sessionForget, 1);
	assert.equal(h.calls.nativeForget, 0);
});

test("persisted session reads, recalls, and forgets keep their expanded result instead of a save receipt", async () => {
	const h = makeToolHarness();
	const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
	const expanded = async (params: Record<string, unknown>) => {
		const result = await execute(h, params);
		return h.tool.renderResult(result, { expanded: true }, theme).render(240).toString();
	};

	assert.match(await expanded({ action: "read", id: sessionNote.id, scope: "session" }), /waiting on the offline host fixture/);
	assert.match(await expanded({ action: "recall", scope: "session", query: "offline host" }), /waiting on the offline host fixture/);
	assert.match(await expanded({ action: "forget", id: sessionNote.id }), /transcript history remains/);
});

test("memory optimize inspection and staging are read-only; only explicit apply commits", async () => {
	const h = makeToolHarness();
	const inspected = await execute(h, { action: "optimize", mode: "inspect", target: "project", max: 5 });
	assert.equal(inspected.details.fingerprint, "fingerprint-1");
	assert.match(inspected.content[0]!.text, /No changes were applied/i);
	assert.equal(h.calls.optimizeInspect, 1);
	assert.equal(h.calls.optimizeStage, 0);
	assert.equal(h.calls.optimizeApply, 0);

	const staged = await execute(h, { action: "optimize", mode: "stage", target: "project", fingerprint: "fingerprint-1", operations: [{ sourceIds: [nativeEntry.id], kind: "preference", text: "The user prefers small changes." }] });
	assert.equal(staged.details.planId, "plan-1");
	assert.match(staged.content[0]!.text, /Nothing has been applied/i);
	assert.match(staged.content[0]!.text, new RegExp(`selected text: ${Array.from(nativeEntry.text).length} chars → ${Array.from("The user prefers small changes.").length} chars`));
	assert.equal(h.calls.optimizeStage, 1);
	assert.equal(h.calls.optimizeApply, 0);

	const applied = await execute(h, { action: "optimize", mode: "apply", planId: "plan-1" });
	assert.equal(applied.details.ok, true);
	assert.equal(h.calls.optimizeApply, 1);
});

test("memory optimize inspect supports bounded zero-based pagination and explains omitted rows", async () => {
	const h = makeToolHarness();
	const result = await execute(h, { action: "optimize", mode: "inspect", target: "project", max: 1, offset: 1 });
	assert.equal(result.details.offset, 1);
	assert.equal(result.details.matched, 3);
	assert.equal(result.details.nextOffset, 2);
	assert.deepEqual(h.calls.inspectOffsets, [1]);
	assert.match(result.content[0]!.text, /offset 1: 1 safe match\(es\) of 3/);
	assert.match(result.content[0]!.text, /1 safe matching entry\(s\) remain on later pages/);
	assert.match(result.content[0]!.text, /1 active entry\(s\) are outside this safe match set/);
	assert.match(result.content[0]!.text, /reuse this fingerprint only while the store is unchanged/);
});

test("memory optimize tool emits one Persona activity lifecycle for inspect, stage, and apply", async () => {
	const events: MindActivityEvent[] = [];
	const activity = createMindActivityRunner({ sessionId: "native-session", enabled: () => true, isCurrent: () => true, emit: (_channel, payload) => events.push(payload) });
	const h = makeToolHarness(activity);
	await execute(h, { action: "optimize", mode: "inspect", target: "project" });
	await execute(h, { action: "optimize", mode: "stage", target: "project", fingerprint: "fingerprint-1", operations: [{ sourceIds: [nativeEntry.id], kind: "preference", text: "A shorter preference." }] });
	await execute(h, { action: "optimize", mode: "apply", planId: "plan-1" });
	assert.deepEqual(events.map((event) => [event.phase, event.state, event.target]), [
		["inspect", "running", "project"], ["inspect", "done", "project"],
		["stage", "running", "project"], ["stage", "staged", "project"],
		["apply", "running", "project"], ["apply", "done", "project"],
	]);
	assert.equal(new Set(events.filter((event) => event.state === "running").map((event) => event.activityId)).size, 3);
});

test("memory optimize rejects fields from another mode before touching the optimizer", async () => {
	const h = makeToolHarness();
	const result = await execute(h, { action: "optimize", mode: "apply", planId: "plan-1", target: "project" });
	assert.equal(result.details.ok, false);
	assert.equal(h.calls.optimizeApply, 0);
	const malformed = await execute(h, { action: "optimize", mode: "stage", fingerprint: "fp", operations: [{ sourceIds: [nativeEntry.id], kind: "preference", text: "valid", unexpected: true }] });
	assert.equal(malformed.details.ok, false);
	assert.equal(h.calls.optimizeStage, 0);
	const invalidOffset = await execute(h, { action: "optimize", mode: "inspect", offset: 10_001 });
	assert.equal(invalidOffset.details.ok, false);
	const stageOffset = await execute(h, { action: "optimize", mode: "stage", offset: 0, fingerprint: "fp", operations: [{ sourceIds: [nativeEntry.id], kind: "preference", text: "valid" }] });
	assert.equal(stageOffset.details.ok, false);
	const applyOffset = await execute(h, { action: "optimize", mode: "apply", offset: 0, planId: "plan-1" });
	assert.equal(applyOffset.details.ok, false);
	assert.equal(h.calls.optimizeInspect, 0);
	assert.equal(h.calls.optimizeStage, 0);
	assert.equal(h.calls.optimizeApply, 0);
});

test("memory optimize drops a late inspection when the native session owner changes", async () => {
	const h = makeToolHarness();
	h.state.holdInspection = true;
	const pending = execute(h, { action: "optimize", mode: "inspect", target: "project" });
	h.state.ownerGeneration++;
	h.releaseInspection();
	const result = await pending;
	assert.equal(result.details.reason, "owner_changed");
	assert.match(result.content[0]!.text, /owner changed/i);
	assert.doesNotMatch(result.content[0]!.text, /fingerprint-1/);
});
