/** Bounded write-ahead before images. Missing/corrupt history is never repaired to empty. */
import { isExpired, memoryContentKey, validateMemory, type MemoryEntry } from "./memory.ts";
import { isOptimizeTarget, MAX_OPTIMIZE_OPERATIONS, MAX_OPTIMIZE_SOURCES, samePersistedMemory, safeOptimizeMemory, type OptimizeChange, type OptimizeFailure, type OptimizeTarget } from "./optimize.ts";
import { JsonStore, withFileLock } from "./store.ts";

export const MAX_OPTIMIZE_HISTORY = 32;
export const MAX_OPTIMIZE_HISTORY_BYTES = 2 * 1024 * 1024;
export interface OptimizeReceipt {
	receiptId: string;
	planId: string;
	target: OptimizeTarget;
	persona: string;
	createdAt: string;
	/** Prepared may mean interrupted before OR after memory commit; exact facts decide undo. */
	state: "prepared" | "applied" | "undone" | "rejected";
	storePath: string;
	changes: OptimizeChange[];
}
export interface OptimizeHistory {
	ok: true; target: OptimizeTarget; receipts: OptimizeReceipt[]; retained: number; omitted: number;
	limit: number; maxBytes: number; withheldUnsafe: number;
}
export interface OptimizeUndone { ok: true; receiptId: string; target: OptimizeTarget; restored: number; warning?: string }

function validateReceipt(raw: unknown): OptimizeReceipt | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Partial<OptimizeReceipt>;
	if (![value.receiptId, value.planId].every((id) => typeof id === "string" && /^[\da-f-]{36}$/i.test(id))) return null;
	if (!isOptimizeTarget(value.target) || typeof value.persona !== "string" || !value.persona || value.persona.length > 128) return null;
	if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return null;
	if (!["prepared", "applied", "undone", "rejected"].includes(value.state ?? "")) return null;
	if (typeof value.storePath !== "string" || value.storePath.length > 32_768 || !value.storePath) return null;
	if (!Array.isArray(value.changes) || !value.changes.length || value.changes.length > MAX_OPTIMIZE_OPERATIONS) return null;
	const changes: OptimizeChange[] = [];
	const sourceIds = new Set<string>(); const replacementIds = new Set<string>();
	for (const change of value.changes) {
		if (!change || !Array.isArray(change.before) || !change.before.length || change.before.length > MAX_OPTIMIZE_SOURCES) return null;
		const before: MemoryEntry[] = [];
		for (const source of change.before) {
			const entry = validateMemory(source);
			if (!entry || sourceIds.has(entry.id)) return null;
			sourceIds.add(entry.id); before.push(entry);
		}
		const after = validateMemory(change.after);
		if (!after || replacementIds.has(after.id)) return null;
		replacementIds.add(after.id); changes.push({ before, after });
	}
	return { receiptId: value.receiptId!, planId: value.planId!, target: value.target, persona: value.persona, createdAt: value.createdAt,
		state: value.state!, storePath: value.storePath, changes };
}

/** Strict CAS avoids JsonStore.update's recovery semantics, which are unsuitable for recovery logs. */
export class OptimizeHistoryStore {
	private readonly store: JsonStore<OptimizeReceipt>;
	readonly path: string;
	constructor(path: string, now: () => number) {
		this.path = path;
		this.store = new JsonStore(path, { version: 1, validateEntry: validateReceipt, maxBytes: MAX_OPTIMIZE_HISTORY_BYTES, maxEntries: MAX_OPTIMIZE_HISTORY, now });
	}
	async exclusive<T>(run: () => Promise<T>): Promise<T> { return withFileLock(`${this.path}.transaction.lock`, run); }
	async read(): Promise<OptimizeReceipt[]> { return (await this.store.inspectStrict()).store.entries; }
	async prepare(receipt: OptimizeReceipt): Promise<void> {
		const snapshot = await this.store.inspectStrict();
		const entries = [...snapshot.store.entries, receipt];
		// Only settled history can be evicted. An unresolved crash intent may own the only before image.
		const bytes = () => Buffer.byteLength(`${JSON.stringify({ ...snapshot.store, sequence: snapshot.store.sequence + 1, entries }, null, 2)}\n`, "utf8");
		while (entries.length > MAX_OPTIMIZE_HISTORY || bytes() > MAX_OPTIMIZE_HISTORY_BYTES) {
			const index = entries.findIndex((entry) => entry.receiptId !== receipt.receiptId && entry.state !== "prepared");
			if (index < 0) throw new Error("optimizer history capacity exhausted by recovery receipts; replacement refused");
			entries.splice(index, 1);
		}
		await this.store.compareAndUpdate(snapshot.fingerprint, () => entries);
	}
	async settle(receiptId: string, state: OptimizeReceipt["state"]): Promise<void> {
		const snapshot = await this.store.inspectStrict();
		if (!snapshot.store.entries.some((receipt) => receipt.receiptId === receiptId)) throw new Error("optimizer recovery receipt disappeared; history requires repair");
		await this.store.compareAndUpdate(snapshot.fingerprint, (entries) => entries.map((receipt) => receipt.receiptId === receiptId ? { ...receipt, state } : receipt));
	}
}

/** Revert only exact affected rows, never a whole historical snapshot. */
export function restoreReceipt(entries: readonly MemoryEntry[], receipt: OptimizeReceipt, persona: string, now: number): { ok: true; entries: MemoryEntry[]; restored: number } | OptimizeFailure {
	if (receipt.persona !== persona) return { ok: false, reason: "receipt belongs to a different persona owner" };
	if (receipt.state === "undone" || receipt.state === "rejected") return { ok: false, reason: "receipt was already undone or its replacement was rejected" };
	const before = receipt.changes.flatMap((change) => change.before);
	const after = receipt.changes.map((change) => change.after);
	if ([...before, ...after].some((entry) => !safeOptimizeMemory(entry))) return { ok: false, reason: "receipt contains unsafe memory content" };
	if ((receipt.target === "project" || receipt.target === "project-long") && [...before, ...after].some((entry) => entry.persona !== persona)) return { ok: false, reason: "receipt contains foreign or unowned project facts" };
	if ([...before, ...after].some((entry) => isExpired(entry, now))) return { ok: false, reason: "receipt contains expired sources; undo cannot revive expired memory" };
	const selected = new Set<MemoryEntry>();
	for (const replacement of after) {
		const matches = entries.filter((entry) => entry.id === replacement.id);
		if (matches.length !== 1 || !samePersistedMemory(matches[0]!, replacement)) return { ok: false, reason: "affected replacement changed or is missing; undo refused" };
		selected.add(matches[0]!);
	}
	const untouched = entries.filter((entry) => !selected.has(entry));
	for (const source of before) {
		if (untouched.some((entry) => entry.id === source.id || memoryContentKey(entry) === memoryContentKey(source))) return { ok: false, reason: "restored source collides with a current fact; undo refused" };
	}
	return { ok: true, entries: [...untouched, ...structuredClone(before)], restored: before.length };
}
