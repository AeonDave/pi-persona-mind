/** Read-only inspector lifecycle. No persistence, model requests, or replacement retrieval policy. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "../core/context-budget.ts";
import type { InspectorPage, InspectorRequest, InspectorTab } from "./inspector-data.ts";
import type { InspectorActionRequest } from "./mind-actions.ts";

export interface InspectorScreenOptions {
	load(request: InspectorRequest): Promise<InspectorPage>;
	isCurrent(): boolean;
	initialTab: InspectorTab;
	signal: AbortSignal;
	onAction?(request: InspectorActionRequest): Promise<void>;
}
export interface MemoryInspectorDeps {
	unavailableReason(ctx: ExtensionContext): string | undefined;
	captureOwner(ctx: ExtensionContext): () => boolean;
	load(ctx: ExtensionContext, request: InspectorRequest): Promise<InspectorPage>;
	show(ctx: ExtensionContext, options: InspectorScreenOptions): Promise<void>;
	actions?(ctx: ExtensionContext, request: InspectorActionRequest, isCurrent: () => boolean): Promise<void>;
}

export function createMemoryInspector(deps: MemoryInspectorDeps) {
	let generation = 0;
	let opening: AbortController | undefined;
	let prepared: { text: string; at: string; current: () => boolean } | undefined;
	const invalidate = (): void => {
		generation++;
		prepared = undefined;
		const old = opening;
		opening = undefined;
		old?.abort();
	};
	const captureContext = (ctx: ExtensionContext): (() => boolean) => {
		const acceptedGeneration = generation;
		const owner = deps.captureOwner(ctx);
		return () => acceptedGeneration === generation && owner();
	};
	return {
		invalidate, captureContext,
		recordContext(ctx: ExtensionContext, text: string, current = captureContext(ctx)): void {
			if (current()) prepared = { text, at: new Date().toISOString(), current };
		},
		async open(ctx: ExtensionContext, initialTab: InspectorTab = "memories"): Promise<void> {
			const unavailable = deps.unavailableReason(ctx);
			if (unavailable) { ctx.ui.notify(unavailable, "warning"); return; }
			if (ctx.mode !== "tui") { ctx.ui.notify("Memory inspector requires the interactive terminal (TUI). Use /mind, /mind session or memory recall/read here.", "info"); return; }
			if (opening) return;
			const owner = deps.captureOwner(ctx);
			if (!owner()) { ctx.ui.notify("Memory session owner is unavailable.", "warning"); return; }
			const acceptedGeneration = generation;
			const controller = new AbortController();
			opening = controller;
			const current = (): boolean => !controller.signal.aborted && acceptedGeneration === generation && owner();
			const requireCurrent = (): void => { if (!current()) throw new Error("Memory inspector session owner changed; reopen it."); };
			try {
				await deps.show(ctx, {
					initialTab, signal: controller.signal, isCurrent: current,
					...(deps.actions ? { onAction: async (request: InspectorActionRequest) => { requireCurrent(); await deps.actions!(ctx, request, current); } } : {}),
					async load(request) {
						requireCurrent();
						if (request.tab === "context") {
							if (!prepared?.current()) return { items: [], total: 0, offset: 0, notice: "No Mind context prepared in this active session/branch yet. Start a turn; reopening does not recompute or persist context." };
							const { text, at } = prepared;
							return {
								items: [{ id: "prepared-context", title: `Last prepared · ${at} · ~${estimateTokens(text)} tokens (estimate)`, body: text || "Mind prepared no additional context for this turn." }],
								total: 1, offset: 0,
								notice: "Exact last block prepared by Mind, not the final provider payload. Later extensions may change it. UTF-8 bytes/3 is a planning estimate, not billing. Omission notices are part of the block; selection uses the existing lexical/tag/path ranker and bounded priority, never a second inspector policy.",
							};
						}
						const page = await deps.load(ctx, request);
						requireCurrent();
						return page;
					},
				});
			} catch (error) {
				if (current()) ctx.ui.notify(`Memory inspector unavailable: ${error instanceof Error ? error.message : "read failed"}`, "warning");
			} finally {
				if (opening === controller) opening = undefined;
			}
		},
	};
}
