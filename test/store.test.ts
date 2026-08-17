import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { atomicWriteFile, JsonStore, quarantineCorrupt, withFileLock } from "../src/core/store.ts";

interface Item {
	id: string;
	n: number;
}

interface TestStoreOptions {
	maxBytes?: number;
	maxEntries?: number;
	now?: () => number;
	onWarn?: (message: string) => void;
}

function itemStore(filePath: string, extra: TestStoreOptions = {}): JsonStore<Item> {
	const options = {
		version: 1,
		validateEntry: (raw: unknown): Item | null => {
			if (!raw || typeof raw !== "object") return null;
			const o = raw as Partial<Item>;
			return typeof o.id === "string" && typeof o.n === "number" && Number.isInteger(o.n) ? { id: o.id, n: o.n } : null;
		},
		...extra,
	};
	return new JsonStore<Item>(filePath, options);
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

test("atomicWriteFile retries a Windows sharing violation until a reader releases the live file", { skip: process.platform !== "win32" }, async () => {
	const p = join(dir, "reader-held.json");
	await atomicWriteFile(p, "old");
	const reader = await open(p, "r");
	const write = atomicWriteFile(p, "new");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(readFileSync(p, "utf8"), "old", "the prior committed file remains visible while replacement is blocked");
	await reader.close();
	await write;
	assert.equal(readFileSync(p, "utf8"), "new");
});

test("atomicWriteFile never follows a pre-created predictable temp symlink", async () => {
	const p = join(dir, "temp-symlink.json");
	const target = join(dir, "temp-symlink-target.json");
	await writeFile(target, "keep this target", "utf8");
	await writeFile(p, "old live", "utf8");
	const candidates = Array.from({ length: 1024 }, (_, index) => join(dir, `.temp-symlink.json.tmp-${process.pid}-${index}`));
	try {
		for (const candidate of candidates) await symlink(target, candidate);
		await atomicWriteFile(p, "new live");
		assert.equal(readFileSync(target, "utf8"), "keep this target", "the temp staging path was not followed");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EPERM" || (err as NodeJS.ErrnoException).code === "EACCES") return;
		throw err;
	} finally {
		// The old predictable implementation consumes one candidate; all others are test debris.
		await Promise.all(candidates.map((candidate) => rm(candidate, { force: true })));
	}
});

test("atomicWriteFile replaces a backup symlink without touching its target", async () => {
	const p = join(dir, "backup-symlink.json");
	const target = join(dir, "backup-symlink-target.json");
	await writeFile(target, "keep this target", "utf8");
	await writeFile(p, "old live", "utf8");
	try {
		await symlink(target, `${p}.bak`);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EPERM" || (err as NodeJS.ErrnoException).code === "EACCES") return;
		throw err;
	}
	await atomicWriteFile(p, "new live");
	assert.equal(readFileSync(p, "utf8"), "new live");
	assert.equal(readFileSync(target, "utf8"), "keep this target", "backup replacement did not follow its destination symlink");
	assert.equal(readFileSync(`${p}.bak`, "utf8"), "old live", "backup contains the prior live bytes");
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
		JSON.stringify({ version: 1, updatedAt: "2026-07-16T00:00:00.000Z", sequence: 3, entries: [{ id: "ok", n: 5 }, { id: "bad" }, { n: 9 }] }),
		"utf8",
	);
	const s = await itemStore(p).load();
	assert.deepEqual(
		s.entries.map((e) => e.id),
		["ok"],
	);
});

test("a store written by a different version is refused, never quarantined or replaced", async () => {
	const p = join(dir, "future-version.json");
	const raw = `${JSON.stringify({ version: 2, updatedAt: "2026-07-16T00:00:00.000Z", sequence: 7, entries: [{ id: "kept", n: 1 }] }, null, 2)}\n`;
	await writeFile(p, raw, "utf8");
	await writeFile(`${p}.bak`, raw, "utf8");
	const warnings: string[] = [];
	const store = itemStore(p, { onWarn: (message) => warnings.push(message) });

	// A newer store is not corrupt — it is unreadable HERE. Quarantining it would move the user's
	// memory aside and the next write would recreate an empty store at the live path.
	await assert.rejects(store.load(), /version 2/);
	await assert.rejects(store.update((entries) => [...entries, { id: "new", n: 2 }]), /version 2/);
	assert.equal(readFileSync(p, "utf8"), raw, "the newer store is left exactly as its writer left it");
	assert.equal(existsSync(`${p}.corrupt-0`), false, "version skew is not filed as corruption");
	assert.deepEqual(warnings, [], "no corruption is announced for a store this build simply cannot read");
});

