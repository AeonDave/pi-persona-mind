import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JsonStore, withFileLock } from "../src/core/store.ts";
import { MemoryOptimizer } from "../src/core/optimize-service.ts";
import { makeMemory, validateShortMemory } from "../src/core/memory.ts";

function store(path: string) {
	return new JsonStore<{ id: string }>(path, { version: 1, validateEntry: (raw) => {
		if (!raw || typeof raw !== "object" || typeof (raw as { id?: unknown }).id !== "string") return null;
		return { id: (raw as { id: string }).id };
	} });
}

async function optimizerFixture(run: (fixture: { optimizer: MemoryOptimizer; target: JsonStore<ReturnType<typeof makeMemory>>; evidencePath: string; planId: string }) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "mind-opt-evidence-"));
	const now = Date.parse("2026-10-25T10:00:00Z");
	const target = new JsonStore(join(dir, "memory.json"), { version: 1, validateEntry: validateShortMemory, now: () => now });
	const optimizer = new MemoryOptimizer({ stores: { project: target, "project-long": target, persona: target, shared: target }, persona: "reviewer", now: () => now });
	try {
		const original = makeMemory({ term: "short", kind: "note", text: "original verified repository fact", persona: "reviewer" }, now);
		await target.update(() => [original]);
		const snapshot = await optimizer.inspect("project"); assert.ok(snapshot.ok);
		const plan = await optimizer.preview({ fingerprint: snapshot.fingerprint, operations: [{ sourceIds: [original.id], kind: "note", text: "reviewed replacement repository fact" }] }); assert.ok(plan.ok);
		const evidencePath = join(dir, "evidence.txt"); await writeFile(evidencePath, "current evidence");
		await run({ optimizer, target, evidencePath, planId: plan.planId });
	} finally { await rm(dir, { recursive: true, force: true }); }
}

test("apply freshness guard rejects before mutation and leaves staged recovery available", async () => optimizerFixture(async ({ optimizer, target, planId }) => {
	const original = await readFile(target.filePath, "utf8");
	let checked = 0;
	const refused = await optimizer.apply(planId, () => { checked++; throw new Error("evidence no longer current"); });
	assert.equal(refused.ok, false); if (!refused.ok) assert.match(refused.reason, /evidence no longer current/);
	assert.equal(checked, 1); assert.equal(await readFile(target.filePath, "utf8"), original);
	const history = await optimizer.history("project"); assert.ok(history.ok); assert.equal(history.receipts.length, 0);
	assert.ok(optimizer.getPlan(planId).ok);
	const recovered = await optimizer.apply(planId); assert.ok(recovered.ok); assert.ok(recovered.receiptId);
	assert.ok((await optimizer.undo(recovered.receiptId, "project")).ok);
	assert.equal((await target.load()).entries[0]?.text, "original verified repository fact");
}));

test("evidence changed while apply awaits the real store lock rejects its prepared receipt", async () => optimizerFixture(async ({ optimizer, target, evidencePath, planId }) => {
	const original = await readFile(target.filePath, "utf8");
	let unlock!: () => void; let locked!: () => void; let comparing!: () => void;
	const released = new Promise<void>((resolve) => { unlock = resolve; });
	const acquired = new Promise<void>((resolve) => { locked = resolve; });
	const comparison = new Promise<void>((resolve) => { comparing = resolve; });
	const lock = withFileLock(`${target.filePath}.lock`, async () => { locked(); await released; });
	await acquired;
	const compare = target.compareAndUpdate.bind(target);
	target.compareAndUpdate = (fingerprint, mutate) => { comparing(); return compare(fingerprint, mutate); };
	let checked = 0;
	const pending = optimizer.apply(planId, () => {
		checked++;
		if (readFileSync(evidencePath, "utf8") !== "current evidence") throw new Error("evidence changed under store lock");
	});
	try {
		await comparison; assert.equal(checked, 1, "precommit guard ran before waiting for the store lock");
		await writeFile(evidencePath, "changed evidence");
	} finally { unlock(); await lock; target.compareAndUpdate = compare; }
	const refused = await pending;
	assert.equal(refused.ok, false); if (!refused.ok) assert.match(refused.reason, /evidence changed under store lock/);
	assert.equal(checked, 2, "guard rechecks inside the locked CAS callback");
	assert.equal(await readFile(target.filePath, "utf8"), original);
	const rejected = await optimizer.history("project"); assert.ok(rejected.ok);
	assert.deepEqual(rejected.receipts.map((receipt) => receipt.state), ["rejected"]);
	await writeFile(evidencePath, "current evidence");
	const applied = await optimizer.apply(planId, () => assert.equal(readFileSync(evidencePath, "utf8"), "current evidence"));
	assert.ok(applied.ok); assert.ok(applied.receiptId);
	const committed = await optimizer.history("project"); assert.ok(committed.ok);
	assert.deepEqual(committed.receipts.map((receipt) => receipt.state), ["applied", "rejected"]);
	assert.ok((await optimizer.undo(applied.receiptId, "project")).ok);
	assert.equal((await target.load()).entries[0]?.text, "original verified repository fact");
}));

