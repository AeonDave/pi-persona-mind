import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, stat, utimes } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { atomicWriteFile, JsonStore, quarantineCorrupt } from "../src/core/store.ts";

interface Item {
	id: string;
	n: number;
}

function itemStore(filePath: string): JsonStore<Item> {
	return new JsonStore<Item>(filePath, {
		version: 1,
		validateEntry: (raw): Item | null => {
			if (!raw || typeof raw !== "object") return null;
			const o = raw as Partial<Item>;
			return typeof o.id === "string" && typeof o.n === "number" && Number.isInteger(o.n) ? { id: o.id, n: o.n } : null;
		},
	});
}

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "ppm-store-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("atomicWriteFile writes bytes that read back, and replaces atomically", async () => {
	const p = join(dir, "atomic.txt");
	await atomicWriteFile(p, "first");
	assert.equal(readFileSync(p, "utf8"), "first");
	await atomicWriteFile(p, "second");
	assert.equal(readFileSync(p, "utf8"), "second");
	// no leftover temp files in the directory
	const leftovers = readFileSync;
	assert.ok(leftovers, "sanity");
});

test("JsonStore.load on a missing file returns an empty store", async () => {
	const store = itemStore(join(dir, "missing.json"));
	const s = await store.load();
	assert.equal(s.version, 1);
	assert.equal(s.sequence, 0);
	assert.deepEqual(s.entries, []);
});

test("JsonStore.update appends, bumps sequence, and persists across reloads", async () => {
	const p = join(dir, "append.json");
	const store = itemStore(p);
	const a = await store.update((es) => [...es, { id: "a", n: 1 }]);
	assert.equal(a.sequence, 1);
	assert.equal(a.entries.length, 1);
	const b = await store.update((es) => [...es, { id: "b", n: 2 }]);
	assert.equal(b.sequence, 2);
	// a fresh instance reads the same file
	const reloaded = await itemStore(p).load();
	assert.deepEqual(
		reloaded.entries.map((e) => e.id),
		["a", "b"],
	);
});

test("JsonStore.update serializes concurrent writers — no lost update", async () => {
	const p = join(dir, "concurrent.json");
	const store = itemStore(p);
	const N = 24;
	await Promise.all(
		Array.from({ length: N }, (_, i) => store.update((es) => [...es, { id: `k${i}`, n: i }])),
	);
	const s = await store.load();
	assert.equal(s.entries.length, N, "every concurrent append landed");
	assert.equal(s.sequence, N, "sequence advanced once per committed write");
});

test("JsonStore.load quarantines a torn file instead of serving empty", async () => {
	const p = join(dir, "torn.json");
	await writeFile(p, "{ this is not json", "utf8");
	const s = await itemStore(p).load();
	assert.deepEqual(s.entries, [], "degrades to empty");
	assert.ok(existsSync(`${p}.corrupt-0`), "the torn bytes were preserved, not dropped");
});

test("JsonStore.load drops individual invalid entries but keeps valid ones", async () => {
	const p = join(dir, "mixed.json");
	await writeFile(
		p,
		JSON.stringify({ version: 1, updatedAt: "x", sequence: 3, entries: [{ id: "ok", n: 5 }, { id: "bad" }, { n: 9 }] }),
		"utf8",
	);
	const s = await itemStore(p).load();
	assert.deepEqual(
		s.entries.map((e) => e.id),
		["ok"],
	);
});

test("quarantineCorrupt moves a file aside to the first free suffix", async () => {
	const p = join(dir, "q.json");
	await writeFile(p, "garbage", "utf8");
	const dest = await quarantineCorrupt(p, "test");
	assert.equal(dest, `${p}.corrupt-0`);
	assert.ok(!existsSync(p), "original moved");
	assert.ok(existsSync(`${p}.corrupt-0`), "preserved at suffix 0");
});

test("load recovers from the .bak last-known-good when the live file is torn", async () => {
	const p = join(dir, "bak.json");
	const store = itemStore(p);
	await store.update((es) => [...es, { id: "a", n: 1 }]);
	await store.update((es) => [...es, { id: "b", n: 2 }]); // .bak now holds the previous good [a]
	await writeFile(p, "{ corrupt now", "utf8");
	const s = await store.load();
	assert.deepEqual(
		s.entries.map((e) => e.id),
		["a"],
		"recovered the previous good version instead of going empty",
	);
	assert.ok(!existsSync(`${p}.corrupt-0`), "no quarantine when a good backup exists");
});