test("JsonStore.load rejects wrapper metadata corruption instead of accepting it", async () => {
	// A wrong `version` is NOT in this list: it has its own non-destructive contract (see above).
	const invalidWrappers = [
		{ version: 1, updatedAt: "not-a-date", sequence: 3 },
		{ version: 1, updatedAt: "2026-07-16T00:00:00.000Z", sequence: -5 },
		{ version: 1, updatedAt: "2026-07-16T00:00:00.000Z", sequence: 1.5 },
	];
	for (const [index, wrapper] of invalidWrappers.entries()) {
		const p = join(dir, `bad-metadata-${index}.json`);
		await writeFile(p, JSON.stringify({ ...wrapper, entries: [{ id: "ok", n: 5 }] }), "utf8");
		const warnings: string[] = [];
		const store = new JsonStore<Item>(p, {
			version: 1,
			validateEntry: (raw): Item | null => {
				if (!raw || typeof raw !== "object") return null;
				const o = raw as Partial<Item>;
				return typeof o.id === "string" && typeof o.n === "number" && Number.isInteger(o.n) ? { id: o.id, n: o.n } : null;
			},
			onWarn: (message) => warnings.push(message),
		});
		const s = await store.load();
		assert.deepEqual(s.entries, [], "invalid wrapper is not exposed as a valid store");
		assert.ok(existsSync(`${p}.corrupt-0`), "invalid wrapper is quarantined");
		assert.ok(warnings.some((message) => /corrupt/i.test(message)), "corruption is surfaced");
	}
});

test("JsonStore preserves invalid raw entries across updates but never exposes them", async () => {
	const p = join(dir, "preserve-invalid.json");
	const invalid = { id: "bad", n: "not-an-integer", extra: "must-survive" };
	await writeFile(
		p,
		JSON.stringify({ version: 1, updatedAt: "2026-07-16T00:00:00.000Z", sequence: 3, entries: [{ id: "ok", n: 5 }, invalid] }),
		"utf8",
	);
	const warnings: string[] = [];
	const store = new JsonStore<Item>(p, {
		version: 1,
		validateEntry: (raw): Item | null => {
			if (!raw || typeof raw !== "object") return null;
			const o = raw as Partial<Item>;
			return typeof o.id === "string" && typeof o.n === "number" && Number.isInteger(o.n) ? { id: o.id, n: o.n } : null;
		},
		onWarn: (message) => warnings.push(message),
	});
	const loaded = await store.load();
	assert.deepEqual(loaded.entries, [{ id: "ok", n: 5 }], "invalid raw entries stay hidden from consumers");
	assert.ok(warnings.some((message) => /invalid entr/i.test(message)), "invalid entries are surfaced");
	await store.update((entries) => [...entries, { id: "new", n: 6 }]);
	const raw = JSON.parse(readFileSync(p, "utf8")) as { entries: unknown[] };
	assert.ok(raw.entries.some((entry) => JSON.stringify(entry) === JSON.stringify(invalid)), "invalid raw entry survives update");
	assert.deepEqual(
		(await store.load()).entries.map((entry) => entry.id),
		["ok", "new"],
		"invalid raw entry remains hidden after update",
	);
});

test("JsonStore bounds live reads and recovers from a valid backup", async () => {
	const p = join(dir, "oversized-live.json");
	await writeFile(
		`${p}.bak`,
		JSON.stringify({ version: 1, updatedAt: "2026-07-16T00:00:00.000Z", sequence: 1, entries: [{ id: "safe", n: 1 }] }),
		"utf8",
	);
	await writeFile(
		p,
		JSON.stringify({ version: 1, updatedAt: "2026-07-16T00:00:00.000Z", sequence: 2, entries: [{ id: "oversized", n: 2 }], padding: "x".repeat(512) }),
		"utf8",
	);
	const warnings: string[] = [];
	const s = await itemStore(p, { maxBytes: 128, onWarn: (message) => warnings.push(message) }).load();
	assert.deepEqual(s.entries, [{ id: "safe", n: 1 }], "an oversized live file is not parsed or exposed");
	assert.ok(warnings.some((message) => /byte|size|limit/i.test(message)), "oversized input is surfaced");
});

