import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import { formatAutoInputSkip } from "../src/extension/auto-optimize.ts";
import type { OptimizeInspection } from "../src/core/optimize.ts";
import { CARD_FRAME_EVENT, createMindCardUI, type CardFrameFactory } from "../src/ui/card-frame.ts";
import { MIND_RESULT_ENTRY_TYPE, registerMindResultRenderer } from "../src/ui/mind-result-card.ts";

type CardTheme = { fg: (_name: string, text: string) => string; bold: (text: string) => string };
type Renderer = (entry: { data?: unknown }, options: { expanded: boolean; keyHint: (id: string, description: string) => string }, theme: CardTheme) => Component | undefined;
const theme: CardTheme = { fg: (_name, text) => text, bold: (text) => text };

function installRenderer(observe?: (state: string) => void) {
	const events = createEventBus();
	events.on(CARD_FRAME_EVENT, (request: unknown) => {
		if (!request || typeof request !== "object" || !("respond" in request) || typeof request.respond !== "function") return;
		request.respond({
			version: 1,
			provider: "pi-persona",
			createCard: ((presentation, context) => {
				observe?.(presentation.state);
				const preview = presentation.preview(96);
				const content = context.expanded ? presentation.full : `${preview.text}${preview.truncated ? `\n${context.detailHint()}` : ""}`;
				return new Text(`${presentation.title}\n${content}`, 0, 0);
			}) satisfies CardFrameFactory,
		});
	});
	const pi = {
		events,
		getSettings: () => ({ outputPad: 0 }),
		registerEntryRenderer(_name: string, callback: Renderer) { renderer = callback; },
	} as unknown as Pick<ExtensionAPI, "events" | "getSettings" | "registerEntryRenderer">;
	let renderer: Renderer | undefined;
	registerMindResultRenderer(pi, createMindCardUI(pi));
	assert.ok(renderer);
	return renderer;
}

const keyHint = (id: string, description: string) => `${id} ${description}`;

test("collapsed optimization skip card keeps target, reason, and no-write outcome visible", () => {
	const render = installRenderer();
	const inspection: OptimizeInspection = { ok: true, target: "project", fingerprint: "f".repeat(64), entries: [], total: 4, withheld: 4, candidates: [], offset: 0, matched: 0 };
	const content = formatAutoInputSkip("project", inspection, { eligibleCount: 0, nextRotation: 0, pageComplete: true, reason: "empty-page" });
	const collapsed = render({ data: { title: "Mind optimization result — project", content } }, { expanded: false, keyHint }, theme)?.render(200).join("\n") ?? "";
	assert.match(collapsed, /Target: project — skipped: empty\/exhausted page; no worker started, no memory changed\./);
	assert.match(collapsed, /Selected page offset 0/);
});

test("a parent-authored bounded no-op summary is compact while the complete worker report remains expandable", () => {
	const render = installRenderer();
	const content = "Bounded coverage: one selected record window; bounded review found no safe consolidation in this record set.\nWorker run:auto-1 · provider/model · high\nTerminal report: result:opaque-ref";
	const data = { title: "Mind automatic optimization — persona", content };
	const collapsed = render({ data }, { expanded: false, keyHint }, theme)?.render(200).join("\n") ?? "";
	const expanded = render({ data }, { expanded: true, keyHint }, theme)?.render(500).join("\n") ?? "";
	assert.match(collapsed, /Mind · automatic review — persona/);
	assert.doesNotMatch(collapsed, /One selected window reviewed; no consolidation proposed/);
	assert.match(collapsed, /to expand/);
	assert.doesNotMatch(collapsed, /Bounded coverage:|provider\/model|result:opaque-ref/);
	assert.match(expanded, /Bounded coverage: one selected record window/);
	assert.match(expanded, /Worker run:auto-1 · provider\/model · high/);
	assert.match(expanded, /Terminal report: result:opaque-ref/);
	assert.deepEqual(data, { title: "Mind automatic optimization — persona", content });
});

