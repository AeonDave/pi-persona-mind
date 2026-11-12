/**
 * Human-facing transcript chrome. These helpers never change the model-visible tool payload;
 * they only bound what a collapsed Pi card paints.
 */

import { sliceByColumn, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";

export const MAX_COLLAPSED_CARD_LINES = 3;
export const MAX_COLLAPSED_CARD_CHARS = 100;
const C0_AND_DEL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

export interface CompactVisibleTextOptions {
	maxLines?: number;
	/** Bound is terminal display columns, matching pi-persona's card chrome. */
	maxLineChars?: number;
}

export interface CompactVisibleTextResult {
	text: string;
	truncated: boolean;
	omittedLines: number;
}

export interface CardTheme {
	fg: (name: "accent" | "toolOutput" | "dim", text: string) => string;
	bold: (text: string) => string;
}

export function sanitizeCardText(text: string): string {
	return stripTerminalSequences(text.replace(/\r\n?/g, "\n")).replace(C0_AND_DEL, "");
}

/** Bound a collapsed card: a few semantic lines, each clipped by column, then a drill-down marker. */
export function compactVisibleText(input: string, opts: CompactVisibleTextOptions = {}): CompactVisibleTextResult {
	const maxLines = Math.max(1, Math.floor(opts.maxLines ?? MAX_COLLAPSED_CARD_LINES));
	const requestedColumns = opts.maxLineChars ?? MAX_COLLAPSED_CARD_CHARS;
	const maxLineColumns = Number.isFinite(requestedColumns) ? Math.max(1, Math.floor(requestedColumns)) : MAX_COLLAPSED_CARD_CHARS;
	const source = sanitizeCardText(input)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	let lineTruncated = false;
	const clamp = (line: string): string => {
		if (visibleWidth(line) <= maxLineColumns) return line;
		lineTruncated = true;
		return `${sliceByColumn(line, 0, maxLineColumns - visibleWidth("…"), true)}…`;
	};

	if (source.length > maxLines) {
		const contentLines = Math.max(0, maxLines - 1);
		const omittedLines = source.length - contentLines;
		const visible = source.slice(0, contentLines).map(clamp);
		visible.push(clamp(`… +${omittedLines} more line${omittedLines === 1 ? "" : "s"}`));
		return { text: visible.join("\n") || "(no output)", truncated: true, omittedLines };
	}

	const visible = source.map(clamp);
	return {
		text: visible.join("\n") || "(no output)",
		truncated: lineTruncated,
		omittedLines: 0,
	};
}

/** Optional expansion hint supplied by Pi's active renderer context. */
export type DetailHint = () => string;

function formatExpandableBody(body: string, expanded: boolean, theme: CardTheme, detailHint?: DetailHint, summary?: string): string {
	const full = sanitizeCardText(body).trim() || "(no output)";
	if (expanded) return theme.fg("toolOutput", full);
	const compact = summary === undefined ? full : sanitizeCardText(summary).trim();
	const preview = compactVisibleText(compact);
	const hidden = preview.truncated || compact !== full;
	const hint = hidden && detailHint ? `\n${theme.fg("dim", sanitizeCardText(detailHint()))}` : "";
	return `${theme.fg("toolOutput", preview.text)}${hint}`;
}

/** Result body only: Pi owns the title/shell. An optional compact summary never replaces expanded evidence. */
export function renderExpandableResult(body: string, expanded: boolean, theme: CardTheme, detailHint?: DetailHint, summary?: string): Text {
	return new Text(formatExpandableBody(body, expanded, theme, detailHint, summary), 0, 0);
}

export function toolResultText(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	const first = result.content?.find((part) => part.type === "text");
	return first?.text ?? "";
}
