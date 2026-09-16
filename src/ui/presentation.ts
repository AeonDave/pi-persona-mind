/**
 * Human-facing transcript chrome. These helpers never change the model-visible tool payload;
 * they only bound what a collapsed Pi card paints.
 */

import { keyHint } from "@earendil-works/pi-coding-agent";
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

function sanitizeCardText(text: string): string {
	return stripTerminalSequences(text.replace(/\r\n?/g, "\n")).replace(C0_AND_DEL, "");
}

/** Bound a collapsed card: a few semantic lines, each clipped by column, then a drill-down marker. */
export function compactVisibleText(input: string, opts: CompactVisibleTextOptions = {}): CompactVisibleTextResult {
	const maxLines = Math.max(1, Math.floor(opts.maxLines ?? MAX_COLLAPSED_CARD_LINES));
	const maxLineColumns = Math.max(16, Math.floor(opts.maxLineChars ?? MAX_COLLAPSED_CARD_CHARS));
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

/** Pi's configured expand binding; fall back to the default so a missing keymap still names a key. */
export function expandDetailHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "ctrl+o to expand";
	}
}

function formatExpandableBody(body: string, expanded: boolean, theme: CardTheme): string {
	const full = sanitizeCardText(body).trim() || "(no output)";
	if (expanded) return theme.fg("toolOutput", full);
	const preview = compactVisibleText(full);
	const hint = preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : "";
	return `${theme.fg("toolOutput", preview.text)}${hint}`;
}

/** Result body only: Pi renders the call title. Expansion is lossless against sanitized `body`. */
export function renderExpandableResult(body: string, expanded: boolean, theme: CardTheme): Text {
	return new Text(formatExpandableBody(body, expanded, theme), 0, 0);
}

/** Standalone entries such as backlog wakes have no Pi tool title and still need their own. */
export function renderExpandableCard(label: string, body: string, expanded: boolean, theme: CardTheme): Text {
	const title = theme.fg("accent", theme.bold(label));
	return new Text(`${title}\n${formatExpandableBody(body, expanded, theme)}`, 0, 0);
}

export function toolResultText(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	const first = result.content?.find((part) => part.type === "text");
	return first?.text ?? "";
}
