import assert from "node:assert/strict";
import { test } from "node:test";

import { MIND_RESULT_ENTRY_TYPE, registerMindResultRenderer } from "../src/ui/mind-result-card.ts";

type CardTheme = { fg: (_name: string, text: string) => string; bold: (text: string) => string };
type Renderer = (entry: { data?: unknown }, options: { expanded: boolean }, theme: CardTheme) => { render(width: number): string[] } | undefined;
const theme: CardTheme = { fg: (_name, text) => text, bold: (text) => text };

test("mind result cards collapse command output and preserve full expansion", () => {
	let render: Renderer | undefined;
	registerMindResultRenderer({ registerEntryRenderer: (name: string, callback: Renderer) => { assert.equal(name, MIND_RESULT_ENTRY_TYPE); render = callback; } } as never);
	assert.ok(render);
	const content = `${"store summary\n".repeat(8)}full-marker`;
	const entry = { data: { title: "Memory doctor", content } };
	const collapsed = render(entry, { expanded: false }, theme)?.render(200).join("\n") ?? "";
	const expanded = render(entry, { expanded: true }, theme)?.render(200).join("\n") ?? "";
	assert.match(collapsed, /Memory doctor/);
	assert.doesNotMatch(collapsed, /full-marker/);
	assert.match(expanded, /full-marker/);
	assert.equal(render({ data: { title: "x".repeat(161), content } }, { expanded: true }, theme), undefined);
});
