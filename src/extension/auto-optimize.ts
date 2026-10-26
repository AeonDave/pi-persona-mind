/** Event-driven maintenance: one visible Persona worker, bounded evidence, existing CAS writes. */
import { buildAutoPrompt, parseAutoProposal, selectAutoInputPage, type AutoOptimizeTarget } from "../core/auto-optimize.ts";
import type { MemoryOptimizer } from "../core/optimize-service.ts";
import type { MindWorkerAdmission, MindWorkerResult } from "./mind-worker.ts";
import type { OptimizeFailure, OptimizeInspection, OptimizePlan } from "../core/optimize.ts";

export const AUTO_INPUT_TOKEN_THRESHOLD = 1_000_000;
export const AUTO_COOLDOWN_MS = 5 * 60_000;
export const AUTO_IDLE_MS = 2_000;
export const AUTO_ATTEMPT_ENTRY = "pi-persona-mind-auto-attempt";
type Target = AutoOptimizeTarget;
type Optimizer = Pick<MemoryOptimizer, "inspect" | "preview" | "apply" | "invalidate">;
interface CoverageCursor { offset: number; withinPage: number }
export interface AutoAttempt { digest: string; at: number; state: "started" | "settled"; target?: Target }
export interface AutoOptimizeOwner {
	key: string; persona: string;
	allowedTargets: readonly Target[];
	current(): boolean; idle(): boolean;
	optimizer(): Optimizer;
	launch(task: string): MindWorkerAdmission;
	/** Must persist the proposal successfully before application is allowed. */
	report(title: string, body: string): void;
	recordAttempt(attempt: AutoAttempt): void;
	attempts: AutoAttempt[];
}
interface Options { now?: () => number; schedule?: (work: () => void, delay: number) => () => void }

export class AutoOptimizeScheduler {
	private readonly now: () => number;
	private readonly schedule: NonNullable<Options["schedule"]>;
	private owner: AutoOptimizeOwner | undefined;
	private enabled = true;
	private pending = new Set<Target>();
	private retryTargets = new Set<Target>();
	private cursors = new Map<Target, CoverageCursor>();
	private inputTokens = 0;
	private seen = new Set<string>();
	private lastAttempt = -Infinity;
	private generation = 0;
	private disabledGeneration = 0;
	private timer: (() => void) | undefined;
	private timerGeneration = 0;
	private running: { optimizer: Optimizer; cancel?: () => void; retryTarget?: Target; explicit?: boolean } | undefined;
	private work: Promise<void> = Promise.resolve();
	private last = "waiting for new memory";

