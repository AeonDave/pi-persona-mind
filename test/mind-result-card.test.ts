import assert from "node:assert/strict";
import { test } from "node:test";

import { MIND_RESULT_ENTRY_TYPE, registerMindResultRenderer } from "../src/ui/mind-result-card.ts";
import { formatAutoInputSkip } from "../src/extension/auto-optimize.ts";
import type { OptimizeInspection } from "../src/core/optimize.ts";

type CardTheme = { fg: (_name: string, text: string) => string; bold: (text: string) => string };
type Renderer = (entry: { data?: unknown }, options: { expanded: boolean }, theme: CardTheme) => { render(width: number): string[] } | undefined;
const theme: CardTheme = { fg: (_name, text) => text, bold: (text) => text };

test("collapsed optimization skip card keeps target, reason, and no-write outcome visible", () => {
	let render: Renderer | undefined;
	registerMindResultRenderer({ registerEntryRenderer: (_name: string, callback: Renderer) => { render = callback; } } as never);
	assert.ok(render);
	const inspection: OptimizeInspection = { ok: true, target: "project", fingerprint: "f".repeat(64), entries: [], total: 4, withheld: 4, candidates: [], offset: 0, matched: 0 };
	const content = formatAutoInputSkip("project", inspection, { eligibleCount: 0, nextRotation: 0, pageComplete: true, reason: "empty-page" });
	const collapsed = render({ data: { title: "Mind optimization result — project", content } }, { expanded: false }, theme)?.render(200).join("\n") ?? "";
	assert.match(collapsed, /Target: project — skipped: empty\/exhausted page; no worker started, no memory changed\./);
	assert.match(collapsed, /Selected page offset 0/);
});

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
