/** Explicit evidence-grounded review. Proposals are data; only a separately approved CAS plan writes. */
import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MindService } from "../core/service.ts";
import type { MemoryOptimizer } from "../core/optimize-service.ts";
import type { OptimizePlan } from "../core/optimize.ts";
import { buildKnowledgeReviewTask, formatKnowledgeReview, parseKnowledgeReview, type ReviewPacket, type ReviewTarget } from "../core/knowledge-review.ts";
import { collectReviewEvidence, type ReviewEvidenceSnapshot } from "./review-evidence.ts";
import type { ReviewReservation } from "./auto-optimize.ts";
import type { MindWorkerAdmission } from "./mind-worker.ts";

export interface KnowledgeReviewDeps {
	captureOwner(ctx: ExtensionContext): () => boolean;
	mind(ctx: ExtensionContext): MindService;
	reserve(target: ReviewTarget): ReviewReservation | undefined;
	launch(ctx: ExtensionContext, task: string): MindWorkerAdmission;
	appendResult(ctx: ExtensionContext, title: string, body: string): void;
	collect?: typeof collectReviewEvidence;
}
interface PendingReview {
	ctx: ExtensionContext;
	current(): boolean;
	optimizer: MemoryOptimizer;
	packet: ReviewPacket;
	evidence: ReviewEvidenceSnapshot;
	body: string;
	expiresAt: number;
	plan?: OptimizePlan;
}

