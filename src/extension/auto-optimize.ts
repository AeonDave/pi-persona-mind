/** Event-driven maintenance: one visible Persona worker, bounded evidence, existing CAS writes. */
import { buildAutoPrompt, parseAutoProposal, selectAutoInputPage, type AutoInputPage, type AutoInputSkipReason, type AutoOptimizeTarget } from "../core/auto-optimize.ts";
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
	/** Current writable tiers, in the order a bare explicit request will review. */
	targets(): readonly Target[] { return this.owner ? [...new Set(this.owner.allowedTargets)].slice(0, 3) : []; }
	/** Start one named pass, or one bounded sequential pass over every allowed nonshared tier. */
	startExplicit(target?: Target): boolean {
		const owner = this.owner;
		if (!owner || !this.safeCurrent(owner) || !this.safeIdle(owner) || this.running || (target !== undefined && !this.allows(owner, target))) return false;
		const targets = target === undefined ? [...this.targets()] : [target];
		if (targets.length === 0) return false;
		this.timer?.(); this.timer = undefined; this.timerGeneration++;
		const generation = this.generation;
		const qualifyTargets = target === undefined;
		this.work = this.run(targets, true, qualifyTargets).catch(() => {
			if (generation !== this.generation || !this.safeCurrent(owner) || !this.safeIdle(owner)) return;
			this.last = "explicit review failed; inspect current memory before retrying because apply may have completed";
			const label = targets.join(", ");
			try { owner.report(qualifyTargets ? `Mind optimization result — ${targets[0]}` : "Mind optimization result", qualifyTargets ? `Targets ${label} — failed unexpectedly; inspect current memory before retrying because apply may have completed.\n${this.last}.` : `Bounded review failed unexpectedly; ${this.last}.`); } catch { /* owner reporting is best-effort */ }
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
	private async run(explicitTargets?: readonly Target[], explicit = false, qualifyTargets = false): Promise<void> {
		const owner = this.owner;
		if (!owner || (!explicit && !this.enabled) || !this.safeCurrent(owner) || !this.safeIdle(owner) || this.running) return;
		const generation = this.generation;
		const disabledGeneration = this.disabledGeneration;
		const current = () => generation === this.generation && (explicit || this.enabled) && this.safeIdle(owner) && this.safeCurrent(owner);
		const mayRetry = () => !explicit && this.enabled && this.disabledGeneration === disabledGeneration && this.safeCurrent(owner);
		const targets = explicit ? explicitTargets ?? [] : [...this.pending];
		let optimizer: Optimizer;
		try { optimizer = owner.optimizer(); } catch (error) {
			if (!explicit) throw error;
			if (!current()) return;
			this.last = "optimizer setup failed; no worker started, no memory changed";
			const body = `${qualifyTargets ? "Batch stopped; not reviewed" : "Target not reviewed"}: ${targets.join(", ")}.\nBounded review could not start: ${this.last}. See /mind doctor.`;
			try { owner.report(qualifyTargets ? `Mind optimization result — ${targets[0]}` : "Mind optimization result", body); } catch { /* owner reporting is best-effort */ }
			return;
		}
		const running: NonNullable<AutoOptimizeScheduler["running"]> = { optimizer, explicit };
		let attemptRecorded = false;
		let unsettledTarget: Target | undefined;
		let nextCursor: CoverageCursor | undefined;
		let retryRequiresSettled = false;
		let activeTarget: Target | undefined;
		const report = (target: Target, title: string, body: string, summary?: string, stopped = false): boolean => {
			if (!current()) return false;
			const remaining = stopped && qualifyTargets ? targets.slice(targets.indexOf(target) + 1) : [];
			const stoppedLine = remaining.length ? `Batch stopped; not reviewed: ${remaining.join(", ")}.\n` : "";
			const outcome = `${summary ?? body.split("\n", 1)[0] ?? "review result"}${remaining.length ? ` · not reviewed: ${remaining.join(", ")}` : ""}`;
			const qualifiedBody = qualifyTargets && !body.startsWith("Target:")
				? `Target: ${target} — ${outcome}\n${stoppedLine}${body}`
				: body;
			owner.report(qualifyTargets ? `${title} — ${target}` : title, qualifiedBody);
			return true;
		};
		this.running = running;
		try {
			for (const target of targets) {
				activeTarget = target;
				if (!current()) return;
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
							if (explicit) report(target, "Mind optimization result", `Bounded review stopped before worker admission: ${this.last}.`, "inspection snapshot changed; no worker started", true);
							return;
						}
					}
				} catch {
					if (!current()) {
						if (mayRetry()) this.pending.add(target);
						return;
					}
					this.last = "store inspection failed; see /mind doctor";
					if (explicit) report(target, "Mind optimization result", `Bounded review could not inspect this record window: ${this.last}.`, "inspection failed; no worker started", true);
					if (explicit) return;
					continue;
				}
				if (!current()) {
					// An interruption can invalidate the in-flight read without revoking the owner.
					// Keep its trigger so a later settled event can retry the inspection.
					if (mayRetry()) this.pending.add(target);
					return;
				}
				if (!inspection.ok) {
					this.last = "store inspection refused; see /mind doctor";
					if (explicit) report(target, "Mind optimization result", `Bounded review stopped before worker admission: ${this.last}.`, "inspection refused; no worker started", true);
					if (explicit) return;
					continue;
				}
				if (inspection.target !== target) {
					this.last = "store inspection returned a different tier; no worker started";
					if (explicit) report(target, "Mind optimization result", `Bounded review stopped before worker admission: ${this.last}.`, "inspection returned the wrong target; no worker started", true);
					if (explicit) return;
					continue;
				}
				const page = selectAutoInputPage(inspection, owner.persona, cursor.withinPage, newestInspection);
				nextCursor = page.pageComplete
					? { offset: inspection.nextOffset ?? 0, withinPage: 0 }
					: { offset: cursor.offset, withinPage: page.nextRotation };
				const input = page.input;
				if (!input) {
					this.cursors.set(target, nextCursor);
					this.retryTargets.delete(target);
					this.last = "no eligible records in this bounded page";
					if (explicit && !report(target, "Mind optimization result", formatAutoInputSkip(target, inspection, page))) return;
					continue;
				}
				if (!explicit && this.seen.has(input.digest)) {
					this.cursors.set(target, nextCursor);
					this.retryTargets.delete(target);
					this.last = "this bounded record set was already reviewed";
					continue;
				}
				if (!current()) return;
				const worker = owner.launch(buildAutoPrompt(input));
				if (!worker.ok) {
					if (!explicit) this.pending.add(target);
					this.last = worker.reason;
					if (explicit) report(target, "Mind optimization result", `Bounded review was not admitted: ${worker.reason}. No memory changed.`, "worker admission refused; no memory changed", true);
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
					if (explicit) report(target, "Mind optimization result", this.last, "worker stopped; memory unchanged", true);
					return;
				}
				const provenance = `Worker ${worker.runId} · ${worker.model} · ${worker.thinking}${result.resultRef ? `\nTerminal report: ${result.resultRef}` : ""}`;
				if (!result.ok) {
					settle(); this.last = "worker failed; memory unchanged";
					report(target, explicit ? "Mind optimization result" : "Mind automatic optimization", `Bounded review · ${this.last}${result.error ? `: ${result.error}` : ""}\n${provenance}`, "worker failed; memory unchanged", explicit);
					return;
				}
				const parsed = parseAutoProposal(result.output, input);
				if (!parsed.ok) {
					settle(); this.last = "proposal refused; memory unchanged";
					report(target, explicit ? "Mind optimization result" : "Mind automatic optimization", `Bounded review · ${this.last}: ${parsed.reason}\n${provenance}`, "proposal refused; memory unchanged", explicit);
					return;
				}
				if (!parsed.operations.length) {
					settle(); this.last = "bounded review found no safe consolidation in this record set";
					report(target, explicit ? "Mind optimization result" : "Mind automatic optimization", `Bounded coverage: one selected record window; ${this.last}.\n${provenance}`, "reviewed no-op; no safe consolidation in this window");
					if (!explicit) return;
					continue;
				}
				if (!current()) return;
				const plan = await optimizer.preview({ target: input.target, fingerprint: input.fingerprint, operations: parsed.operations });
				if (!current()) return;
				if (!plan.ok) {
					settle(); this.last = "store or proposal changed; nothing applied";
					report(target, explicit ? "Mind optimization result" : "Mind automatic optimization", `Bounded coverage: one selected record window; ${this.last}: ${plan.reason}\n${provenance}`, "proposal refused or stale; nothing applied", explicit);
					return;
				}
				if (!report(target, explicit ? "Mind optimization proposal" : "Mind automatic proposal", `${provenance}\n${formatAutoPlan(plan)}\n${explicit ? "Validated apply pending" : "Automatic apply pending"}; it proceeds only while this owner and snapshot remain current.`, "proposal staged; validated apply pending")) return;
				if (!current()) return;
				const applied = await optimizer.apply(plan.planId);
				if (!current()) return;
				settle();
				this.last = applied.ok ? `${applied.beforeCount} → ${applied.afterCount} memories; ${applied.changed} replacement(s)` : `not applied: ${applied.reason}`;
				const receipt = applied.ok
					? applied.receiptId ? `\nUndo: /mind optimize undo ${applied.receiptId} ${applied.target}.` : "\nNo durable undo receipt was returned."
					: "";
				const warning = applied.ok && applied.warning ? `\nWarning: ${applied.warning}` : "";
				const resultSummary = applied.ok
					? `${applied.changed} replacement${applied.changed === 1 ? "" : "s"} applied${applied.warning ? "; receipt finalization warning" : ""}`
					: `not applied: ${applied.reason}`;
				if (!report(target, explicit ? "Mind optimization result" : "Mind automatic result", `Bounded coverage: one selected record window; ${this.last}\n${provenance}${receipt}${warning}`, resultSummary, explicit && (!applied.ok || Boolean(applied.warning)))) return;
				if (!applied.ok || applied.warning || !explicit) return;
			}
		} catch (error) {
			if (!explicit) throw error;
			this.last = "explicit review failed unexpectedly; inspect current memory before retrying because apply may have completed";
			if (activeTarget && current()) report(activeTarget, "Mind optimization result", `Bounded review failed unexpectedly; ${this.last}.`, "review failed unexpectedly; inspect current memory before retrying", true);
		} finally {
			try { optimizer.invalidate(); } catch { /* Run-local plan cleanup cannot change completed review/apply results. */ }
			if (this.running === running) this.running = undefined;
			if (unsettledTarget !== undefined && !current() && mayRetry()) {
				this.pending.add(unsettledTarget);
				this.retryTargets.add(unsettledTarget);
				this.last = "review interrupted; waiting for the next settled event";
			}
			// One actual attempt may leave other dirty tiers pending; they need the input floor
			// and cooldown. Only the same interrupted tier bypasses the token floor.
			if (!explicit && attemptRecorded && this.pending.size > 0 && current() && !retryRequiresSettled) this.settled();
		}
	}
}

