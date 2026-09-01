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
 *      (`wx`/O_EXCL create, polled, with dead-local recovery for a crashed holder and an ownership
 *      token so a stolen hold is never wrongly released). No committed write is lost.
 *   3. {@link quarantineCorrupt} — a file that fails validation is moved aside to `*.corrupt-N`
 *      (never silently replaced with empty, which would present absence as current fact).
 *
 * The pattern is adapted from OpenLore's `atomic-store.ts` (clay-good/openlore, MIT).
 */

import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { copyFile, link, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { basename, dirname, join } from "node:path";

/** Every persisted store carries the monotonic compare-and-swap counter. */
export interface StoreFile<E> {
	version: number;
	updatedAt: string;
	/** Monotonic write counter: orders writes and lets an external reader detect change. */
	sequence: number;
	entries: E[];
}

/** Defensive defaults for out-of-band/corrupt stores. Normal stores are far smaller than these. */
export const DEFAULT_STORE_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_STORE_MAX_ENTRIES = 10_000;

// Lock tokens are process-local sequence values. Temp names use cryptographic randomness and are
// still opened with O_EXCL so a pre-created symlink can never be followed by a writer.
let lockSeq = 0;

// Invalid raw entries are retained only inside an update's private state. They are never returned by
// JsonStore.load(), but the next atomic rewrite can put them back verbatim instead of silently
// erasing data that the current validator does not understand yet.
const PRESERVED_INVALID_ENTRIES: unique symbol = Symbol("preservedInvalidEntries");
type InternalStoreFile<E> = StoreFile<E> & { [PRESERVED_INVALID_ENTRIES]?: unknown[] };

export interface AtomicWriteOptions {
	/** Refresh the `.bak` sidecar from the current live file only when this returns true for its
	 *  bytes. Guards against copying a torn file — one that load() just recovered FROM `.bak` — over
	 *  the only good backup, which would destroy the sole recoverable copy. Absent ⇒ always refresh. */
	backupIf?: (currentRaw: string) => boolean;
	/** Maximum live-file bytes read when evaluating `backupIf`; oversized files are not backed up. */
	maxBackupBytes?: number;
}

export type BoundedReadFailureKind = "bytes" | "entries" | "path";

export class BoundedReadFailure extends Error {
	constructor(readonly kind: BoundedReadFailureKind, message: string) {
		super(message);
		this.name = "BoundedReadFailure";
	}
}

/**
 * Thrown when a store envelope carries a version this build does not implement. It is deliberately
 * NOT a corruption signal: a store written by another version is intact, just unreadable here, so it
 * must be left in place (never quarantined, never overwritten) until a build that understands it —
 * or a migration — runs. Failing loudly is the only non-destructive answer available.
 */
export class StoreVersionError extends Error {
	constructor(readonly found: number, readonly expected: number) {
		super(`mind store version ${found} was written by a different pi-persona-mind build (this one reads version ${expected}); the file is left untouched`);
		this.name = "StoreVersionError";
	}
}

/** Thrown before an update writes a store that the next bounded load would reject. */
export class StoreCapacityError extends Error {
	constructor(readonly kind: "bytes" | "entries", readonly actual: number, readonly limit: number) {
		super(`mind store capacity: ${kind} ${actual} exceeds limit ${limit}`);
		this.name = "StoreCapacityError";
	}
}

const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
const readFlags: string | number = noFollow === undefined ? "r" : fsConstants.O_RDONLY | noFollow;

function sameFile(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

const LOCK_POLL_MS = 25;
const LOCK_MAX_WAIT_MS = 30_000;
const REPLACE_MAX_WAIT_MS = 30_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type LockStats = { dev: number; ino: number };

export interface FileLockOptions {
	/** Internal seam used to prove cleanup when closing a newly-created lock handle fails. */
	close?: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>;
}

async function unlinkIfSameFile(path: string, expected: LockStats): Promise<void> {
	try {
		const current = await lstat(path);
		if (sameFile(expected, current)) await unlink(path).catch(() => {});
	} catch {
		/* the failed acquisition may already have been cleaned up */
	}
}

/** Create a lockfile and clean up its inode if writing or closing the handle fails. */
async function createLockFile(
	lockPath: string,
	token: string,
	closeHandle: (handle: Awaited<ReturnType<typeof open>>) => Promise<void> = (handle) => handle.close(),
): Promise<void> {
	const fh = await open(lockPath, "wx");
	let created: LockStats | undefined;
	try {
		created = await fh.stat();
		await fh.writeFile(token);
		await closeHandle(fh);
	} catch (err) {
		// A failed write can leave an empty/partial lock that no waiter can safely attribute. Close
		// the descriptor when possible, then remove only the inode this acquisition created.
		await fh.close().catch(() => {});
		if (created) await unlinkIfSameFile(lockPath, created);
		throw err;
	}
}

/** Read at most one byte beyond the fstat-observed size, rejecting symlinks, replacements, and floods. */
export async function readTextFileBounded(path: string, maxBytes: number): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("store maxBytes must be a positive safe integer");
	let listed;
	try {
		listed = await lstat(path);
	} catch (err) {
		throw err;
	}
	if (listed.isSymbolicLink()) throw new BoundedReadFailure("path", "store path is a symbolic link");
	if (!listed.isFile()) throw new BoundedReadFailure("path", "store path is not a regular file");

	let fh;
	try {
		fh = await open(path, readFlags);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ELOOP") {
			throw new BoundedReadFailure("path", "store path is a symbolic link");
		}
		throw err;
	}
	try {
		const opened = await fh.stat();
		if (!opened.isFile() || !sameFile(listed, opened)) {
			throw new BoundedReadFailure("path", "store path changed or is not a regular file");
		}
		const observedSize = opened.size;
		if (!Number.isSafeInteger(observedSize) || observedSize > maxBytes) {
			throw new BoundedReadFailure("bytes", `store file exceeds the ${maxBytes}-byte limit`);
		}
		const bytes = Buffer.allocUnsafe(observedSize + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const result = await fh.read(bytes, offset, bytes.length - offset, offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		if (offset > observedSize) throw new BoundedReadFailure("bytes", "store file grew while it was being read");
		const finalOpened = await fh.stat();
		if (!finalOpened.isFile() || !sameFile(opened, finalOpened) || finalOpened.size !== observedSize || offset !== observedSize) {
			throw new BoundedReadFailure("path", "store file changed or was truncated while it was being read");
		}
		const current = await lstat(path);
		if (current.isSymbolicLink() || !current.isFile() || !sameFile(opened, current) || current.size !== observedSize) {
			throw new BoundedReadFailure("path", "store path changed while it was being read");
		}
		return bytes.subarray(0, offset).toString("utf8");
	} finally {
		await fh.close();
	}
}

const MAX_LOCK_TOKEN_BYTES = 1024;

async function openRandomTemp(dir: string, base: string): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>> }> {
	for (let attempt = 0; attempt < 16; attempt++) {
		const path = join(dir, `.${base}.tmp-${randomBytes(16).toString("hex")}`);
		try {
			return { path, handle: await open(path, "wx") };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	}
	throw new Error(`mind store: could not allocate a unique temporary file beside ${base}`);
}

async function copyToRandomTemp(source: string, dir: string, base: string): Promise<string> {
	for (let attempt = 0; attempt < 16; attempt++) {
		const path = join(dir, `.${base}.tmp-${randomBytes(16).toString("hex")}`);
		try {
			await copyFile(source, path, fsConstants.COPYFILE_EXCL);
			return path;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	}
	throw new Error(`mind store: could not allocate a unique backup temporary file beside ${base}`);
}

/** Replace a destination path without ever opening/following an existing destination symlink. */
async function replacePath(staged: string, destination: string): Promise<void> {
	const started = performance.now();
	try {
		await rename(staged, destination);
		return;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
	}
	// Windows may reject rename over a live destination while another process still has an open
	// handle. Keep the staged bytes in place and retry the remove/rename sequence until that handle
	// closes. The destination identity is checked before unlinking so a concurrent replacement is
	// never removed by a stale retry.
	for (;;) {
		let observed;
		try {
			observed = await lstat(destination);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		if (observed) {
			let current;
			try {
				current = await lstat(destination);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw err;
			}
			if (!sameFile(observed, current)) continue;
			try {
				await unlink(destination);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
				if (performance.now() - started > REPLACE_MAX_WAIT_MS) throw err;
				await sleep(LOCK_POLL_MS);
				continue;
			}
		}
		try {
			await rename(staged, destination);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
			if (performance.now() - started > REPLACE_MAX_WAIT_MS) throw err;
			await sleep(LOCK_POLL_MS);
		}
	}
}

/**
 * Replace the live store atomically. Windows rejects rename-over-destination while a reader still
 * holds the destination open; retry the SAME rename (without unlinking the committed file) until
 * that short-lived reader closes. The old or new file is therefore always present.
 */
async function replaceLivePath(staged: string, destination: string): Promise<void> {
	const started = performance.now();
	for (;;) {
		try {
			await rename(staged, destination);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
			if (performance.now() - started > REPLACE_MAX_WAIT_MS) throw err;
			await sleep(LOCK_POLL_MS);
		}
	}
}

async function refreshBackup(source: string, destination: string): Promise<void> {
	const listed = await lstat(source);
	if (!listed.isFile()) return;
	const staged = await copyToRandomTemp(source, dirname(destination), basename(destination));
	let replaced = false;
	try {
		const current = await lstat(source);
		if (!current.isFile() || !sameFile(listed, current)) return;
		await replacePath(staged, destination);
		replaced = true;
	} finally {
		if (!replaced) await unlink(staged).catch(() => {});
	}
}

/** Lock metadata is trusted only when it is a tiny regular file; never read an attacker-sized token. */
async function readLockToken(lockPath: string): Promise<string | null> {
	let listed;
	try {
		listed = await lstat(lockPath);
		if (!listed.isFile()) return null;
		const fh = await open(lockPath, readFlags);
		try {
			const opened = await fh.stat();
			if (!opened.isFile() || !sameFile(listed, opened) || opened.size > MAX_LOCK_TOKEN_BYTES) return null;
			const bytes = Buffer.alloc(MAX_LOCK_TOKEN_BYTES);
			const result = await fh.read(bytes, 0, MAX_LOCK_TOKEN_BYTES, 0);
			if (result.bytesRead !== opened.size) return null;
			const current = await lstat(lockPath);
			if (!current.isFile() || !sameFile(opened, current) || current.size !== opened.size) return null;
			return bytes.subarray(0, result.bytesRead).toString("utf8");
		} finally {
			await fh.close();
		}
	} catch {
		return null;
	}
}

/**
 * Write `data` to `path` atomically: to a sibling temp file, flushed to disk (`fsync`), then
 * moved into place with a single atomic `rename`. A crash before the rename leaves the previous
 * file untouched. The directory fsync is best-effort — Windows rejects it, and the data fsync
 * already bounds the loss.
 */
export async function atomicWriteFile(path: string, data: string, opts: AtomicWriteOptions = {}): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const temp = await openRandomTemp(dir, basename(path));
	const tmp = temp.path;
	let renamed = false;
	try {
		const fh = temp.handle;
		try {
			await fh.writeFile(data, "utf-8");
			await fh.sync();
		} finally {
			await fh.close();
		}
		// Preserve the current (known-good) file as a last-known-good sidecar BEFORE we overwrite it,
		// so a later torn/truncated live file can be rolled back to it (JsonStore.load consults .bak
		// before quarantining). But never clobber a good .bak with a live file that isn't itself good
		// (a torn file we just recovered FROM .bak): that would destroy the only recoverable copy.
		try {
			if (!opts.backupIf) {
				await refreshBackup(path, `${path}.bak`);
			} else {
				const current = await readTextFileBounded(path, opts.maxBackupBytes ?? DEFAULT_STORE_MAX_BYTES);
				if (opts.backupIf(current)) await refreshBackup(path, `${path}.bak`);
			}
		} catch {
			/* no current file, unsafe path, or oversized current file — nothing to preserve */
		}
		await replaceLivePath(tmp, path);
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

// Dead-lock recovery is itself a critical section. The directory gate is process-wide (not merely
// an in-memory promise), and contenders check it before every acquisition attempt. A recovering
// process keeps the gate until it has installed its replacement token, so another process can never
// observe the old dead lock removed and enter the callback during the hand-off window.
const recoveryTails = new Map<string, Promise<void>>();
async function withRecoveryGate<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	const previous = recoveryTails.get(lockPath) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	recoveryTails.set(lockPath, current);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (recoveryTails.get(lockPath) === current) recoveryTails.delete(lockPath);
	}
}

function recoveryGatePath(lockPath: string): string {
	return `${lockPath}.recovery`;
}

async function recoveryGateExists(lockPath: string): Promise<boolean> {
	try {
		await lstat(recoveryGatePath(lockPath));
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		return true; // an unreadable gate is treated as held: fail closed, never race recovery
	}
}

/**
 * Is the lock held by a LOCAL process that is already dead? The lock token is `host:pid-seq`; only
 * when the host matches ours can we probe the pid (`process.kill(pid, 0)`: ESRCH ⇒ gone). A token
 * from another machine (network FS) or an unparseable/legacy one returns false and is never
 * stealable by age: without a trustworthy owner identity, time alone cannot distinguish a crashed
 * process from a slow-but-alive one.
 */
function tokenHolderIsDeadLocal(content: string): boolean {
	const match = /^([^:\r\n]+):([0-9]+)-([0-9]+)$/.exec(content);
	if (!match || match[1] !== hostname()) return false;
	const pid = Number(match[2]);
	if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(Number(match[3]))) return false;
	try {
		process.kill(pid, 0);
		return false; // exists (alive)
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH"; // ESRCH ⇒ dead; EPERM ⇒ alive
	}
}

/**
 * Recover a dead lock while holding a cross-process gate. The replacement lock is created before
 * the gate is released; this is the key ordering that prevents a second process from deleting a
 * fresh lock after observing the same old dead token. A recovery process that itself crashes leaves
 * the gate behind; waiters fail closed after the normal bounded wait instead of guessing that a
 * potentially live recovery owner is dead.
 */
async function recoverDeadLocalLock(
	lockPath: string,
	token: string,
	closeHandle: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<boolean> {
	return withRecoveryGate(lockPath, async () => {
		const gate = recoveryGatePath(lockPath);
		try {
			await mkdir(gate);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw err;
		}
		try {
			const observed = await readLockToken(lockPath);
			if (observed === null || !tokenHolderIsDeadLocal(observed)) return false;
			// Re-read immediately before removal while every other contender is required to honor `gate`.
			if ((await readLockToken(lockPath)) !== observed) return false;
			await unlink(lockPath);
			// Acquire the canonical lock before releasing the recovery gate. If this fails, the caller
			// will continue polling; importantly, no other contender can enter during this hand-off.
			await createLockFile(lockPath, token, closeHandle);
			return true;
		} finally {
			await rmdir(gate).catch(() => {});
		}
	});
}

/** Thrown internally when the commit lock was stolen mid-critical-section; {@link casUpdate} re-acquires. */
class LockLostError extends Error {}

/**
 * Run `fn` while holding a per-file advisory lock (exclusive-create lockfile, polled, with dead-local
 * recovery for a crashed holder). The lock carries an ownership token — passed to `fn` so it can
 * re-verify ownership before committing — and is released only if still ours, so a hold stolen after
 * proving its local owner is dead is never wrongly deleted. Foreign, malformed, or otherwise
 * unprobeable locks fail closed after the bounded wait instead of being stolen by age.
 */
export async function withFileLock<T>(lockPath: string, fn: (token: string) => Promise<T>, options: FileLockOptions = {}): Promise<T> {
	await mkdir(dirname(lockPath), { recursive: true });
	const token = `${hostname()}:${process.pid}-${lockSeq++}`;
	const start = performance.now();
	const closeHandle = options.close ?? ((handle: Awaited<ReturnType<typeof open>>) => handle.close());
	for (;;) {
		if (await recoveryGateExists(lockPath)) {
			if (performance.now() - start > LOCK_MAX_WAIT_MS) {
				throw new Error(
					`mind store lock: timed out after ${LOCK_MAX_WAIT_MS}ms waiting for ${lockPath} ` +
						`(recovery gate is held; retry the operation)`,
				);
			}
			await sleep(LOCK_POLL_MS);
			continue;
		}
		try {
			await createLockFile(lockPath, token, closeHandle);
			break;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				// Windows can report EPERM, rather than EEXIST, when another process has the
				// lockfile open. Treat it as contention only when the path can be observed; a
				// genuine permission failure on an absent/inaccessible path must still surface.
				if (code !== "EPERM") throw err;
				try {
					await lstat(lockPath);
				} catch (probeErr) {
					// On Windows an open racing with a concurrent unlink can report EPERM even
					// though the path has already vanished. Retry the acquisition; surfacing that
					// transient error would strand otherwise live writers.
					if ((probeErr as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw err;
				}
			}
			// A crashed LOCAL holder is stolen at once (no 10s wait).
			if (await recoverDeadLocalLock(lockPath, token, closeHandle)) {
				break;
			}
			// A LIVE local holder is genuinely mid-critical-section, while a foreign or malformed
			// token is unprobeable. Never time-steal either case: age cannot prove that the owner is
			// dead, and stealing could let both writers pass their ownership checks and lose a commit.
			if (performance.now() - start > LOCK_MAX_WAIT_MS) {
				throw new Error(
					`mind store lock: timed out after ${LOCK_MAX_WAIT_MS}ms waiting for ${lockPath} ` +
						`(sustained write contention) — retry the operation`,
				);
			}
			await sleep(LOCK_POLL_MS);
		}
	}
	try {
		return await fn(token);
	} finally {
		try {
			if ((await readLockToken(lockPath)) === token) await unlink(lockPath).catch(() => {});
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
	load: (token?: string) => Promise<T>;
	mutate: (current: T) => T;
	serialize: (next: T) => string;
	/** Forwarded to atomicWriteFile: gate the `.bak` refresh on the current live file being valid. */
	backupIf?: (currentRaw: string) => boolean;
	/** Forwarded to atomicWriteFile: bound the live bytes inspected for `.bak` refresh. */
	maxBackupBytes?: number;
}): Promise<T> {
	const lockPath = `${opts.storePath}.lock`;
	for (let attempt = 0; ; attempt++) {
		try {
			return await withFileLock(lockPath, async (token) => {
				const current = await opts.load(token);
				const merged = opts.mutate(current);
				const next: T = { ...merged, sequence: current.sequence + 1 };
				// Re-verify ownership before committing: recovery or a post-crash dual-steal could have
				// handed the lock to another writer while we loaded/mutated — writing now would overwrite
				// their committed entry with our stale snapshot. If we no longer own the lock, re-acquire.
				const owner = await readLockToken(lockPath);
				if (owner !== token) throw new LockLostError();
				const writeOptions: AtomicWriteOptions = {};
				if (opts.backupIf) writeOptions.backupIf = opts.backupIf;
				if (opts.maxBackupBytes !== undefined) writeOptions.maxBackupBytes = opts.maxBackupBytes;
				await atomicWriteFile(opts.storePath, opts.serialize(next), writeOptions);
				return next;
			});
		} catch (err) {
			if (err instanceof LockLostError && attempt < 5) continue; // re-acquire and retry
			throw err;
		}
	}
}

export interface QuarantineOptions {
	/** Existing store-lock ownership, used internally when the caller already holds the lock. */
	lockToken?: string;
	/** Test seam executed after the hard-link claim and before the source is removed. */
	beforeRemove?: () => Promise<void>;
}

async function quarantineUnderLock(path: string, opts: QuarantineOptions): Promise<string | null> {
	const lockPath = `${path}.lock`;
	for (let n = 0; ; n++) {
		const dest = `${path}.corrupt-${n}`;
		let original;
		try {
			original = await lstat(path);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
		try {
			await link(path, dest);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EEXIST") continue;
			if (code === "ENOENT") return null; // already moved by a concurrent loader
			if (code !== "EPERM" && code !== "ENOSYS" && code !== "EXDEV" && code !== "EMLINK") throw err;
			// Filesystems without hard links use rename, but still revalidate the source and lock first.
			if (opts.beforeRemove) await opts.beforeRemove();
			const current = await lstat(path);
			if (!sameFile(original, current) || (opts.lockToken !== undefined && (await readLockToken(lockPath)) !== opts.lockToken)) return null;
			let claimed = false;
			try {
				await rename(path, dest);
				claimed = true;
				return dest;
			} finally {
				if (!claimed) await unlink(dest).catch(() => {});
			}
		}
		try {
			if (opts.beforeRemove) await opts.beforeRemove();
			const current = await lstat(path);
			const claim = await lstat(dest);
			const ownsLock = opts.lockToken === undefined || (await readLockToken(lockPath)) === opts.lockToken;
			if (!sameFile(original, current) || !sameFile(original, claim) || !ownsLock) {
				await unlink(dest).catch(() => {});
				return null;
			}
			await unlink(path);
			return dest;
		} catch (err) {
			await unlink(dest).catch(() => {});
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
	}
}

/**
 * Move a store that failed validation aside to `${path}.corrupt-<n>` (first free suffix, derived
 * from disk not wall-clock so recovery is reproducible), instead of silently substituting empty.
 * Quarantine is serialized by the same per-store lock used by updates, and the hard-link claim is
 * revalidated before removal so a concurrent atomic replacement can never be unlinked.
 */
export async function quarantineCorrupt(path: string, reason: string, opts: QuarantineOptions = {}): Promise<string | null> {
	void reason;
	if (opts.lockToken !== undefined) {
		try {
			return await quarantineUnderLock(path, opts);
		} catch {
			return null;
		}
	}
	try {
		return await withFileLock(`${path}.lock`, async (token) => quarantineUnderLock(path, { ...opts, lockToken: token }));
	} catch {
		return null; // could not move it aside — caller degrades to empty, loudly
	}
}

export interface JsonStoreOptions<E> {
	version: number;
	/** Validate one raw entry; return the typed entry, or null to drop it (schema drift). */
	validateEntry: (raw: unknown) => E | null;
	/** Maximum bytes read from or written to a live or backup store. Defaults to {@link DEFAULT_STORE_MAX_BYTES}. */
	maxBytes?: number;
	/** Maximum entries accepted from a store wrapper. Defaults to {@link DEFAULT_STORE_MAX_ENTRIES}. */
	maxEntries?: number;
	/** Wall clock for `updatedAt` (injectable for tests). Default Date.now. */
	now?: () => number;
	/** Surfacing for recovery events (quarantine). Default: none. */
	onWarn?: (message: string) => void;
}

/**
 * A typed, durable store of entries in one JSON file. Load degrades safely (missing → empty;
 * torn/invalid shape → quarantine + empty; individual invalid entries → hidden and preserved).
 * Update is serialized and atomic. The generic `E` is the entry type; the file wraps `E[]` with
 * version and the CAS sequence.
 */
export class JsonStore<E> {
	private readonly now: () => number;
	private readonly onWarn: (message: string) => void;
	private readonly maxBytes: number;
	private readonly maxEntries: number;

	constructor(
		readonly filePath: string,
		private readonly opts: JsonStoreOptions<E>,
	) {
		this.now = opts.now ?? Date.now;
		this.onWarn = opts.onWarn ?? (() => {});
		this.maxBytes = opts.maxBytes ?? DEFAULT_STORE_MAX_BYTES;
		this.maxEntries = opts.maxEntries ?? DEFAULT_STORE_MAX_ENTRIES;
		if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) throw new RangeError("mind store maxBytes must be a positive safe integer");
		if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) throw new RangeError("mind store maxEntries must be a positive safe integer");
	}

	private empty(): StoreFile<E> {
		return { version: this.opts.version, updatedAt: new Date(this.now()).toISOString(), sequence: 0, entries: [] };
	}

	/** Parse + validate raw store bytes into a StoreFile, or null on unparseable JSON / wrong shape. */
	private parseStore(raw: string): InternalStoreFile<E> | null {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}
		if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) return null;
		const obj = parsed as Partial<StoreFile<unknown>>;
		if (obj.version !== this.opts.version) {
			// A well-formed envelope naming another version is a different build's store, not corruption:
			// surface it and leave the file alone. An absent/garbage version is envelope corruption.
			if (typeof obj.version === "number" && Number.isSafeInteger(obj.version) && obj.version > 0) throw new StoreVersionError(obj.version, this.opts.version);
			return null;
		}
		if (typeof obj.updatedAt !== "string" || !Number.isFinite(Date.parse(obj.updatedAt))) return null;
		if (typeof obj.sequence !== "number" || !Number.isSafeInteger(obj.sequence) || obj.sequence < 0) return null;
		const rawEntries = obj.entries as unknown[];
		if (rawEntries.length > this.maxEntries) {
			throw new BoundedReadFailure("entries", `store file exceeds the ${this.maxEntries}-entry limit`);
		}
		const entries: E[] = [];
		const invalidEntries: unknown[] = [];
		for (const rawEntry of rawEntries) {
			const e = this.opts.validateEntry(rawEntry);
			if (e !== null) entries.push(e);
			else invalidEntries.push(rawEntry);
		}
		const store: InternalStoreFile<E> = {
			version: obj.version,
			updatedAt: obj.updatedAt,
			sequence: obj.sequence,
			entries,
		};
		if (invalidEntries.length > 0) store[PRESERVED_INVALID_ENTRIES] = invalidEntries;
		return store;
	}

	private async restoreLive(store: InternalStoreFile<E>): Promise<void> {
		const invalidEntries = store[PRESERVED_INVALID_ENTRIES] ?? [];
		const persisted = invalidEntries.length > 0 ? { ...store, entries: [...store.entries, ...invalidEntries] } : store;
		await atomicWriteFile(this.filePath, `${JSON.stringify(persisted, null, 2)}\n`, {
			backupIf: () => false,
			maxBackupBytes: this.maxBytes,
		});
	}

	private async recoverFromBak(reason: string, lockToken?: string): Promise<InternalStoreFile<E> | null> {
		if (lockToken === undefined) {
			const peek = await this.tryBak();
			if (!peek) return null;
			return withFileLock(`${this.filePath}.lock`, async (token) => this.recoverFromBak(reason, token));
		}
		const bak = await this.tryBak();
		if (!bak) return null;
		this.onWarn(`mind store: ${this.filePath} ${reason}; recovered from ${this.filePath}.bak`);
		this.warnInvalidEntries(bak);
		await this.restoreLive(bak);
		return bak;
	}

	/** Try to recover the last-known-good `.bak` sidecar. Returns null if it is absent or also bad. */
	private async tryBak(): Promise<InternalStoreFile<E> | null> {
		try {
			return this.parseStore(await readTextFileBounded(`${this.filePath}.bak`, this.maxBytes));
		} catch (err) {
			if (err instanceof BoundedReadFailure) {
				this.onWarn(`mind store: ${this.filePath}.bak rejected — ${err.message}`);
			}
			return null;
		}
	}

	private warnInvalidEntries(store: InternalStoreFile<E>): void {
		const count = store[PRESERVED_INVALID_ENTRIES]?.length ?? 0;
		if (count === 0) return;
		this.onWarn(
			`mind store: ${this.filePath} contained ${count} invalid entr${count === 1 ? "y" : "ies"}; ` +
			"preserved raw and hidden from consumers",
		);
	}

	private async recoverBoundedFailure(failure: BoundedReadFailure, lockToken?: string): Promise<InternalStoreFile<E>> {
		if (lockToken === undefined) {
			// Keep healthy/missing reads non-blocking. A bounded failure is re-read under the same
			// store lock before quarantine so a writer that repaired the path wins the race safely.
			return withFileLock(`${this.filePath}.lock`, async (token) => this.loadInternal(token));
		}
		const bak = await this.recoverFromBak(`rejected — ${failure.message}`, lockToken);
		if (bak) return bak;
		const quarantineOptions: QuarantineOptions = {};
		if (lockToken !== undefined) quarantineOptions.lockToken = lockToken;
		const dest = await quarantineCorrupt(this.filePath, failure.message, quarantineOptions);
		this.onWarn(`mind store: ${this.filePath} rejected — ${failure.message}; no usable backup, quarantined to ${dest ?? "(nowhere)"}, starting empty`);
		return this.empty();
	}

	private async loadInternal(lockToken?: string): Promise<InternalStoreFile<E>> {
		let raw: string;
		try {
			raw = await readTextFileBounded(this.filePath, this.maxBytes);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				const bak = await this.recoverFromBak("missing", lockToken);
				return bak ?? this.empty();
			}
			if (err instanceof BoundedReadFailure) return this.recoverBoundedFailure(err, lockToken);
			throw err;
		}
		let parsed: InternalStoreFile<E> | null;
		try {
			parsed = this.parseStore(raw);
		} catch (err) {
			if (err instanceof BoundedReadFailure) return this.recoverBoundedFailure(err, lockToken);
			throw err;
		}
		if (parsed) {
			this.warnInvalidEntries(parsed);
			return parsed;
		}
		if (lockToken === undefined) {
			// The first read was only an optimistic check. Re-read while holding the update lock before
			// deciding whether the path is still corrupt and may be quarantined.
			return withFileLock(`${this.filePath}.lock`, async (token) => this.loadInternal(token));
		}
		// Live file is torn/invalid — roll back to the last-known-good backup before giving up.
		const bak = await this.recoverFromBak("was corrupt — the last committed write may be lost", lockToken);
		if (bak) return bak;
		const quarantineOptions: QuarantineOptions = {};
		if (lockToken !== undefined) quarantineOptions.lockToken = lockToken;
		const dest = await quarantineCorrupt(this.filePath, "unparseable / unexpected shape", quarantineOptions);
		this.onWarn(`mind store: ${this.filePath} was corrupt and had no usable backup — quarantined to ${dest ?? "(nowhere)"}, starting empty`);
		return this.empty();
	}

	async load(): Promise<StoreFile<E>> {
		const store = await this.loadInternal();
		return { version: store.version, updatedAt: store.updatedAt, sequence: store.sequence, entries: [...store.entries] };
	}

	/** Atomically apply `mutate` to the current entries and persist. Returns the committed store. */
	async update(mutate: (entries: E[]) => E[]): Promise<StoreFile<E>> {
		const next = await casUpdate<InternalStoreFile<E>>({
			storePath: this.filePath,
			load: (token) => this.loadInternal(token),
			mutate: (current) => ({ ...current, updatedAt: new Date(this.now()).toISOString(), entries: mutate(current.entries) }),
			serialize: (next) => {
				const invalidEntries = next[PRESERVED_INVALID_ENTRIES] ?? [];
				const persistedEntryCount = next.entries.length + invalidEntries.length;
				if (persistedEntryCount > this.maxEntries) {
					throw new StoreCapacityError("entries", persistedEntryCount, this.maxEntries);
				}
				const persisted = invalidEntries.length > 0 ? { ...next, entries: [...next.entries, ...invalidEntries] } : next;
				const serialized = `${JSON.stringify(persisted, null, 2)}\n`;
				const byteLength = Buffer.byteLength(serialized, "utf8");
				if (byteLength > this.maxBytes) throw new StoreCapacityError("bytes", byteLength, this.maxBytes);
				return serialized;
			},
			// Only refresh the .bak from a live file that still parses — never let a torn file we just
			// recovered from .bak overwrite that good backup.
			backupIf: (raw) => {
				try {
					return this.parseStore(raw) !== null;
				} catch {
					return false;
				}
			},
			maxBackupBytes: this.maxBytes,
		});
		return { version: next.version, updatedAt: next.updatedAt, sequence: next.sequence, entries: [...next.entries] };
	}
}
