import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import { loadInspectorPage } from "../src/extension/inspector-data.ts";

const ctx = (branch: unknown[], entries: unknown[] = branch) => ({ cwd: "C:/work/project", sessionManager: { getBranch: () => branch, getEntries: () => entries } }) as never;
const memoryApi = (inspection: unknown = { ok: true, entries: [], total: 0, matched: 0, offset: 0 }, scope: { persona: string; projectRoot: string; homeWorkspace?: true } = { persona: "owner", projectRoot: "C:/work/project" }) => ({ inspectionScope: () => scope, createOptimizer: () => ({ inspect: async () => inspection }) }) as never;
const sessionApi = (notes: unknown[] = []) => ({ snapshot: () => ({ ok: true, notes, storage: "session" }) }) as never;

test("timeline adapter uses active branch, excludes off-branch entries and pages", async () => {
	const active = [{ type: "message", id: "active", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "active item" } }];
	const offBranch = { type: "message", id: "other", parentId: null, timestamp: "2026-01-02T00:00:00Z", message: { role: "user", content: "off branch" } };
	const page = await loadInspectorPage(ctx(active, [...active, offBranch]), memoryApi(), sessionApi(), { tab: "timeline", scope: "session", query: "", offset: 0 });
	assert.deepEqual(page.items.map((item) => item.id), ["active"]);
	assert.equal(page.total, 1);
});

test("session memory pages snapshot and context has explicit fallback", async () => {
	const notes = Array.from({ length: 41 }, (_, i) => ({ id: `session:${String(i).padStart(8, "0")}-1234-1234-1234-123456789012`, kind: "note", text: `note ${i}`, recordedAt: new Date(i * 1000).toISOString(), originSessionId: "active", ...(i === 40 ? { source: "literal note source" } : {}) }));
	const first = await loadInspectorPage(ctx([]), memoryApi(), sessionApi(notes), { tab: "memories", scope: "session", query: "", offset: 0 });
	assert.equal(first.items.length, 40);
	assert.equal(first.total, 41);
	assert.match(first.items[0]!.body, /id: session:00000040/);
	assert.match(first.items[0]!.body, /origin session id: active/);
	assert.match(first.items[0]!.body, /literal source metadata \(not opened\): literal note source/);
	assert.match(first.items[0]!.body, /No resolvable recording in this active-branch window/);
	assert.match(first.notice, /newest 2000 native entries/);
	assert.equal(first.nextOffset, 40);
	assert.match(first.items[0]!.title, /note 40/);
	const fallback = await loadInspectorPage(ctx([]), memoryApi(), sessionApi(), { tab: "context", scope: "session", query: "", offset: 0 });
	assert.match(fallback.notice, /No context snapshot/);
});

test("durable inspection passes bounded paging request and refuses home project tiers", async () => {
	let args: unknown;
	const mind = { inspectionScope: () => ({ persona: "owner", projectRoot: "C:/work/project" }), createOptimizer: () => ({ inspect: async (...received: unknown[]) => { args = received; return { ok: true, entries: [], total: 20, matched: 3, offset: 2, nextOffset: 5 }; } }) } as never;
	const page = await loadInspectorPage(ctx([]), mind, sessionApi(), { tab: "memories", scope: "persona", query: "needle", offset: 2 });
	assert.deepEqual(args, ["persona", { query: "needle", offset: 2, max: 40 }]);
	assert.equal(page.total, 3);
	const homeMind = memoryApi(undefined, { persona: "owner", projectRoot: homedir(), homeWorkspace: true });
	const home = await loadInspectorPage(ctx([]), homeMind, sessionApi(), { tab: "memories", scope: "project", query: "", offset: 0 });
	assert.match(home.notice, /home workspace/);
	assert.equal(args && (args as unknown[])[0], "persona");
	const noScopeMind = { createOptimizer: () => { throw new Error("must not read without resolved scope"); } } as never;
	const unavailable = await loadInspectorPage(ctx([]), noScopeMind, sessionApi(), { tab: "memories", scope: "persona", query: "", offset: 0 });
	assert.match(unavailable.notice, /scope is unavailable/);
});

test("memory item exposes full fact metadata and only owner/target-exact native provenance", async () => {
	const entry = { id: "fact1", kind: "invariant", text: "full current fact text", tags: ["alpha"], recordedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-02T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z", source: "literal origin", derivedFrom: ["prior-id"], supersedes: "old-fact" };
	const branch = [
		{ type: "message", id: "assistant-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "memory", arguments: { action: "remember", term: "short", kind: "invariant", text: "full current fact text", tags: ["alpha"] } }] } },
		{ type: "message", id: "result-1", parentId: "assistant-1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "memory", isError: false, details: { ok: true, recording: { version: 1, persona: "owner", projectRoot: "C:/work/project", target: "project" } }, content: [{ type: "text", text: "Remembered fact1 — short-term invariant in project scope." }] } },
	];
	const mind = { inspectionScope: () => ({ persona: "owner", projectRoot: "C:/work/project" }), createOptimizer: () => ({ inspect: async () => ({ ok: true, entries: [entry], total: 1, matched: 1, offset: 0 }) }) } as never;
	const page = await loadInspectorPage(ctx(branch), mind, sessionApi(), { tab: "memories", scope: "project", query: "", offset: 0 });
	assert.equal(page.items[0]!.title, entry.text);
	assert.match(page.items[0]!.body, /id: fact1/);
	assert.match(page.items[0]!.body, /target: project/);
	assert.match(page.items[0]!.body, /recorded: 2026-01-01/);
	assert.match(page.items[0]!.body, /expires: 2026-02-01/);
	assert.match(page.items[0]!.body, /literal source metadata \(not opened\): literal origin/);
	assert.match(page.items[0]!.body, /derivedFrom literal IDs.*prior-id/);
	assert.match(page.items[0]!.body, /supersedes literal ID.*old-fact/);
	assert.match(page.items[0]!.source!.body, /assistant-1/);
	assert.match(page.items[0]!.source!.body, /call-1/);
	assert.match(page.items[0]!.source!.body, /result-1/);
	const noOwnerMind = { inspectionScope: () => ({ persona: "other", projectRoot: "C:/work/project" }), createOptimizer: () => ({ inspect: async () => ({ ok: true, entries: [entry], total: 1, matched: 1, offset: 0 }) }) } as never;
	const unlinked = await loadInspectorPage(ctx(branch), noOwnerMind, sessionApi(), { tab: "memories", scope: "project", query: "", offset: 0 });
	assert.equal(unlinked.items[0]!.source, undefined);
	assert.match(unlinked.items[0]!.body, /No resolvable recording in this active-branch window/);
	const unresolvedMind = { createOptimizer: () => { throw new Error("must not access without scope"); } } as never;
	const unresolved = await loadInspectorPage(ctx([]), unresolvedMind, sessionApi(), { tab: "memories", scope: "persona", query: "", offset: 0 });
	assert.match(unresolved.notice, /scope is unavailable/);
});
