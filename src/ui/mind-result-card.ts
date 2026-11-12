import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cardFrameDetailHint, cardFramePresentation, type MindCardUI } from "./card-frame.ts";

export const MIND_RESULT_ENTRY_TYPE = "pi-persona-mind-result";
const MAX_TITLE_CHARS = 160;
const MAX_BODY_CHARS = 1_000_000;
const AUTOMATIC_NO_OP_PREFIX = "Bounded coverage: one selected record window; bounded review found no safe consolidation in this record set.\nWorker ";

function cardTitle(title: string): string {
	const automatic = /^Mind automatic (?:optimization|result|proposal)( — .+)?$/.exec(title);
	return automatic ? `Mind · automatic review${automatic[1] ?? ""}` : title;
}

/** Register once per factory; command output stays display-only and can be expanded without loss. */
export function registerMindResultRenderer(pi: Pick<ExtensionAPI, "registerEntryRenderer">, cardUI: MindCardUI): void {
	pi.registerEntryRenderer<{ title: string; content: string }>(MIND_RESULT_ENTRY_TYPE, (entry, { expanded, keyHint }, theme) => {
		const data = entry.data;
		if (!data || typeof data.title !== "string" || data.title.length < 1 || data.title.length > MAX_TITLE_CHARS || typeof data.content !== "string" || data.content.length > MAX_BODY_CHARS) return undefined;
		// This exact report prefix is parent-authored after a valid empty operations array; never infer
		// status from worker prose. The persisted/expanded report remains untouched.
		const noOp = /^Mind (?:automatic optimization|optimization result)(?: — .+)?$/.test(data.title) && data.content.startsWith(AUTOMATIC_NO_OP_PREFIX);
		const compactSummary = noOp ? "One selected window reviewed; no consolidation proposed" : undefined;
		return cardUI.renderCard(cardFramePresentation(cardTitle(data.title), data.content, compactSummary), {
			expanded,
			theme,
			outputPad: cardUI.outputPad(),
			detailHint: cardFrameDetailHint(keyHint),
		});
	});
}
