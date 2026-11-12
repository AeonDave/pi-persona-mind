import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cardFrameDetailHint, cardFramePresentation, type MindCardUI } from "./card-frame.ts";

export const MIND_RESULT_ENTRY_TYPE = "pi-persona-mind-result";
const MAX_TITLE_CHARS = 160;
const MAX_BODY_CHARS = 1_000_000;
const AUTOMATIC_NO_OP_PREFIX = "Bounded coverage: one selected record window; bounded review found no safe consolidation in this record set.\nWorker ";
interface AutomaticResultContext {
	automatic: true;
	target: "project" | "project-long" | "persona";
	phase: "result";
	summary: string;
	attention: boolean;
}

function automaticContext(value: unknown): AutomaticResultContext | undefined {
	if (!value || typeof value !== "object") return undefined;
	const context = value as Record<string, unknown>;
	if (context.automatic !== true || context.phase !== "result" || (context.target !== "project" && context.target !== "project-long" && context.target !== "persona") || typeof context.summary !== "string" || typeof context.attention !== "boolean") return undefined;
	return context as unknown as AutomaticResultContext;
}

function cardTitle(title: string): string {
	const automatic = /^Mind automatic (?:optimization|result|proposal)( — .+)?$/.exec(title);
	return automatic ? `Mind · automatic review${automatic[1] ?? ""}` : title;
}

/** Register once per factory; command output stays display-only and can be expanded without loss. */
export function registerMindResultRenderer(pi: Pick<ExtensionAPI, "registerEntryRenderer">, cardUI: MindCardUI): void {
	pi.registerEntryRenderer<{ title: string; content: string; reportContext?: unknown }>(MIND_RESULT_ENTRY_TYPE, (entry, { expanded, keyHint }, theme) => {
		const data = entry.data;
		if (!data || typeof data.title !== "string" || data.title.length < 1 || data.title.length > MAX_TITLE_CHARS || typeof data.content !== "string" || data.content.length > MAX_BODY_CHARS) return undefined;
		const report = automaticContext(data.reportContext);
		const legacyAutomatic = /^Mind automatic (?:optimization|result|proposal)(?: — .+)?$/.test(data.title);
		const manualNoOp = /^Mind optimization result(?: — .+)?$/.test(data.title) && data.content.startsWith(AUTOMATIC_NO_OP_PREFIX);
		const presentation = report || legacyAutomatic
			? { title: report ? `Mind · ${report.target} · ${report.summary}` : cardTitle(data.title), state: report?.attention ? "attention" as const : "neutral" as const, full: data.content, preview: () => ({ text: "", truncated: true }) }
			: cardFramePresentation(data.title, data.content, manualNoOp ? "One selected window reviewed; no consolidation proposed" : undefined);
		return cardUI.renderCard(presentation, {
			expanded,
			theme,
			outputPad: cardUI.outputPad(),
			detailHint: cardFrameDetailHint(keyHint),
		});
	});
}
