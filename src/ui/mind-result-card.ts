import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderExpandableCard } from "./presentation.ts";

export const MIND_RESULT_ENTRY_TYPE = "pi-persona-mind-result";
const MAX_TITLE_CHARS = 160;
const MAX_BODY_CHARS = 1_000_000;

/** Register once per factory; command output stays display-only and can be expanded without loss. */
export function registerMindResultRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<{ title: string; content: string }>(MIND_RESULT_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data || typeof data.title !== "string" || data.title.length < 1 || data.title.length > MAX_TITLE_CHARS || typeof data.content !== "string" || data.content.length > MAX_BODY_CHARS) return undefined;
		return renderExpandableCard(data.title, data.content, expanded, theme);
	});
}
