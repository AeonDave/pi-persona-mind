/** Explicit human actions after F10 closes. Browsing itself stays read-only. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InspectorRequest } from "./inspector-data.ts";
import type { ReviewTarget } from "../core/knowledge-review.ts";
import type { createKnowledgeReview } from "./knowledge-review.ts";

export type InspectorActionRequest = InspectorRequest & { selectedId?: string };
export interface MindActionDeps {
	consolidate(target: ReviewTarget): boolean;
	review: ReturnType<typeof createKnowledgeReview>;
}

export async function runMindInspectorActions(ctx: ExtensionContext, request: InspectorActionRequest, current: () => boolean, deps: MindActionDeps): Promise<void> {
	if (!current() || ctx.mode !== "tui" || request.tab !== "memories") return;
	const target = request.scope === "project" || request.scope === "project-long" || request.scope === "persona" ? request.scope : undefined;
	const consolidate = "Consolidate this scope (bounded window)";
	const selected = "Review selected fact against evidence";
	const window = "Review this scope against evidence (bounded window)";
	const show = "Show pending knowledge review";
	const apply = "Approve staged knowledge corrections";
	const discard = "Discard/cancel knowledge review";
	const choices = [...(target ? [consolidate, ...(request.selectedId ? [selected] : []), window] : []), show, apply, discard];
	const choice = await ctx.ui.select(`Mind actions · ${request.scope}${target ? "" : " (choose a project/persona scope to review facts)"}`, choices);
	if (!choice || !current()) return;
	if (choice === show) { await deps.review.show(ctx); return; }
	if (choice === apply) { await deps.review.apply(ctx); return; }
	if (choice === discard) { deps.review.discard(ctx); return; }
	if (!target) return;
	if (choice === consolidate) {
		const accepted = await ctx.ui.confirm("Consolidate memory?", `Review one bounded window of ${target} on the current session model. Compatible facts may be merged and applied through the existing validated optimizer; history and guarded undo are retained. This is not a truth audit or a full-store rewrite. Continue?`);
		if (!accepted || !current()) return;
		const started = deps.consolidate(target);
		ctx.ui.notify(started ? `mind · ${target} consolidation requested; bounded inspection and worker admission are preparing.` : "Mind maintenance or the foreground is busy; no consolidation was accepted.", started ? "info" : "warning");
		return;
	}
	if (choice === selected) await deps.review.start(ctx, target, request.selectedId);
	else if (choice === window) await deps.review.start(ctx, target);
}