test("JsonStore allocates only the observed file size, not the configured cap", async () => {
	const p = join(dir, "small-under-large-cap.json");
	const raw = JSON.stringify({ version: 1, updatedAt: "2026-07-16T00:00:00.000Z", sequence: 1, entries: [{ id: "small", n: 1 }] });
	await writeFile(p, raw, "utf8");
	const originalAllocUnsafe = Buffer.allocUnsafe;
	const allocations: number[] = [];
	Buffer.allocUnsafe = ((size: number) => {
		allocations.push(size);
		return originalAllocUnsafe(size);
	}) as typeof Buffer.allocUnsafe;
	try {
		await itemStore(p, { maxBytes: 4 * 1024 * 1024 }).load();
	} finally {
		Buffer.allocUnsafe = originalAllocUnsafe;
	}
	assert.deepEqual(allocations, [Buffer.byteLength(raw, "utf8") + 1], "read allocation tracks the observed file size");
});

test("JsonStore rejects an over-cap file before allocating a read buffer", async () => {
	const p = join(dir, "oversized-before-buffer.json");
	await writeFile(p, "x".repeat(256), "utf8");
	const originalAllocUnsafe = Buffer.allocUnsafe;
	const allocations: number[] = [];
	Buffer.allocUnsafe = ((size: number) => {
		allocations.push(size);
		return originalAllocUnsafe(size);
	}) as typeof Buffer.allocUnsafe;
	try {
		const loaded = await itemStore(p, { maxBytes: 128 }).load();
		assert.deepEqual(loaded.entries, [], "oversized bytes are not exposed");
	} finally {
		Buffer.allocUnsafe = originalAllocUnsafe;
	}
	assert.deepEqual(allocations, [], "fstat rejects the file before allocating a capped buffer");
});

test("JsonStore retries a file that grows during the bounded read and serves the stable snapshot", async () => {
	const p = join(dir, "growing-during-read.json");
	const raw = JSON.stringify({ version: 1, updatedAt: "2026-07-16T00:00:00.000Z", sequence: 1, entries: [{ id: "stable", n: 1 }] });
	await writeFile(p, raw, "utf8");
	const originalAllocUnsafe = Buffer.allocUnsafe;
	Buffer.allocUnsafe = ((size: number) => {
		writeFileSync(p, `${raw} `, "utf8");
		return originalAllocUnsafe(size);
	}) as typeof Buffer.allocUnsafe;
	try {
		const loaded = await itemStore(p, { maxBytes: 1024 * 1024 }).load();
		assert.deepEqual(loaded.entries, [{ id: "stable", n: 1 }], "a stable retry is safe to expose");
	} finally {
		Buffer.allocUnsafe = originalAllocUnsafe;
	}
});

test("JsonStore rejects an oversized backup instead of parsing it", async () => {
	const p = join(dir, "oversized-backup.json");
	await writeFile(p, "{ torn live", "utf8");
	await writeFile(
		`${p}.bak`,
		JSON.stringify({ version: 1, updatedAt: "2026-07-16T00:00:00.000Z", sequence: 2, entries: [{ id: "external", n: 9 }], padding: "x".repeat(512) }),
		"utf8",
	);
	const warnings: string[] = [];
	const s = await itemStore(p, { maxBytes: 128, onWarn: (message) => warnings.push(message) }).load();
	assert.deepEqual(s.entries, [], "an oversized backup is not exposed as a recovery source");
	assert.ok(existsSync(`${p}.corrupt-0`), "the torn live file remains preserved");
	assert.ok(warnings.some((message) => /\.bak|byte|size|limit/i.test(message)), "oversized backup is surfaced");
});

test("JsonStore quarantines a file that exceeds the entry cap without a usable backup", async () => {
	const p = join(dir, "too-many-entries.json");
	await writeFile(
		p,
		JSON.stringify({
			version: 1,
			updatedAt: "2026-07-16T00:00:00.000Z",
			sequence: 3,
			entries: [{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "c", n: 3 }],
		}),
		"utf8",
	);
	const warnings: string[] = [];
	const s = await itemStore(p, { maxEntries: 2, onWarn: (message) => warnings.push(message) }).load();
	assert.deepEqual(s.entries, [], "an entry flood is not exposed");
	assert.ok(existsSync(`${p}.corrupt-0`), "the entry flood is preserved for diagnosis");
	assert.ok(warnings.some((message) => /entr|limit|corrupt/i.test(message)), "entry-limit failure is surfaced");
});

test("JsonStore rejects over-cap writes without changing the prior commit", async () => {
	const p = join(dir, "write-capacity.json");
	const store = itemStore(p, { maxEntries: 1 });
	await store.update(() => [{ id: "kept", n: 1 }]);
	await assert.rejects(
		store.update((entries) => [...entries, { id: "rejected", n: 2 }]),
		/entries|capacity|limit/i,
	);
	assert.deepEqual((await store.load()).entries, [{ id: "kept", n: 1 }], "a rejected entry-cap write leaves the old file intact");
});