export function createKnowledgeReview(deps: KnowledgeReviewDeps) {
	let generation = 0;
	let dialogs = new AbortController();
	let preparing = false;
	let running: { cancel(): void } | undefined;
	let work: Promise<void> = Promise.resolve();
	let applyWork: Promise<void> = Promise.resolve();
	let pending: PendingReview | undefined;
	let applying = false;
	const collect = deps.collect ?? collectReviewEvidence;
	const notify = (ctx: ExtensionContext, message: string): void => ctx.ui.notify(message, "info");
	const drop = (): void => { pending?.optimizer.invalidate(); pending = undefined; };
	const interrupt = (): void => { generation++; dialogs.abort(); dialogs = new AbortController(); running?.cancel(); drop(); };
	const snapshot = (): PendingReview | undefined => {
		if (pending && (!pending.current() || Date.now() >= pending.expiresAt)) drop();
		return pending;
	};
	const requireCurrent = (current: () => boolean): void => { if (!current()) throw new Error("knowledge-review owner, branch or model changed"); };

	async function start(ctx: ExtensionContext, target: ReviewTarget, selectedId?: string): Promise<void> {
		if (target !== "project" && target !== "project-long" && target !== "persona") { notify(ctx, "Knowledge review supports project, project-long and persona only; shared/session are not writable review targets."); return; }
		if (preparing || running || applying) { notify(ctx, "Mind knowledge review is busy."); return; }
		if (snapshot()) { notify(ctx, "A knowledge review is already staged. Use /mind review show, apply or discard first."); return; }
		if (ctx.mode !== "tui" || !ctx.hasUI) { notify(ctx, "Knowledge review requires the interactive terminal for evidence selection and approval."); return; }
		if (!ctx.isIdle() || ctx.hasPendingMessages()) { notify(ctx, "Wait for the foreground to settle before starting a knowledge review."); return; }
		const accepted = generation;
		const signal = dialogs.signal;
		const owner = deps.captureOwner(ctx);
		const current = () => accepted === generation && owner();
		requireCurrent(current);
		const mind = deps.mind(ctx);
		const scope = mind.inspectionScope();
		if (scope.homeWorkspace && target !== "persona") { notify(ctx, "Home allows persona review only; no project evidence is read."); return; }
		preparing = true;
		let reservation: ReviewReservation | undefined;
		let optimizer: MemoryOptimizer | undefined;
		try {
			optimizer = mind.createOptimizer();
			const inspection = await optimizer.inspect(target, { max: 100 });
			requireCurrent(current);
			if (!inspection.ok) throw new Error(inspection.reason);
			let memories = inspection.entries.filter((entry) => target === "persona" || entry.persona === scope.persona);
			if (selectedId) {
				// A selected row can be beyond the first page. Full-read it, then bind staging to
				// the already captured raw store fingerprint; concurrent changes still refuse CAS.
				const found = await mind.readMemory(selectedId, target === "project-long" || target === "project" ? "project" : "persona");
				requireCurrent(current);
				if (!found.ok) throw new Error(found.reason);
				memories = found.entries.filter((entry) => entry.target === target && (target === "persona" || entry.entry.persona === scope.persona)).map(({ entry }) => entry);
				if (memories.length !== 1) throw new Error("selected memory is unavailable or ambiguous in this owner/target");
			}
			// Full facts only: never silently feed a chopped assertion to the reviewer.
			const admitted = [] as typeof memories;
			let bytes = 0;
			for (const memory of memories) {
				const size = JSON.stringify(memory).length;
				if (admitted.length < 6 && bytes + size <= 12_000) { admitted.push(memory); bytes += size; }
			}
			if (!admitted.length) { notify(ctx, "No complete safe owned facts fit this bounded review. No worker started."); return; }
			const pathsInput = scope.homeWorkspace ? "" : await ctx.ui.input("Repository evidence for knowledge review", "Explicit relative files, comma-separated (e.g. README.md, package.json); empty = user-role messages only", { signal });
			requireCurrent(current);
			if (pathsInput === undefined) return;
			const paths = pathsInput.split(/[\n,]/).map((path) => path.trim()).filter(Boolean);
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable";
			const acceptedByUser = await ctx.ui.confirm("Review knowledge — no automatic changes", `${admitted.length} complete ${target} fact(s). Evidence: ${paths.length ? paths.join(", ") : "no repository files"} and bounded active-branch user-role text (authorship/quotes must be assessed). Worker: ${model}, current session model; additional model usage. Corrections will require separate approval. Retirement recommendations never delete automatically. Continue?`, { signal });
			requireCurrent(current);
			if (!acceptedByUser) return;
			reservation = deps.reserve(target);
			if (!reservation) { notify(ctx, "Mind maintenance or the foreground is busy. No review worker started."); return; }
			const evidence = await collect(ctx, paths, current);
			requireCurrent(current);
			if (!reservation.current()) throw new Error("Mind maintenance reservation was revoked; no worker started.");
			if (!evidence.evidence.length) {
				deps.appendResult(ctx, "Mind knowledge review — no evidence", `No safe evidence was admitted; no worker started.\n${evidence.coverage.join("\n")}`);
				notify(ctx, "No safe evidence was admitted. No worker started; inspect the coverage report."); return;
			}
			const packet: ReviewPacket = { target, memories: admitted, evidence: evidence.evidence, coverage: [
				`${admitted.length} full facts supplied from a bounded inspection of ${inspection.entries.length} records; store has ${inspection.total} active records. This is not a complete archive review.`,
				...(selectedId ? [`Explicitly selected memory: ${selectedId}.`] : []), ...evidence.coverage,
			] };
			const task = buildKnowledgeReviewTask(packet);
			evidence.assertFresh(); requireCurrent(current);
			const admission = deps.launch(ctx, task);
			if (!admission.ok) throw new Error(admission.reason);
			const lease = reservation;
			const reviewOptimizer = optimizer;
			running = admission;
			reservation = undefined; optimizer = undefined;
			work = (async () => {
				let completed = false;
				try {
					lease.launched(createHash("sha256").update(`knowledge-review\n${task}`).digest("hex"));
					const result = await admission.completion;
					requireCurrent(current);
					if (!lease.current()) throw new Error("Mind maintenance reservation was revoked.");
					if (!result.ok || result.status !== "done") throw new Error("Knowledge review stopped or failed; no changes were applied.");
					completed = true;
					const parsed = parseKnowledgeReview(result.output, packet);
					if (!parsed.ok) throw new Error(`Knowledge review proposal refused: ${parsed.reason}`);
					evidence.assertFresh(); requireCurrent(current);
					let plan: OptimizePlan | undefined;
					if (parsed.operations.length) {
						const staged = await reviewOptimizer.preview({ target, fingerprint: inspection.fingerprint, operations: parsed.operations });
						requireCurrent(current);
						if (!staged.ok) throw new Error(staged.reason);
						plan = staged;
					}
					const body = `${formatKnowledgeReview(packet, parsed.findings)}\n\nWorker: ${admission.runId} · ${admission.model}${result.resultRef ? ` · result: ${result.resultRef}` : ""}\n${plan ? `${plan.changes.length} correction(s) staged, not applied. Plan expires at ${plan.expiresAt}. /mind review apply asks for approval; /mind review discard abandons this plan.` : "No executable corrections. Retirement recommendations require a separate deliberate memory forget; nothing was deleted."}\nUse /mind review show to inspect this report again. Source references are evidence supplied to an LLM, not independently verified truth.`;
					deps.appendResult(ctx, "Mind knowledge review — proposal", body);
					requireCurrent(current);
					pending = { ctx, current, optimizer: reviewOptimizer, packet, evidence, body, expiresAt: plan ? Date.parse(plan.expiresAt) : Date.now() + 600_000, ...(plan ? { plan } : {}) };
					notify(ctx, `mind · ${target} knowledge review ready; no changes applied. /mind review show`);
				} catch (error) {
					reviewOptimizer.invalidate();
					admission.cancel();
					await admission.completion.catch(() => {});
					if (current()) {
						try { deps.appendResult(ctx, "Mind knowledge review — not applied", error instanceof Error ? error.message : "Knowledge review failed."); }
						catch { /* no persistence fallback and no application */ }
						notify(ctx, "mind · knowledge review did not stage changes; inspect the report.");
					}
				} finally {
					if (completed && current()) { try { lease.settled(); } catch { notify(ctx, "Mind review accounting could not be persisted; inspect /mind doctor before retrying."); } }
					lease.release();
					if (running === admission) running = undefined;
				}
			})();
			notify(ctx, `mind · ${target} evidence review started on ${admission.model}; inspect the result before applying.`);
		} catch (error) {
			if (current()) notify(ctx, error instanceof Error ? error.message : "Knowledge review unavailable.");
		} finally { reservation?.release(); optimizer?.invalidate(); preparing = false; }
	}

	async function show(ctx: ExtensionContext): Promise<void> {
		const review = snapshot();
		if (!review) { notify(ctx, running || preparing ? "Knowledge review is running." : "No active knowledge review; start /mind review [project|project-long|persona]."); return; }
		deps.appendResult(ctx, "Mind knowledge review — staged", review.body);
	}
	function apply(ctx: ExtensionContext): Promise<void> {
		const review = snapshot();
		if (!review?.plan) { notify(ctx, "No executable correction plan is staged. Retirement recommendations are not deletions."); return Promise.resolve(); }
		if (applying || preparing || running || !ctx.isIdle() || ctx.hasPendingMessages()) { notify(ctx, "Mind or the foreground is busy; no review changes applied."); return Promise.resolve(); }
		if (ctx.mode !== "tui" || !ctx.hasUI) { notify(ctx, "Applying a knowledge review requires interactive approval."); return Promise.resolve(); }
		const plan = review.plan;
		applying = true;
		// Register before any dialog/report callback can reenter lifecycle cleanup. Rejected
		// overlapping calls must never replace the promise for the admitted writer.
		applyWork = Promise.resolve().then(async () => {
			let lease: ReviewReservation | undefined;
			let applyAttempted = false;
			let committed = false;
			try {
				if (snapshot() !== review) return;
				deps.appendResult(ctx, "Mind knowledge review — approve these corrections", review.body);
				const approved = await ctx.ui.confirm("Apply knowledge corrections?", `Apply exactly ${plan.changes.length} displayed correction(s) to ${review.packet.target}? No retirement recommendations will be deleted. Sources, scope and store freshness will be checked again; consolidation history/undo is retained.`, { signal: dialogs.signal });
				if (!approved) return;
				if (snapshot() !== review) throw new Error("Knowledge review changed or expired; inspect again.");
				lease = deps.reserve(review.packet.target);
				if (!lease) throw new Error("Mind maintenance is busy; no review changes applied.");
				const fresh = () => { requireCurrent(review.current); if (pending !== review || !lease?.current()) throw new Error("Review plan or maintenance reservation invalidated"); review.evidence.assertFresh(); };
				fresh();
				applyAttempted = true;
				const result = await review.optimizer.apply(plan.planId, fresh);
				committed = result.ok;
				if (!review.current()) return;
				if (!result.ok) throw new Error(result.reason);
				drop();
				deps.appendResult(ctx, "Mind knowledge review — applied", `${result.changed} correction(s) applied to ${result.target}.${result.receiptId ? ` Undo receipt: ${result.receiptId}. Use /mind optimize undo ${result.receiptId} ${result.target}.` : ""}${result.warning ? `\nWarning: ${result.warning}` : ""}`);
				notify(ctx, `mind · ${result.target} · ${result.changed} reviewed correction(s) applied`);
			} catch (error) {
				if (review.current()) {
					const reason = error instanceof Error ? error.message : "Review apply failed";
					notify(ctx, committed ? `Corrections were applied, but reporting failed: ${reason}. Inspect /mind optimize history ${review.packet.target}.`
						: applyAttempted ? `Review apply was refused or failed: ${reason}. A persistence error may have an uncertain outcome; inspect /mind optimize history ${review.packet.target} before retrying.` : reason);
				}
			} finally { try { lease?.release(); } finally { applying = false; } }
		});
		return applyWork;
	}
	// Revocation prevents admission/guarded writes, but cannot roll back a committed store.
	// Join includes confirmation, persistence and receipt finalization, even after interrupt().
	return { start, show, apply, interrupt, join: async () => { await Promise.all([work, applyWork]); }, hasPending: () => snapshot() !== undefined,
		discard(ctx: ExtensionContext): void { interrupt(); notify(ctx, "Knowledge review cancelled/discarded; no pending plan remains. Already applied changes require history/undo."); },
	};
}
