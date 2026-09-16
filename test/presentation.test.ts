import assert from "node:assert/strict";
import { test } from "node:test";

import { compactVisibleText, renderExpandableCard, renderExpandableResult, toolResultText } from "../src/ui/presentation.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

test("compactVisibleText bounds lines and width for a collapsed card", () => {
	const lines = Array.from({ length: 10 }, (_, i) => `line-${i} ${"x".repeat(200)}`);
	const preview = compactVisibleText(lines.join("\n"), { maxLines: 3, maxLineChars: 40 });
	assert.equal(preview.truncated, true);
	assert.ok(preview.omittedLines >= 1);
	const out = preview.text.split("\n");
	assert.equal(out.length, 3);
	assert.ok(out.every((line) => line.length <= 40));
	assert.match(preview.text, /\+8 more/);
});

test("compactVisibleText leaves a short result untruncated", () => {
	const preview = compactVisibleText("Remembered abc — long-term note.");
	assert.equal(preview.truncated, false);
	assert.equal(preview.omittedLines, 0);
	assert.equal(preview.text, "Remembered abc — long-term note.");
});

test("tool results omit the title while standalone cards retain it", () => {
	const body = ["10 recalled of 12:", ...Array.from({ length: 10 }, (_, i) => `- [${i}] (note) fact ${i}`)].join("\n");
	const collapsed = renderExpandableResult(body, false, theme).render(200).map((line) => line.trimEnd()).join("\n");
	const expanded = renderExpandableResult(body, true, theme).render(200).map((line) => line.trimEnd()).join("\n");
	assert.doesNotMatch(collapsed, /^memory(?:\n|$)/, "Pi already renders the tool title above this result");
	assert.doesNotMatch(expanded, /^memory(?:\n|$)/);
	assert.match(collapsed, /to expand|ctrl\+o/i);
	assert.ok(collapsed.split("\n").length < expanded.split("\n").length);
	assert.match(expanded, /fact 9/);
	assert.doesNotMatch(collapsed, /fact 9/);
	const wake = renderExpandableCard("backlog wake", "A saved reminder is due.", false, theme).render(200).map((line) => line.trimEnd()).join("\n");
	assert.equal(wake, "backlog wake\nA saved reminder is due.");
});

test("toolResultText reads the first text part", () => {
	assert.equal(toolResultText({ content: [{ type: "text", text: "hello" }] }), "hello");
	assert.equal(toolResultText({ content: [] }), "");
});

test("compactVisibleText strips OSC/ANSI so a stored payload cannot spoof chrome", () => {
	const preview = compactVisibleText(`\u001b]0;secret title\u0007visible fact`);
	assert.doesNotMatch(preview.text, /secret title/);
	assert.match(preview.text, /visible fact/);
});