export function formatAutoInputSkip(target: Target, inspection: OptimizeInspection, page: Extract<AutoInputPage, { reason: AutoInputSkipReason }>): string {
	const offset = Number.isSafeInteger(inspection.offset) && inspection.offset >= 0 ? inspection.offset : 0;
	const returned = Array.isArray(inspection.entries) ? inspection.entries.length : 0;
	const matched = Number.isSafeInteger(inspection.matched) && inspection.matched >= 0 ? inspection.matched : 0;
	const total = Number.isSafeInteger(inspection.total) && inspection.total >= 0 ? inspection.total : 0;
	const eligible = Number.isSafeInteger(page.eligibleCount) && page.eligibleCount >= 0 ? page.eligibleCount : 0;
	const coverage = page.pageComplete ? "candidate page covered" : `within-page rotation continues at ${page.nextRotation}`;
	const morePages = inspection.nextOffset === undefined ? "" : `; further inspection page starts at ${inspection.nextOffset}`;
	const reasons = {
		"invalid-input": "the bounded input or owner identity was invalid",
		"empty-page": "the selected page is empty or exhausted; this does not establish that the whole target is empty",
		"no-safe-owned-facts": "this page contains no safe, owned eligible facts",
		"single-short-record": "the only admitted safe, owned fact in this selected window is shorter than the 1,200-character single-record minimum",
		"input-budget": "the 24,000-character input budget cannot admit enough full records in this window; records are not split or truncated",
	} satisfies Record<AutoInputSkipReason, string>;
	const headlines: Record<AutoInputSkipReason, string> = {
		"invalid-input": "invalid input",
		"empty-page": "empty/exhausted page",
		"no-safe-owned-facts": "no safe/owned facts",
		"single-short-record": "single fact under 1,200 characters",
		"input-budget": "full-record input budget too small",
	};
	return `Target: ${target} — skipped: ${headlines[page.reason]}; no worker started, no memory changed.\nSelected page offset ${offset}: ${returned} record(s) returned of ${matched} inspection matches; ${eligible} safe/owned eligible record(s); ${total} active record(s) in this target; ${coverage}${morePages}.\nReason: ${reasons[page.reason]}.`;
}

function workerWasStopped(result: MindWorkerResult): boolean {
	return result.status === "stopped";
}

function formatAutoPlan(plan: OptimizePlan): string {
	return `Staged proposed change · ${plan.beforeCount} entries → ${plan.afterCount}\n${JSON.stringify(plan.changes, null, 2)}`;
}
