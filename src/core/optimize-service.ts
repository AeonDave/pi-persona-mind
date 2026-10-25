/** Session-local staged plans over strict one-file memory snapshots. No model calls or hidden jobs. */
import { randomUUID } from "node:crypto";
import { isExpired, MAX_RECALL_QUERY_CHARS, type MemoryEntry } from "./memory.ts";
import { MAX_OPTIMIZE_HISTORY, MAX_OPTIMIZE_HISTORY_BYTES, OptimizeHistoryStore, restoreReceipt, type OptimizeHistory, type OptimizeReceipt, type OptimizeUndone } from "./optimize-history.ts";
import {
	isOptimizeTarget, MAX_OPTIMIZE_ENTRIES, MAX_OPTIMIZE_PLANS, OPTIMIZE_PLAN_TTL_MS,
	optimizeCandidates, planConsolidation, safeOptimizeMemory,
	type OptimizeApplied, type OptimizeFailure, type OptimizeInspection, type OptimizeInspectOptions,
	type OptimizePlan, type OptimizePreviewInput, type OptimizeTarget,
} from "./optimize.ts";
import { DEFAULT_STORE_MAX_ENTRIES, type JsonStore, StoreConflictError, withFileLock } from "./store.ts";

export interface MemoryOptimizerOptions {
	stores: Record<OptimizeTarget, JsonStore<MemoryEntry>>;
	persona: string;
	now?: () => number;
	/** Shares MindService's mutation ordering with promote/forget/reset. */
	mutationLock?: string;
	/** Defaults to a scope-bound sidecar beside each target store. */
	historyPaths?: Partial<Record<OptimizeTarget, string>>;
}
interface StagedPlan { plan: OptimizePlan; next: MemoryEntry[] }

function failure(error: unknown): OptimizeFailure {
	return { ok: false, reason: error instanceof Error ? error.message : "memory optimizer storage failure" };
}

export class MemoryOptimizer {
	private readonly options: MemoryOptimizerOptions;
	private readonly now: () => number;
	private readonly plans = new Map<string, StagedPlan>();
	private readonly histories = new Map<OptimizeTarget, OptimizeHistoryStore>();
	private generation = 0;
	constructor(options: MemoryOptimizerOptions) {
		this.options = { ...options, stores: { ...options.stores } };
		this.now = options.now ?? Date.now;
	}

	/** Ownership/lifecycle adapters discard this instance or explicitly invalidate its plans. */
	invalidate(): void { this.plans.clear(); this.generation++; }