test("an unchanged synchronous guard preserves apply, immutable plans, receipts and CAS", async () => optimizerFixture(async ({ optimizer, target, planId }) => {
	const plan = optimizer.getPlan(planId); assert.ok(plan.ok);
	plan.changes[0]!.after.text = "caller tampering";
	let checked = 0;
	const applied = await optimizer.apply(planId, () => { checked++; });
	assert.ok(applied.ok); assert.equal(checked, 2); assert.ok(applied.receiptId);
	assert.equal((await target.load()).entries[0]?.text, "reviewed replacement repository fact");
	assert.equal((await optimizer.apply(planId, () => assert.fail("consumed plan must not call guard"))).ok, false);
	assert.ok((await optimizer.undo(applied.receiptId, "project")).ok);
	const snapshot = await optimizer.inspect("project"); assert.ok(snapshot.ok);
	const next = await optimizer.preview({ fingerprint: snapshot.fingerprint, operations: [{ sourceIds: [snapshot.entries[0]!.id], kind: "note", text: "must not overwrite a concurrent fact" }] }); assert.ok(next.ok);
	await target.update((entries) => [...entries, makeMemory({ term: "short", kind: "note", text: "concurrent fact", persona: "reviewer" }, Date.parse("2026-10-25T10:00:00Z"))]);
	const concurrent = await readFile(target.filePath, "utf8");
	assert.equal((await optimizer.apply(next.planId, () => {})).ok, false);
	assert.equal(await readFile(target.filePath, "utf8"), concurrent);
}));

test("strict inspection never repairs corrupt or individually invalid stores", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mind-opt-store-"));
	try {
		const path = join(dir, "memory.json");
		await writeFile(path, "broken");
		await assert.rejects(store(path).inspectStrict(), /invalid|corrupt/i);
		assert.equal(await readFile(path, "utf8"), "broken");
		assert.deepEqual(await readdir(dir), ["memory.json"]);
		const raw = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), sequence: 1, entries: [{ id: "a" }, { invalid: true }] });
		await writeFile(path, raw);
		await assert.rejects(store(path).inspectStrict(), /invalid/i);
		assert.equal(await readFile(path, "utf8"), raw);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("fingerprint CAS rejects intervening writes and same-sequence replacements without losing facts", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mind-opt-cas-"));
	try {
		const path = join(dir, "memory.json");
		const first = store(path);
		await first.update(() => [{ id: "a" }]);
		const snap = await first.inspectStrict();
		await store(path).update((entries) => [...entries, { id: "concurrent" }]);
		await assert.rejects(first.compareAndUpdate(snap.fingerprint, () => []), /changed|stale|conflict/i);
		assert.deepEqual((await first.load()).entries.map((e) => e.id), ["a", "concurrent"]);
		const next = await first.inspectStrict();
		await writeFile(path, JSON.stringify({ ...next.store, entries: [{ id: "replaced" }] }));
		await assert.rejects(first.compareAndUpdate(next.fingerprint, () => []), /changed|stale|conflict/i);
		assert.deepEqual((await first.load()).entries, [{ id: "replaced" }]);
		const current = await first.inspectStrict();
		const raw = await readFile(path, "utf8");
		await first.compareAndUpdate(current.fingerprint, (entries) => entries);
		assert.equal(await readFile(path, "utf8"), raw, "no-op never increments sequence or writes a backup");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("strict inspection refuses missing live stores with backups and CAS validates capacity before writing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mind-opt-limits-"));
	try {
		const path = join(dir, "memory.json");
		const target = store(path);
		await target.update(() => [{ id: "a" }]);
		await target.update(() => [{ id: "b" }]);
		const backup = await readFile(`${path}.bak`, "utf8");
		await rm(path);
		await assert.rejects(target.inspectStrict(), /backup|repair/i);
		assert.equal(await readFile(`${path}.bak`, "utf8"), backup);
		await assert.rejects(readFile(path), /ENOENT/);
		await writeFile(path, backup);
		const bounded = new JsonStore(path, { version: 1, maxEntries: 1, maxBytes: 512, validateEntry: (raw: unknown) => raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? raw as { id: string } : null });
		const snapshot = await bounded.inspectStrict();
		await assert.rejects(bounded.compareAndUpdate(snapshot.fingerprint, () => [{ id: "a" }, { id: "b" }]), /capacity/);
		await assert.rejects(bounded.compareAndUpdate(snapshot.fingerprint, () => [{ id: "x".repeat(600) }]), /capacity/);
		assert.equal(await readFile(path, "utf8"), backup);
		await bounded.compareAndUpdate(snapshot.fingerprint, (entries) => { entries[0]!.id = "mutated"; return entries; });
		assert.equal((await bounded.load()).entries[0]?.id, "mutated");
	} finally { await rm(dir, { recursive: true, force: true }); }
});