test("JsonStore rejects over-cap serialized bytes without changing the prior commit", async () => {
	const p = join(dir, "write-byte-capacity.json");
	const now = () => 0;
	const entry = { id: "kept", n: 1 };
	const firstRaw = `${JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(), sequence: 1, entries: [entry] }, null, 2)}\n`;
	const store = itemStore(p, { maxBytes: Buffer.byteLength(firstRaw, "utf8"), now });
	await store.update(() => [entry]);
	await assert.rejects(
		store.update((entries) => [...entries, { id: "rejected", n: 2 }]),
		/bytes|capacity|limit/i,
	);
	assert.deepEqual((await store.load()).entries, [entry], "a rejected byte-cap write leaves the old file intact");
});

test("JsonStore fails closed on a non-regular store path", async () => {
	const p = join(dir, "directory-store");
	await mkdir(p);
	const warnings: string[] = [];
	const s = await itemStore(p, { onWarn: (message) => warnings.push(message) }).load();
	assert.deepEqual(s.entries, [], "a directory is never parsed as a store");
	assert.ok(warnings.some((message) => /regular|path|corrupt/i.test(message)), "the non-regular path is surfaced");
});

test("JsonStore fails closed on a symlink without touching its target", async () => {
	const target = join(dir, "symlink-target.json");
	const p = join(dir, "symlink-store.json");
	await writeFile(
		target,
		JSON.stringify({ version: 1, updatedAt: "2026-07-16T00:00:00.000Z", sequence: 1, entries: [{ id: "external", n: 9 }] }),
		"utf8",
	);
	try {
		await symlink(target, p);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EPERM" || (err as NodeJS.ErrnoException).code === "EACCES") return;
		throw err;
	}
	const warnings: string[] = [];
	const s = await itemStore(p, { onWarn: (message) => warnings.push(message) }).load();
	assert.deepEqual(s.entries, [], "a symlink target is never exposed as this store");
	assert.ok(existsSync(target), "the external target remains untouched");
	assert.ok(warnings.some((message) => /symbolic|regular|path|corrupt/i.test(message)), "the symlink is surfaced");
});

test("withFileLock serializes callbacks and remains reusable", async () => {
	const lock = join(dir, "generic.lock");
	let active = 0;
	let maxActive = 0;
	const run = (name: string): Promise<void> =>
		withFileLock(lock, async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 25));
			active--;
			void name;
		});
	await Promise.all([run("a"), run("b")]);
	assert.equal(maxActive, 1, "callbacks never overlap");
});

test("withFileLock removes a lock when token creation fails", async () => {
	const lock = join(dir, "write-failure.lock");
	const probe = await open(lock, "wx");
	const prototype = Object.getPrototypeOf(probe) as {
		writeFile: (...args: never[]) => Promise<void>;
	};
	const originalWriteFile = prototype.writeFile;
	await probe.close();
	await rm(lock, { force: true });
	prototype.writeFile = async () => {
		throw new Error("injected token write failure");
	};
	try {
		await assert.rejects(withFileLock(lock, async () => {}), /injected token write failure/);
	} finally {
		prototype.writeFile = originalWriteFile;
	}
	assert.equal(existsSync(lock), false, "a failed token write must not poison the lock path");
});

test("withFileLock removes a lock when closing the token handle fails", async () => {
	const lock = join(dir, "close-failure.lock");
	const close = async () => {
		throw new Error("injected token close failure");
	};
	await assert.rejects(withFileLock(lock, async () => {}, { close }), /injected token close failure/);
	assert.equal(existsSync(lock), false, "a failed token close must not poison the lock path");
});

