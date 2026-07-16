/**
 * Durable, cross-OS, concurrency-safe JSON persistence for pi-persona-mind's stores.
 *
 * A store is one JSON file rewritten in full. Without care, a crash mid-write leaves a torn
 * file that loads as a silent empty store (memory vanishes with no signal), and two writers
 * race with last-writer-wins. These primitives prevent both, using only the Node stdlib — no
 * native binding, no `flock`/`lockf` (so it works on Windows, unlike the POSIX-lock stores in
 * the Pi memory ecosystem):
 *
 *   1. {@link atomicWriteFile} — temp-in-same-dir → fsync → atomic rename. A crash before the
 *      rename leaves the prior file intact; never a partially-written store.
 *   2. {@link casUpdate} — the load→mutate→write runs inside a per-file advisory lockfile
 *      (`wx`/O_EXCL create, polled, with a stale-steal for a crashed holder and an ownership
 *      token so a stolen hold is never wrongly released). No committed write is lost.
 *   3. {@link quarantineCorrupt} — a file that fails validation is moved aside to `*.corrupt-N`
 *      (never silently replaced with empty, which would present absence as current fact).
 *
 * The pattern is adapted from OpenLore's `atomic-store.ts` (clay-good/openlore, MIT).
 */

import { access, copyFile, link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

/** Every persisted store carries the monotonic compare-and-swap counter. */
export interface StoreFile<E> {
	version: number;
	updatedAt: string;
	/** Monotonic write counter: orders writes and lets an external reader detect change. */
	sequence: number;
	entries: E[];
}

// Unique temp/lock suffixes per in-flight write: pid + a monotonic counter, so two concurrent
// writers to the same path never share a temp name (which would let one truncate the other's temp).
let tmpCounter = 0;
let lockSeq = 0;

/**
 * Write `data` to `path` atomically: to a sibling temp file, flushed to disk (`fsync`), then
 * moved into place with a single atomic `rename`. A crash before the rename leaves the previous
 * file untouched. The directory fsync is best-effort — Windows rejects it, and the data fsync
 * already bounds the loss.
 */
export async function atomicWriteFile(path: string, data: string): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${tmpCounter++}`);
	let renamed = false;
	try {
		const fh = await open(tmp, "w");
		try {
			await fh.writeFile(data, "utf-8");
			await fh.sync();
		} finally {
			await fh.close();
		}
		// Preserve the current (known-good) file as a last-known-good sidecar BEFORE we overwrite it,
		// so a later torn/truncated live file can be rolled back to it (JsonStore.load consults .bak
		// before quarantining). Best-effort: absent (first write) or unbackupable ⇒ skip.
		await copyFile(path, `${path}.bak`).catch(() => {});
		await rename(tmp, path);
		renamed = true;
	} finally {
		if (!renamed) await unlink(tmp).catch(() => {});
	}
	try {
		const dh = await open(dir, "r");
		try {
			await dh.sync();
		} finally {
			await dh.close();
		}
	} catch {
		/* directory fsync unsupported (e.g. Windows) — skip */
	}
}

// STALE < MAX_WAIT by design: a crashed holder's lock becomes stealable (10s) well before a waiter
// gives up (30s), so a wait timeout means genuine sustained contention (implausible for these tiny
// critical sections), never a dead holder.
const LOCK_STALE_MS = 10_000;
const LOCK_POLL_MS = 25;
const LOCK_MAX_WAIT_MS = 30_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Is the lock held by a LOCAL process that is already dead? The lock token is `host:pid-seq`; only
 * when the host matches ours can we probe the pid (`process.kill(pid, 0)`: ESRCH ⇒ gone). A token
 * from another machine (network FS) or an unparseable/legacy one returns false, so those fall back
 * to the time-based stale rule. Lets a crashed holder's lock be stolen instantly, with no wrongful
 * steal from a slow-but-alive holder.
 */
async function holderIsDeadLocal(lockPath: string): Promise<boolean> {
	let content: string;
	try {
		content = await readFile(lockPath, "utf-8");
	} catch {
		return false;
	}
	const colon = content.indexOf(":");
	if (colon < 0 || content.slice(0, colon) !== hostname()) return false;
	const pid = Number.parseInt(content.slice(colon + 1), 10);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false; // exists (alive)
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH"; // ESRCH ⇒ dead; EPERM ⇒ alive
	}
}

/**
 * Run `fn` while holding a per-file advisory lock (exclusive-create lockfile, polled, with a
 * stale-steal for a crashed holder). The lock carries an ownership token and is released only if
 * still ours, so a hold stolen as stale (e.g. a long GC pause) is never wrongly deleted.
 */
async function withCommitLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(dirname(lockPath), { recursive: true });
	const token = `${hostname()}:${process.pid}-${lockSeq++}`;
	const start = Date.now();
	for (;;) {
		try {
			const fh = await open(lockPath, "wx"); // exclusive create — fails if held
			await fh.writeFile(token);
			await fh.close();
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// A crashed LOCAL holder is stolen at once (no 10s wait); otherwise fall back to the
			// time-based stale rule for a holder we cannot probe (another host) or one still alive.
			if (await holderIsDeadLocal(lockPath)) {
				await unlink(lockPath).catch(() => {});
				continue;
			}
			try {
				const s = await stat(lockPath);
				if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
					await unlink(lockPath).catch(() => {});
					continue;
				}
			} catch {
				continue; // lock vanished between open and stat — retry
			}
			if (Date.now() - start > LOCK_MAX_WAIT_MS) {
				throw new Error(
					`mind store lock: timed out after ${LOCK_MAX_WAIT_MS}ms waiting for ${lockPath} ` +
						`(sustained write contention) — retry the operation`,
				);
			}
			await sleep(LOCK_POLL_MS);
		}
	}
	try {
		return await fn();
	} finally {
		try {
			if ((await readFile(lockPath, "utf-8")) === token) await unlink(lockPath).catch(() => {});
		} catch {
			/* lock already gone */
		}
	}
}

/**
 * Atomically read-modify-write a sequenced JSON store. The load→mutate→write runs inside the
 * per-store lock, so the lock (not an optimistic sequence guard) is the serialization point:
 * `mutate` always runs against the freshest on-disk store and a competing write cannot interleave.
 * `mutate` MUST be a pure merge over the loaded store; every writer MUST go through this function.
 */
export async function casUpdate<T extends { sequence: number }>(opts: {
	storePath: string;
	load: () => Promise<T>;
	mutate: (current: T) => T;
	serialize: (next: T) => string;
}): Promise<T> {
	const lockPath = `${opts.storePath}.lock`;
	return withCommitLock(lockPath, async () => {
		const current = await opts.load();
		const merged = opts.mutate(current);
		const next: T = { ...merged, sequence: current.sequence + 1 };
		await atomicWriteFile(opts.storePath, opts.serialize(next));
		return next;
	});
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Move a store that failed validation aside to `${path}.corrupt-<n>` (first free suffix, derived
 * from disk not wall-clock so recovery is reproducible), instead of silently substituting empty.
 * The claim is atomic (a hard link that fails if the destination exists), with a rename fallback
 * on filesystems without hard links. Returns the quarantine path, or null when unnecessary/impossible.
 */
export async function quarantineCorrupt(path: string, reason: string): Promise<string | null> {
	void reason;
	try {
		for (let n = 0; ; n++) {
			const dest = `${path}.corrupt-${n}`;
			try {
				await link(path, dest);
				await unlink(path);
				return dest;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "EEXIST") continue;
				if (code === "ENOENT") return null; // already moved by a concurrent loader
				if (code === "EPERM" || code === "ENOSYS" || code === "EXDEV" || code === "EMLINK") {
					let m = 0;
					while (await pathExists(`${path}.corrupt-${m}`)) m++;
					const dest2 = `${path}.corrupt-${m}`;
					await rename(path, dest2);
					return dest2;
				}
				throw err;
			}
		}
	} catch {
		return null; // could not move it aside — caller degrades to empty, loudly
	}
}

export interface JsonStoreOptions<E> {
	version: number;
	/** Validate one raw entry; return the typed entry, or null to drop it (schema drift). */
	validateEntry: (raw: unknown) => E | null;
	/** Wall clock for `updatedAt` (injectable for tests). Default Date.now. */
	now?: () => number;
	/** Surfacing for recovery events (quarantine). Default: none. */
	onWarn?: (message: string) => void;
}

/**
 * A typed, durable store of entries in one JSON file. Load degrades safely (missing → empty;
 * torn/invalid shape → quarantine + empty; individual invalid entries → dropped). Update is
 * serialized and atomic. The generic `E` is the entry type; the file wraps `E[]` with version
 * and the CAS sequence.
 */
export class JsonStore<E> {
	private readonly now: () => number;
	private readonly onWarn: (message: string) => void;

	constructor(
		readonly filePath: string,
		private readonly opts: JsonStoreOptions<E>,
	) {
		this.now = opts.now ?? Date.now;
		this.onWarn = opts.onWarn ?? (() => {});
	}

	private empty(): StoreFile<E> {
		return { version: this.opts.version, updatedAt: new Date(this.now()).toISOString(), sequence: 0, entries: [] };
	}

	/** Parse + validate raw store bytes into a StoreFile, or null on unparseable JSON / wrong shape. */
	private parseStore(raw: string): StoreFile<E> | null {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}
		if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) return null;
		const obj = parsed as Partial<StoreFile<unknown>>;
		const entries: E[] = [];
		for (const rawEntry of obj.entries as unknown[]) {
			const e = this.opts.validateEntry(rawEntry);
			if (e !== null) entries.push(e);
		}
		return {
			version: typeof obj.version === "number" ? obj.version : this.opts.version,
			updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date(this.now()).toISOString(),
			sequence: typeof obj.sequence === "number" ? obj.sequence : 0,
			entries,
		};
	}

	/** Try to recover the last-known-good `.bak` sidecar. Returns null if it is absent or also bad. */
	private async tryBak(): Promise<StoreFile<E> | null> {
		try {
			return this.parseStore(await readFile(`${this.filePath}.bak`, "utf-8"));
		} catch {
			return null;
		}
	}

	async load(): Promise<StoreFile<E>> {
		let raw: string;
		try {
			raw = await readFile(this.filePath, "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
			throw err;
		}
		const parsed = this.parseStore(raw);
		if (parsed) return parsed;
		// Live file is torn/invalid — roll back to the last-known-good backup before giving up.
		const bak = await this.tryBak();
		if (bak) {
			this.onWarn(`mind store: ${this.filePath} was corrupt — recovered from ${this.filePath}.bak (the last committed write may be lost)`);
			return bak;
		}
		const dest = await quarantineCorrupt(this.filePath, "unparseable / unexpected shape");
		this.onWarn(`mind store: ${this.filePath} was corrupt and had no usable backup — quarantined to ${dest ?? "(nowhere)"}, starting empty`);
		return this.empty();
	}

	/** Atomically apply `mutate` to the current entries and persist. Returns the committed store. */
	async update(mutate: (entries: E[]) => E[]): Promise<StoreFile<E>> {
		return casUpdate<StoreFile<E>>({
			storePath: this.filePath,
			load: () => this.load(),
			mutate: (current) => ({ ...current, updatedAt: new Date(this.now()).toISOString(), entries: mutate(current.entries) }),
			serialize: (next) => `${JSON.stringify(next, null, 2)}\n`,
		});
	}
}
