import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonStore } from "../src/core/store.ts";

function store(path: string) {
	return new JsonStore<{ id: string }>(path, { version: 1, validateEntry: (raw) => {
		if (!raw || typeof raw !== "object" || typeof (raw as { id?: unknown }).id !== "string") return null;
		return { id: (raw as { id: string }).id };
	} });
}

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