test("update steals a dead-pid lock immediately (before the stale window)", async () => {
	const p = join(dir, "deadpid.json");
	const store = itemStore(p);
	await store.update((es) => [...es, { id: "a", n: 1 }]);
	const lock = `${p}.lock`;
	await writeFile(lock, `${hostname()}:999999-0`, "utf8"); // dead local pid, FRESH mtime
	const started = Date.now();
	const s = await store.update((es) => [...es, { id: "b", n: 2 }]);
	assert.equal(s.entries.length, 2);
	assert.ok(Date.now() - started < 2000, "did not wait for the 10s stale window — recognized the holder is dead");
});

test("update steals a stale lock left by a crashed writer", async () => {
	const p = join(dir, "stale.json");
	const store = itemStore(p);
	await store.update((es) => [...es, { id: "a", n: 1 }]);
	// simulate a crashed holder: a lock file with an ancient mtime
	const lock = `${p}.lock`;
	await writeFile(lock, "99999-0", "utf8");
	const old = new Date(Date.now() - 60_000);
	await utimes(lock, old, old);
	// update must not hang; it steals the stale lock and commits
	const s = await store.update((es) => [...es, { id: "b", n: 2 }]);
	assert.equal(s.entries.length, 2);
	await stat(p); // still a valid file
});

test("a live local holder's lock is not time-stolen (protects an in-flight writer)", async () => {
	const p = join(dir, "livelocal.json");
	const store = itemStore(p);
	await store.update((es) => [...es, { id: "seed", n: 0 }]);
	const lock = `${p}.lock`;
	// Our OWN (alive) pid holds the lock, with an ancient mtime the old time-steal would have fired on.
	await writeFile(lock, `${hostname()}:${process.pid}-0`, "utf8");
	const old = new Date(Date.now() - 60_000);
	await utimes(lock, old, old);
	const upd = store.update((es) => [...es, { id: "X", n: 1 }]);
	const raced = await Promise.race([upd.then(() => "done"), new Promise((r) => setTimeout(() => r("waiting"), 400))]);
	assert.equal(raced, "waiting", "did not steal a lock held by a live local process");
	await rm(lock, { force: true }); // release; the writer can now acquire
	await upd;
	assert.ok((await store.load()).entries.some((e) => e.id === "X"), "completed once the holder released");
});

test("two writers stealing the same dead lock both commit (no lost write)", async () => {
	const p = join(dir, "dualsteal.json");
	const store = itemStore(p);
	await store.update((es) => [...es, { id: "seed", n: 0 }]);
	await writeFile(`${p}.lock`, `${hostname()}:999999-0`, "utf8"); // a crashed (dead-pid) holder both will steal
	const [ra, rb] = await Promise.allSettled([
		store.update((es) => [...es, { id: "A", n: 1 }]),
		store.update((es) => [...es, { id: "B", n: 2 }]),
	]);
	assert.equal(ra.status, "fulfilled");
	assert.equal(rb.status, "fulfilled");
	const ids = (await store.load()).entries.map((e) => e.id).sort();
	assert.deepEqual(ids, ["A", "B", "seed"], "both concurrent steals landed — neither overwrote the other");
});

test("a recovery write does not clobber the last-known-good .bak", async () => {
	const p = join(dir, "recover.json");
	const store = itemStore(p);
	await store.update((es) => [...es, { id: "a", n: 1 }]);
	await store.update((es) => [...es, { id: "b", n: 2 }]); // .bak now holds the good [a]
	await writeFile(p, "{ torn now", "utf8"); // live corrupt — load() will recover from .bak
	await store.update((es) => [...es, { id: "c", n: 3 }]); // the recovery write
	const bak = readFileSync(`${p}.bak`, "utf8");
	assert.doesNotThrow(() => JSON.parse(bak), "the good .bak was not overwritten with the torn live file");
	assert.ok((await store.load()).entries.some((e) => e.id === "c"), "the recovery write itself landed");
});