test("withFileLock fails closed while another process owns the recovery gate", async () => {
	const lock = join(dir, "held-recovery-gate.lock");
	await writeFile(lock, `${hostname()}:999999-0`, "utf8");
	await mkdir(`${lock}.recovery`);
	let entered = false;
	const attempt = withFileLock(lock, async () => {
		entered = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(entered, false, "a waiter must not bypass a recovery owned by another process");
	await rm(`${lock}.recovery`, { recursive: true, force: true });
	await attempt;
	assert.equal(entered, true, "the waiter proceeds once the recovery owner releases its gate");
});

test("separate processes recovering one dead lock never overlap callbacks", async () => {
	const lock = join(dir, "cross-process-dead.lock");
	await writeFile(lock, `${hostname()}:999999-0`, "utf8");
	const storeModule = new URL("../src/core/store.ts", import.meta.url).href;
	const childSource = `
import { appendFile } from "node:fs/promises";
import { withFileLock } from ${JSON.stringify(storeModule)};
const lockPath = process.env.PPM_LOCK_PATH;
const eventPath = process.env.PPM_EVENT_PATH;
await withFileLock(lockPath, async () => {
  await appendFile(eventPath, \`enter:\${Date.now()}\\n\`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await appendFile(eventPath, \`exit:\${Date.now()}\\n\`);
});
`;
	const eventPaths = Array.from({ length: 12 }, (_, index) => join(dir, `cross-process-dead-${index}.events`));
	const children = eventPaths.map((eventPath) => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource], {
		cwd: process.cwd(),
		env: { ...process.env, PPM_LOCK_PATH: lock, PPM_EVENT_PATH: eventPath },
		stdio: ["ignore", "pipe", "pipe"],
	}));
	const completions = children.map((child) => new Promise<void>((resolve, reject) => {
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`child exited ${code ?? "null"}/${signal ?? "none"}: ${stderr}`));
		});
	}));
	await Promise.all(completions);
	const events = eventPaths.flatMap((eventPath) => readFileSync(eventPath, "utf8").trim().split("\n")).filter(Boolean).map((line) => {
		const [kind, timestamp] = line.split(":");
		return { kind, timestamp: Number(timestamp) };
	}).sort((a, b) => a.timestamp - b.timestamp || (a.kind === "exit" ? -1 : 1));
	assert.equal(events.length, eventPaths.length * 2, "every child entered and exited its callback");
	let active = 0;
	let maxActive = 0;
	for (const event of events) {
		if (event.kind === "enter") {
			active++;
			maxActive = Math.max(maxActive, active);
		} else {
			active--;
		}
	}
	assert.equal(active, 0, "all child callbacks exited");
	assert.equal(maxActive, 1, "cross-process dead-lock recovery serialized callbacks");
});

test("quarantineCorrupt moves a file aside to the first free suffix", async () => {
	const p = join(dir, "q.json");
	await writeFile(p, "garbage", "utf8");
	const dest = await quarantineCorrupt(p, "test");
	assert.equal(dest, `${p}.corrupt-0`);
	assert.ok(!existsSync(p), "original moved");
	assert.ok(existsSync(`${p}.corrupt-0`), "preserved at suffix 0");
});

test("quarantineCorrupt does not unlink a file atomically replaced after it was linked", async () => {
	const p = join(dir, "quarantine-race.json");
	const valid = JSON.stringify({ version: 1, updatedAt: "2026-07-16T00:00:00.000Z", sequence: 8, entries: [{ id: "safe", n: 8 }] });
	await writeFile(p, "corrupt", "utf8");
	const dest = await quarantineCorrupt(p, "test", {
		beforeRemove: async () => {
			await atomicWriteFile(p, valid);
		},
	});
	assert.equal(dest, null, "the stale quarantine claim was rejected after replacement");
	assert.equal(readFileSync(p, "utf8"), valid, "the concurrent valid write survived quarantine");
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
	await writeFile(lock, `${hostname()}:999999-0`, "utf8");
	const old = new Date(Date.now() - 60_000);
	await utimes(lock, old, old);
	// update must not hang; it steals the stale lock and commits
	const s = await store.update((es) => [...es, { id: "b", n: 2 }]);
	assert.equal(s.entries.length, 2);
	await stat(p); // still a valid file
});

test("does not time-steal an old foreign or unparseable lock", async () => {
	for (const [label, token] of [["foreign", "foreign-host:1234"], ["unparseable", "legacy-token"], ["malformed-local", `${hostname()}:999999`]] as const) {
		const lock = join(dir, `${label}-stale.lock`);
		await writeFile(lock, token, "utf8");
		const old = new Date(Date.now() - 60_000);
		await utimes(lock, old, old);
		let entered = false;
		const attempt = withFileLock(lock, async () => {
			entered = true;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(entered, false, "an unprobeable holder is not stolen solely because its mtime is old");
		} finally {
			await rm(lock, { force: true });
		}
		await attempt;
	}
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

test("two contenders recovering one dead lock never overlap callbacks", async () => {
	const lock = join(dir, "dead-contenders.lock");
	await writeFile(lock, `${hostname()}:999999-0`, "utf8");
	let active = 0;
	let maxActive = 0;
	const run = async (): Promise<void> => {
		await withFileLock(lock, async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 40));
			active--;
		});
	};
	await Promise.all([run(), run()]);
	assert.equal(maxActive, 1, "dead-lock recovery serialized both contenders");
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