test("manual no-op retains its existing compact summary and full expansion", () => {
	const render = installRenderer();
	const content = "Bounded coverage: one selected record window; bounded review found no safe consolidation in this record set.\nWorker run · model";
	const entry = { data: { title: "Mind optimization result", content } };
	assert.match(render(entry, { expanded: false, keyHint }, theme)?.render(200).join("\n") ?? "", /One selected window reviewed; no consolidation proposed/);
	assert.match(render(entry, { expanded: true, keyHint }, theme)?.render(200).join("\n") ?? "", /Worker run · model/);
});

test("automatic result titles stay concise without rewriting saved title or result data", () => {
	const render = installRenderer();
	const data = { title: "Mind automatic optimization — persona", content: "bounded review summary and worker provenance" };
	const output = render({ data }, { expanded: false, keyHint }, theme)?.render(200).join("\n") ?? "";
	assert.match(output, /Mind · automatic review — persona/);
	assert.doesNotMatch(output, /Mind automatic optimization/);
	assert.deepEqual(data, { title: "Mind automatic optimization — persona", content: "bounded review summary and worker provenance" });
});

test("automatic result uses a title-only note with typed runtime state and complete expansion", () => {
	const render = installRenderer();
	const content = "Bounded coverage: one window\nWorker run · provider/model\nUndo: /mind optimize undo receipt persona";
	const data = { title: "Mind automatic result", content, reportContext: { automatic: true, target: "persona", phase: "result", summary: "1 replacement applied", attention: false } };
	const collapsed = render({ data }, { expanded: false, keyHint }, theme)?.render(200).join("\n") ?? "";
	const expanded = render({ data }, { expanded: true, keyHint }, theme)?.render(200).join("\n") ?? "";
	assert.match(collapsed, /Mind · persona · 1 replacement applied/);
	assert.doesNotMatch(collapsed, /Bounded coverage|Worker|Undo/);
	assert.match(expanded, /Worker run · provider\/model/);
	assert.match(expanded, /Undo: \/mind optimize undo receipt persona/);
});

test("legacy automatic proposal stays intact in expanded history and attention follows typed metadata", () => {
	const states: string[] = [];
	const render = installRenderer((state) => states.push(state));
	const content = "Worker run\nBefore: original fact\nAfter: replacement fact";
	const legacy = { title: "Mind automatic proposal", content };
	const collapsed = render({ data: legacy }, { expanded: false, keyHint }, theme)?.render(200).join("\n") ?? "";
	const expanded = render({ data: legacy }, { expanded: true, keyHint }, theme)?.render(200).join("\n") ?? "";
	assert.doesNotMatch(collapsed, /original fact|replacement fact/);
	assert.match(expanded, /Before: original fact/);
	assert.match(expanded, /After: replacement fact/);
	assert.deepEqual(legacy, { title: "Mind automatic proposal", content });
	render({ data: { title: "Mind automatic result", content, reportContext: { automatic: true, target: "persona", phase: "result", summary: "receipt warning", attention: true } } }, { expanded: false, keyHint }, theme);
	assert.equal(states.at(-1), "attention");
});

test("mind result cards collapse command output and preserve full expansion", () => {
	const render = installRenderer();
	const content = `${"store summary\n".repeat(8)}full-marker`;
	const entry = { data: { title: "Memory doctor", content } };
	const collapsed = render(entry, { expanded: false, keyHint }, theme)?.render(200).join("\n") ?? "";
	const expanded = render(entry, { expanded: true, keyHint }, theme)?.render(200).join("\n") ?? "";
	assert.match(collapsed, /Memory doctor/);
	assert.doesNotMatch(collapsed, /full-marker/);
	assert.match(expanded, /full-marker/);
	assert.equal(render({ data: { title: "x".repeat(161), content } }, { expanded: true, keyHint }, theme), undefined);
});
