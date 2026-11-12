import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MindService } from "../src/core/service.ts";
import { mindPaths } from "../src/core/scope.ts";
import { makeMemory, validateLongMemory, validateShortMemory } from "../src/core/memory.ts";
import { DEFAULT_STORE_MAX_BYTES, DEFAULT_STORE_MAX_ENTRIES, JsonStore } from "../src/core/store.ts";
import { estimateTokens } from "../src/core/context-budget.ts";

test("a full-size store keeps an old fact reachable after reopen, bounded injection, capacity refusal and undo", { timeout: 30_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "mind-read-capacity-"));
	try {
		const now = Date.parse("2026-11-12T12:00:00Z");
		const scope = { persona: "elite", projectRoot: dir, slug: "project", paths: mindPaths(dir, "elite", "project") };
		const original = makeMemory({ term: "long", kind: "note", text: "legacy/allocator.ts requires the original guard before freeing pages.",
			persona: "elite", source: "archived verification", derivedFrom: ["verified-source"] }, now - 365 * 24 * 3_600_000);
		const facts = Array.from({ length: DEFAULT_STORE_MAX_ENTRIES - 1 }, (_, i) => makeMemory({ term: "long", kind: "note", text: `Independent archival fact ${i}.`, persona: "elite" }, now - i));
		facts.push(original);
		const store = new JsonStore(scope.paths.projectLtm, { version: 1, validateEntry: validateLongMemory, now: () => now });
		await store.update(() => facts);
		const before = await readFile(store.filePath, "utf8");
		assert.ok(Buffer.byteLength(before, "utf8") < DEFAULT_STORE_MAX_BYTES);
		const reopened = new MindService(scope, { now: () => now });
		assert.deepEqual((await reopened.recall("legacy/allocator.ts", "project", 1)).hits, [original]);
		const read = await reopened.readMemory(original.id, "project"); assert.ok(read.ok);
		assert.deepEqual(read.entries[0]?.entry, original);
		const injected = await reopened.buildInjection({ query: "legacy/allocator.ts", cleanup: false });
		assert.match(injected, /original guard/); assert.ok(estimateTokens(injected) <= 2400);
		const optimizer = reopened.createOptimizer();
		const last = await optimizer.inspect("project-long", { max: 100, offset: DEFAULT_STORE_MAX_ENTRIES - 100 }); assert.ok(last.ok);
		assert.ok(last.entries.some((entry) => entry.id === original.id)); assert.equal(last.nextOffset, undefined);
		assert.equal(await readFile(store.filePath, "utf8"), before, "retrieval never refreshes or rewrites retained facts");
		const overflow = await reopened.remember({ term: "long", scope: "project", kind: "note", text: "A new fact beyond the store's entry limit." });
		assert.equal(overflow.ok, false); assert.equal(await readFile(store.filePath, "utf8"), before);
		const plan = await optimizer.preview({ target: "project-long", fingerprint: last.fingerprint,
			operations: [{ sourceIds: [original.id], kind: "note", text: "legacy/allocator.ts requires the reviewed original guard before freeing pages." }] }); assert.ok(plan.ok);
		const applied = await optimizer.apply(plan.planId); assert.ok(applied.ok && applied.receiptId);
		const afterReopen = new MindService(scope, { now: () => now });
		const undone = await afterReopen.createOptimizer().undo(applied.receiptId, "project-long"); assert.ok(undone.ok);
		const restored = (await store.load()).entries;
		assert.equal(restored.length, DEFAULT_STORE_MAX_ENTRIES);
		assert.deepEqual(restored.find((entry) => entry.id === original.id), original);
		assert.deepEqual(restored.filter((entry) => entry.id !== original.id), facts.slice(0, -1), "undo preserves every unrelated record");
		const foreignProject = new MindService({ ...scope, slug: "other", paths: mindPaths(dir, "elite", "other") }, { now: () => now });
		assert.equal((await foreignProject.recall("legacy/allocator.ts", "project", 1)).hits.length, 0);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("full ID read retains long text and provenance without refreshing expiry", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mind-read-"));
	try {
		const mind = new MindService({ persona: "elite", projectRoot: dir, slug: "project", paths: mindPaths(dir, "elite", "project") });
		const text = `Authoritative full fact ${"long context ".repeat(150)}`;
		const saved = await mind.remember({ term: "short", kind: "note", text, source: "operator session", derivedFrom: ["oldfact"] });
		assert.ok(saved.ok);
		const result = await mind.readMemory(saved.entry.id);
		assert.ok(result.ok);
		assert.equal(result.entries[0]?.target, "project");
		assert.deepEqual(result.entries[0]?.entry, saved.entry);
		assert.equal((await mind.readMemory("missing")).ok, false);
		assert.equal((await mind.readMemory(saved.entry.id, "long")).ok, false);
		const optimizer = mind.createOptimizer();
		assert.ok((await optimizer.inspect()).ok);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("full read refuses ambiguous IDs and unsafe persisted metadata without changing the store", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mind-read-trust-"));
	try {
		const scope = { persona: "elite", projectRoot: dir, slug: "project", paths: mindPaths(dir, "elite", "project") };
		const mind = new MindService(scope);
		const store = new JsonStore(scope.paths.stm, { version: 1, validateEntry: validateShortMemory });
		const a = makeMemory({ term: "short", kind: "note", text: "first distinct fact", persona: "elite" }, Date.now());
		const b = makeMemory({ term: "short", kind: "note", text: "second distinct fact", persona: "elite" }, Date.now()); b.id = a.id;
		await store.update(() => [a, b]);
		const ambiguous = await mind.readMemory(a.id); assert.equal(ambiguous.ok, false);
		if (!ambiguous.ok) assert.match(ambiguous.reason, /ambiguous/);
		await store.update(() => [{ ...a, source: "token=abcdefghijklmnop" }]);
		const before = await readFile(scope.paths.stm, "utf8");
		const unsafe = await mind.readMemory(a.id); assert.equal(unsafe.ok, false);
		if (!unsafe.ok) assert.match(unsafe.reason, /unsafe/);
		assert.equal(await readFile(scope.paths.stm, "utf8"), before);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