	constructor(options: Options = {}) {
		this.now = options.now ?? Date.now;
		this.schedule = options.schedule ?? ((work, delay) => { const timer = setTimeout(work, delay); timer.unref(); return () => clearTimeout(timer); });
	}
	activate(owner: AutoOptimizeOwner, enabled = this.enabled): void {
		this.stop(); this.owner = owner; this.enabled = enabled;
		this.cursors = new Map(owner.allowedTargets.map((target) => [target, { offset: 0, withinPage: 0 }]));
		const settledDigests = new Set(owner.attempts.filter((attempt) => attempt.state === "settled").map((attempt) => attempt.digest));
		this.seen = new Set([...settledDigests].slice(-64));
		this.lastAttempt = Math.max(-Infinity, ...owner.attempts.filter((a) => a.at <= this.now()).map((a) => a.at));
		if (this.enabled) {
			for (const attempt of owner.attempts) {
				if (attempt.state === "started" && !settledDigests.has(attempt.digest) && attempt.target && owner.allowedTargets.includes(attempt.target)) {
					this.pending.add(attempt.target);
					this.retryTargets.add(attempt.target);
				}
			}
		}
		this.last = this.retryTargets.size ? "interrupted review pending" : "waiting for new memory";
	}
	stop(): void { this.interrupt(); this.owner = undefined; this.pending.clear(); this.retryTargets.clear(); this.cursors.clear(); this.inputTokens = 0; this.seen.clear(); this.lastAttempt = -Infinity; }
	interrupt(): void {
		this.timer?.(); this.timer = undefined; this.timerGeneration++; this.generation++;
		if (this.enabled && !this.running?.explicit && this.running?.retryTarget) {
			this.pending.add(this.running.retryTarget);
			this.retryTargets.add(this.running.retryTarget);
		}
		this.running?.optimizer.invalidate(); this.running?.cancel?.();
	}
	setEnabled(enabled: boolean): void {
		const wasEnabled = this.enabled;
		this.enabled = enabled;
		if (!enabled) {
			this.disabledGeneration++;
			this.interrupt();
			this.pending.clear();
			this.retryTargets.clear();
			this.last = "automatic review disabled";
		}
		else {
			if (!wasEnabled) this.last = "waiting for new memory";
			this.settled();
		}
	}
	status(): string {
		const remaining = Math.max(0, AUTO_INPUT_TOKEN_THRESHOLD - this.inputTokens);
		const retryPending = [...this.pending].some((target) => this.retryTargets.has(target));
		const gate = retryPending ? "interrupted review pending; retry follows cooldown without another token wait"
			: this.pending.size === 0 ? this.lastAttempt === -Infinity ? "first review waits for new memory" : "no dirty memory; new memory is required"
				: this.lastAttempt === -Infinity ? "first dirty review is ready after idle"
					: `dirty review pending; ${remaining.toLocaleString("en-US")} main input tokens remain`;
		return `${this.enabled ? "on" : "off"} · ${this.running ? "Mind worker active" : this.last} · ${gate} · ${this.inputTokens.toLocaleString("en-US")}/${AUTO_INPUT_TOKEN_THRESHOLD.toLocaleString("en-US")} main input tokens since last attempt`;
	}
	memoryAdded(target: Target): void { if (this.enabled && this.owner && this.allows(this.owner, target)) this.pending.add(target); }
	tokensUsed(mainInputTokens: number): void { if (this.owner && Number.isSafeInteger(mainInputTokens) && mainInputTokens > 0) this.inputTokens = Math.min(AUTO_INPUT_TOKEN_THRESHOLD, this.inputTokens + mainInputTokens); }
	settled(): void {
		const owner = this.owner;
		if (!this.enabled || !owner || !this.safeCurrent(owner) || !owner.idle() || this.running || this.timer || !this.pending.size) return;
		const tokenReady = this.lastAttempt === -Infinity || this.inputTokens >= AUTO_INPUT_TOKEN_THRESHOLD;
		const eligiblePending = [...this.pending].some((target) => this.allows(owner, target) && (this.retryTargets.has(target) || tokenReady));
		if (!eligiblePending) return;
		const generation = this.generation;
		const timerGeneration = ++this.timerGeneration;
		this.timer = this.schedule(() => {
			if (timerGeneration !== this.timerGeneration) return;
			this.timer = undefined;
			if (generation !== this.generation || this.running) return;
			this.work = this.run().catch(() => { this.last = "inspection failed; no automatic retry"; });
		}, Math.max(AUTO_IDLE_MS, this.lastAttempt + AUTO_COOLDOWN_MS - this.now()));
	}
	/** Start one user-requested bounded pass without automatic gates or preference checks. */
	startExplicit(target: Target): boolean {
		const owner = this.owner;
		if (!owner || !this.safeCurrent(owner) || !this.safeIdle(owner) || !this.allows(owner, target) || this.running) return false;
		this.timer?.(); this.timer = undefined; this.timerGeneration++;
		const generation = this.generation;
		this.work = this.run(target, true).catch(() => {
			if (generation !== this.generation || !this.safeCurrent(owner)) return;
			this.last = "explicit review failed; inspect current memory before retrying because apply may have completed";
			try { owner.report("Mind optimization result", `Bounded review failed unexpectedly; ${this.last}.`); } catch { /* owner reporting is best-effort */ }
		}).finally(() => {
			if (generation === this.generation && this.safeCurrent(owner) && this.safeIdle(owner) && this.pending.size) this.settled();
		});
		return true;
	}
	join(): Promise<void> { return this.work; }
	private safeCurrent(owner: AutoOptimizeOwner): boolean { try { return this.owner === owner && owner.current(); } catch { return false; } }
	private safeIdle(owner: AutoOptimizeOwner): boolean { try { return owner.idle(); } catch { return false; } }
	private allows(owner: AutoOptimizeOwner, target: Target): boolean { return owner.allowedTargets.includes(target); }
	private remember(owner: AutoOptimizeOwner, target: Target, digest: string, state: AutoAttempt["state"], at: number): void {
		owner.recordAttempt({ digest, target, at, state });
		if (state === "settled") {
			this.seen.add(digest); while (this.seen.size > 64) this.seen.delete(this.seen.values().next().value!);
		}
	}
	private async run(explicitTarget?: Target, explicit = false): Promise<void> {
		const owner = this.owner;
		if (!owner || (!explicit && !this.enabled) || !this.safeCurrent(owner) || !this.safeIdle(owner) || this.running) return;
		const generation = this.generation;
		const disabledGeneration = this.disabledGeneration;
		const current = () => generation === this.generation && (explicit || this.enabled) && this.safeIdle(owner) && this.safeCurrent(owner);
		const mayRetry = () => !explicit && this.enabled && this.disabledGeneration === disabledGeneration && this.safeCurrent(owner);
		const optimizer = owner.optimizer();
		const running: NonNullable<AutoOptimizeScheduler["running"]> = { optimizer, explicit };
		let attemptRecorded = false;
		let unsettledTarget: Target | undefined;
		let nextCursor: CoverageCursor | undefined;
		let retryRequiresSettled = false;
		this.running = running;
		try {
			for (const target of explicit ? [explicitTarget!] : [...this.pending]) {
				if (!this.allows(owner, target)) { this.pending.delete(target); this.retryTargets.delete(target); continue; }
				const retry = this.retryTargets.has(target);
				const tokenReady = this.lastAttempt === -Infinity || this.inputTokens >= AUTO_INPUT_TOKEN_THRESHOLD;
				if (!explicit && !retry && !tokenReady) continue;
				if (!explicit) this.pending.delete(target);
				const cursor = this.cursors.get(target) ?? { offset: 0, withinPage: 0 };
				let inspection: OptimizeInspection | OptimizeFailure;
				let newestInspection: OptimizeInspection | undefined;
				try {
					inspection = await optimizer.inspect(target, { max: 100, offset: cursor.offset });
					if (inspection.ok && cursor.offset > 0) {
						const latest = await optimizer.inspect(target, { max: 100, offset: 0 });
						if (latest.ok && latest.target === target && latest.fingerprint === inspection.fingerprint) newestInspection = latest;
						else {
						if (mayRetry()) this.pending.add(target);
						this.last = explicit ? "store changed during bounded inspection; the selected window was not reviewed" : "store changed during bounded inspection; waiting for the next settled event";
						if (explicit && current()) owner.report("Mind optimization result", `Bounded review stopped before worker admission: ${this.last}.`);
						return;
						}
					}
				}
				catch {
					if (!current()) {
						if (mayRetry()) this.pending.add(target);
						return;
					}
					this.last = "store inspection failed; see /mind doctor";
					if (explicit) owner.report("Mind optimization result", `Bounded review could not inspect this record window: ${this.last}.`);
					continue;
				}
				if (!current()) {
					// An interruption can invalidate the in-flight read without revoking the owner.
					// Keep its trigger so a later settled event can retry the inspection.
					if (mayRetry()) this.pending.add(target);
					return;
				}
				if (!inspection.ok) { this.last = "store inspection refused; see /mind doctor"; if (explicit) owner.report("Mind optimization result", `Bounded review stopped before worker admission: ${this.last}.`); continue; }
				if (inspection.target !== target) { this.last = "store inspection returned a different tier; no worker started"; if (explicit) owner.report("Mind optimization result", `Bounded review stopped before worker admission: ${this.last}.`); continue; }
				const page = selectAutoInputPage(inspection, owner.persona, cursor.withinPage, newestInspection);
				nextCursor = page.pageComplete
					? { offset: inspection.nextOffset ?? 0, withinPage: 0 }
					: { offset: cursor.offset, withinPage: page.nextRotation };
				const input = page.input;
				if (!input) {
					this.cursors.set(target, nextCursor);
					this.retryTargets.delete(target);
					this.last = "no eligible records in this bounded page";
					if (explicit) owner.report("Mind optimization result", `Bounded coverage: no eligible records in the selected window; ${this.last}.`);
					continue;
				}
				if (!explicit && this.seen.has(input.digest)) {
					this.cursors.set(target, nextCursor);
					this.retryTargets.delete(target);
					this.last = "this bounded record set was already reviewed";
					continue;
				}
				const worker = owner.launch(buildAutoPrompt(input));
				if (!worker.ok) {
					if (!explicit) this.pending.add(target);
					this.last = worker.reason;
					if (explicit && current()) owner.report("Mind optimization result", `Bounded review was not admitted: ${worker.reason}. No memory changed.`);
					return;
				}
				const attemptAt = this.now();
				running.cancel = worker.cancel;
				running.retryTarget = target;
				this.retryTargets.delete(target);
				if (!explicit) { this.lastAttempt = attemptAt; this.inputTokens = 0; }
				this.last = "Mind is reviewing memory";
				unsettledTarget = target;
				const settle = (): void => {
					if (!explicit) this.remember(owner, target, input.digest, "settled", attemptAt);
					if (nextCursor) this.cursors.set(target, nextCursor);
					unsettledTarget = undefined;
				};
				try {
					if (!explicit) {
						this.remember(owner, target, input.digest, "started", attemptAt);
						attemptRecorded = true;
					}
				} catch {
					try { running.cancel?.(); } catch { /* best-effort stop before apply */ }
					this.last = "attempt could not be saved; worker cancelled before apply";
					return;
				}
				const result = await worker.completion;
				if (!current()) return;
				if (workerWasStopped(result)) {
					if (!explicit) {
						retryRequiresSettled = true;
						this.pending.add(target);
						this.retryTargets.add(target);
					}
					unsettledTarget = undefined;
					this.last = explicit ? "explicit review stopped; memory unchanged" : "review interrupted; waiting for the next settled event";
					if (explicit && current()) owner.report("Mind optimization result", this.last);
					return;
				}
				if (!result.ok) { settle(); this.last = "worker failed; memory unchanged"; owner.report(explicit ? "Mind optimization result" : "Mind automatic optimization", `Bounded review · ${this.last}${result.error ? `: ${result.error}` : ""}`); return; }
				const parsed = parseAutoProposal(result.output, input);
				if (!parsed.ok) { settle(); this.last = "proposal refused; memory unchanged"; owner.report(explicit ? "Mind optimization result" : "Mind automatic optimization", `Bounded review · ${this.last}: ${parsed.reason}`); return; }
				const provenance = `Worker ${worker.runId} · ${worker.model} · ${worker.thinking}${result.resultRef ? `\nTerminal report: ${result.resultRef}` : ""}`;
				if (!parsed.operations.length) { settle(); this.last = "bounded review found no safe consolidation in this record set"; owner.report(explicit ? "Mind optimization result" : "Mind automatic optimization", `Bounded coverage: one selected record window; ${this.last}.\n${provenance}`); return; }
				const plan = await optimizer.preview({ target: input.target, fingerprint: input.fingerprint, operations: parsed.operations });
				if (!current()) return;
				if (!plan.ok) { settle(); this.last = "store or proposal changed; nothing applied"; owner.report(explicit ? "Mind optimization result" : "Mind automatic optimization", `Bounded coverage: one selected record window; ${this.last}: ${plan.reason}\n${provenance}`); return; }
				owner.report(explicit ? "Mind optimization proposal" : "Mind automatic proposal", `${provenance}\n${formatAutoPlan(plan)}\n${explicit ? "Validated apply pending" : "Automatic apply pending"}; it proceeds only while this owner and snapshot remain current.`);
				if (!current()) { optimizer.invalidate(); return; }
				const applied = await optimizer.apply(plan.planId);
				if (!current()) return;
				settle();
				this.last = applied.ok ? `${applied.beforeCount} → ${applied.afterCount} memories; ${applied.changed} replacement(s)` : `not applied: ${applied.reason}`;
				const receipt = applied.ok
					? applied.receiptId ? `\nUndo: /mind optimize undo ${applied.receiptId} ${applied.target}.` : "\nNo durable undo receipt was returned."
					: "";
				const warning = applied.ok && applied.warning ? `\nWarning: ${applied.warning}` : "";
				owner.report(explicit ? "Mind optimization result" : "Mind automatic result", `Bounded coverage: one selected record window; ${this.last}\n${provenance}${receipt}${warning}`);
			return; // One worker per pass; other dirty tiers wait for the input floor and cooldown.
			}
		} finally {
			optimizer.invalidate();
			if (this.running === running) this.running = undefined;
			if (unsettledTarget !== undefined && !current() && mayRetry()) {
				this.pending.add(unsettledTarget);
				this.retryTargets.add(unsettledTarget);
				this.last = "review interrupted; waiting for the next settled event";
			}
			// One actual attempt may leave other dirty tiers pending; they need the input floor
			// and cooldown. Only the same interrupted target bypasses the token floor.
			if (!explicit && attemptRecorded && this.pending.size > 0 && current() && !retryRequiresSettled) this.settled();
		}
	}
}

function workerWasStopped(result: MindWorkerResult): boolean {
	return result.status === "stopped";
}

function formatAutoPlan(plan: OptimizePlan): string {
	return `Staged proposed change · ${plan.beforeCount} entries → ${plan.afterCount}\n${JSON.stringify(plan.changes, null, 2)}`;
}
