import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MindService } from "../src/core/service.ts";
import { mindPaths } from "../src/core/scope.ts";
import { makeMemory, validateShortMemory } from "../src/core/memory.ts";
import { JsonStore } from "../src/core/store.ts";

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