	async inspect(target: OptimizeTarget = "project", options: OptimizeInspectOptions = {}): Promise<OptimizeInspection | OptimizeFailure> {
		if (!isOptimizeTarget(target)) return { ok: false, reason: "unknown memory optimizer target" };
		if (options.query !== undefined && (typeof options.query !== "string" || options.query.length > MAX_RECALL_QUERY_CHARS)) return { ok: false, reason: `query exceeds ${MAX_RECALL_QUERY_CHARS} characters` };
		const offset = options.offset ?? 0;
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > DEFAULT_STORE_MAX_ENTRIES) return { ok: false, reason: `offset must be an integer from 0 to ${DEFAULT_STORE_MAX_ENTRIES}` };
		try {
			const snapshot = await this.options.stores[target].inspectStrict();
			const active = snapshot.store.entries.filter((entry) => !isExpired(entry, this.now()));
			const query = options.query?.trim().toLowerCase();
			const eligible = active.filter((entry) => safeOptimizeMemory(entry) && (!query || `${entry.text} ${entry.tags.join(" ")}`.toLowerCase().includes(query)));
			const max = options.max === undefined || !Number.isFinite(options.max) ? 20 : Math.max(1, Math.min(MAX_OPTIMIZE_ENTRIES, Math.floor(options.max)));
			const entries = eligible.slice().sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || a.id.localeCompare(b.id)).slice(offset, offset + max);
			const nextOffset = offset + entries.length;
			return { ok: true, target, fingerprint: snapshot.fingerprint, entries, total: active.length, withheld: active.length - entries.length, candidates: optimizeCandidates(entries), offset, matched: eligible.length,
				...(nextOffset < eligible.length ? { nextOffset } : {}) };
		} catch (error) { return failure(error); }
	}

	async preview(input: OptimizePreviewInput): Promise<OptimizePlan | OptimizeFailure> {
		const target = input.target ?? "project";
		if (!isOptimizeTarget(target)) return { ok: false, reason: "unknown memory optimizer target" };
		try {
			const snapshot = await this.options.stores[target].inspectStrict();
			if (snapshot.fingerprint !== input.fingerprint) return { ok: false, reason: "memory store changed since inspection; inspect again" };
			const now = this.now();
			const result = planConsolidation(snapshot.store.entries, input.operations, target, this.options.persona, now);
			if (!result.ok) return result;
			const plan: OptimizePlan = { ok: true, planId: randomUUID(), target, fingerprint: snapshot.fingerprint, expiresAt: new Date(now + OPTIMIZE_PLAN_TTL_MS).toISOString(), changes: result.changes, beforeCount: snapshot.store.entries.length, afterCount: result.entries.length };
			this.expirePlans();
			while (this.plans.size >= MAX_OPTIMIZE_PLANS) this.plans.delete(this.plans.keys().next().value!);
			this.plans.set(plan.planId, structuredClone({ plan, next: result.entries }));
			return structuredClone(plan);
		} catch (error) { return failure(error); }
	}

	getPlan(planId: string): OptimizePlan | OptimizeFailure {
		this.expirePlans();
		const stored = this.plans.get(planId);
		return stored ? structuredClone(stored.plan) : { ok: false, reason: "plan not found or expired; inspect and stage again" };
	}

	async apply(planId: string): Promise<OptimizeApplied | OptimizeFailure> {
		this.expirePlans();
		const staged = this.plans.get(planId);
		if (!staged) return { ok: false, reason: "plan not found or expired; inspect and stage again" };
		try {
			let receiptId: string | undefined;
			let warning: string | undefined;
			const commit = async () => this.historyStore(staged.plan.target).exclusive(async () => {
				const assertCurrent = () => {
					if (this.plans.get(planId) !== staged || this.now() >= Date.parse(staged.plan.expiresAt)) throw new Error("plan expired or invalidated; inspect and stage again");
					if (staged.plan.changes.some((change) => change.before.some((entry) => isExpired(entry, this.now())))) throw new Error("a source expired since preview; inspect and stage again");
				};
				assertCurrent();
				const store = this.options.stores[staged.plan.target];
				if ((await store.inspectStrict()).fingerprint !== staged.plan.fingerprint) throw new StoreConflictError();
				const history = this.historyStore(staged.plan.target);
				if (staged.plan.changes.length) {
					receiptId = randomUUID();
					const receipt: OptimizeReceipt = { receiptId, planId, target: staged.plan.target, persona: this.options.persona, createdAt: new Date(this.now()).toISOString(), state: "prepared", storePath: store.filePath, changes: structuredClone(staged.plan.changes) };
					await history.prepare(receipt);
				}
				let callbackRejected = false;
				try {
					await store.compareAndUpdate(staged.plan.fingerprint, () => {
						try { assertCurrent(); return structuredClone(staged.next); }
						catch (error) { callbackRejected = true; throw error; }
					});
				} catch (error) {
					// A generic IO failure may occur after rename. Preserve its prepared before images.
					if (receiptId && (callbackRejected || error instanceof StoreConflictError)) await history.settle(receiptId, "rejected").catch(() => {});
					throw error;
				}
				this.plans.delete(planId);
				if (receiptId) {
					try { await history.settle(receiptId, "applied"); }
					catch { warning = "replacement committed; durable receipt remains prepared because history finalization failed"; }
				}
			});
			if (this.options.mutationLock) await withFileLock(this.options.mutationLock, commit); else await commit();
			return { ok: true, planId, target: staged.plan.target, changed: staged.plan.changes.length, beforeCount: staged.plan.beforeCount, afterCount: staged.plan.afterCount, ...(receiptId ? { receiptId } : {}), ...(warning ? { warning } : {}) };
		} catch (error) { return failure(error); }
	}

	async history(target: OptimizeTarget = "project", max = 20): Promise<OptimizeHistory | OptimizeFailure> {
		if (!isOptimizeTarget(target)) return { ok: false, reason: "unknown memory optimizer target" };
		if (!Number.isFinite(max) || max < 1) return { ok: false, reason: "history max must be a positive finite number" };
		try {
			const storePath = this.options.stores[target].filePath;
			const all = (await this.historyStore(target).read()).filter((receipt) => receipt.target === target && receipt.storePath === storePath && receipt.persona === this.options.persona);
			const safe = all.filter((receipt) => receipt.changes.every((change) => [...change.before, change.after].every(safeOptimizeMemory)));
			const receipts = safe.slice().reverse().slice(0, Math.min(MAX_OPTIMIZE_HISTORY, Math.floor(max)));
			return { ok: true, target, receipts, retained: all.length, omitted: safe.length - receipts.length, withheldUnsafe: all.length - safe.length, limit: MAX_OPTIMIZE_HISTORY, maxBytes: MAX_OPTIMIZE_HISTORY_BYTES };
		} catch (error) { return failure(error); }
	}

	async undo(receiptId: string, target?: OptimizeTarget): Promise<OptimizeUndone | OptimizeFailure> {
		const generation = this.generation;
		if (target !== undefined && !isOptimizeTarget(target)) return { ok: false, reason: "unknown memory optimizer target" };
		try {
			const candidates: OptimizeTarget[] = target ? [target] : ["project", "project-long", "persona", "shared"];
			for (const candidate of candidates) {
				const history = this.historyStore(candidate);
				const found = (await history.read()).some((receipt) => receipt.receiptId === receiptId && receipt.target === candidate && receipt.storePath === this.options.stores[candidate].filePath);
				if (!found) continue;
				const commit = async () => history.exclusive(async (): Promise<OptimizeUndone | OptimizeFailure> => {
					const receipt = (await history.read()).find((entry) => entry.receiptId === receiptId && entry.target === candidate && entry.storePath === this.options.stores[candidate].filePath);
					if (!receipt) return { ok: false, reason: "optimizer receipt is no longer retained" };
					const store = this.options.stores[candidate];
					const snapshot = await store.inspectStrict();
					let restored = 0;
					await store.compareAndUpdate(snapshot.fingerprint, (entries) => {
						if (this.generation !== generation) throw new Error("memory owner changed; undo invalidated before commit");
						const result = restoreReceipt(entries, receipt, this.options.persona, this.now());
						if (!result.ok) throw new Error(result.reason);
						restored = result.restored;
						return result.entries;
					});
					try { await history.settle(receiptId, "undone"); }
					catch { return { ok: true, receiptId, target: candidate, restored, warning: "undo committed; history finalization failed, affected-fact checks prevent duplicate undo" }; }
					return { ok: true, receiptId, target: candidate, restored };
				});
				return this.options.mutationLock ? await withFileLock(this.options.mutationLock, commit) : await commit();
			}
			return { ok: false, reason: "optimizer receipt not found in this scope or no longer retained" };
		} catch (error) { return failure(error); }
	}

	private historyStore(target: OptimizeTarget): OptimizeHistoryStore {
		let history = this.histories.get(target);
		if (!history) {
			history = new OptimizeHistoryStore(this.options.historyPaths?.[target] ?? `${this.options.stores[target].filePath}.optimize-history.json`, this.now);
			this.histories.set(target, history);
		}
		return history;
	}

	private expirePlans(): void {
		for (const [id, staged] of this.plans) if (this.now() >= Date.parse(staged.plan.expiresAt)) this.plans.delete(id);
	}
}
