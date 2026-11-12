import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, type EntryRenderer as PiEntryRenderer, type EntryRenderOptions, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import { CARD_FRAME_EVENT, createMindCardUI, type CardFrameFactory, type CardFramePresentation, type CardFrameProviderResponse } from "../src/ui/card-frame.ts";
import { MIND_RESULT_ENTRY_TYPE, registerMindResultRenderer } from "../src/ui/mind-result-card.ts";
import { SESSION_NOTE_ENTRY_TYPE } from "../src/core/session-memory.ts";
import { registerSessionNoteRenderer } from "../src/ui/session-note-card.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
};

type EntryRenderer = PiEntryRenderer<unknown>;
type TestPi = Pick<ExtensionAPI, "events" | "getSettings" | "registerEntryRenderer">;

function bind(events = createEventBus(), settings: { outputPad?: number } = {}) {
	const renderers = new Map<string, EntryRenderer>();
	const pi = {
		events,
		getSettings: () => settings,
		registerEntryRenderer: (type: string, renderer: EntryRenderer) => { renderers.set(type, renderer); },
	} as unknown as TestPi;
	return { pi, ui: createMindCardUI(pi), events, settings, renderers };
}

function rendererFor(renderers: Map<string, EntryRenderer>, type: string): EntryRenderer {
	const renderer = renderers.get(type);
	assert.ok(renderer, `renderer registered for ${type}`);
	return renderer;
}

function addProvider(events: ReturnType<typeof createEventBus>, factory: CardFrameFactory): () => void {
	return events.on(CARD_FRAME_EVENT, (request: unknown) => {
		if (request && typeof request === "object" && "respond" in request && typeof request.respond === "function") {
			(request.respond as (value: CardFrameProviderResponse) => void)({ version: 1, provider: "pi-persona", createCard: factory });
		}
	});
}

function plainFrame(presentation: CardFramePresentation, context: Parameters<CardFrameFactory>[1]): Component {
	return new Text(`${context.outputPad}:${context.detailHint()}\n${presentation.title}\n${presentation.preview(24).text}${context.expanded ? `\n${presentation.full}` : ""}`, 0, 0);
}

function resultEntry(title = "Mind automatic review", content = "full history marker") {
	return { data: { title, content } };
}

const keyHint = (id: string, description: string) => `${id} ${description} (F6)`;
function options(expanded: boolean): Pick<EntryRenderOptions, "expanded" | "keyHint" | "keyText"> {
	return { expanded, keyHint, keyText: () => "F6" };
}
function render(renderer: EntryRenderer, entry: unknown, expanded = false): Component | undefined {
	return renderer(entry as never, options(expanded), theme as never);
}

test("entry adapters query lazily on every render and observe provider load, unload, and reload", () => {
	const bound = bind();
	registerMindResultRenderer(bound.pi as never, bound.ui);
	const renderer = rendererFor(bound.renderers, MIND_RESULT_ENTRY_TYPE);
	const before = render(renderer, resultEntry())?.render(100).join("\n") ?? "";
	assert.match(before, /Mind automatic review/);
	assert.match(before, /full history marker/);

	const seen: string[] = [];
	const first = addProvider(bound.events, (presentation, context) => { seen.push("first"); return plainFrame(presentation, context); });
	const loaded = render(renderer, resultEntry())?.render(100).join("\n") ?? "";
	assert.match(loaded, /app\.tools\.expand to expand \(F6\)/);
	assert.deepEqual(seen, ["first"]);
	first();
	const unloaded = render(renderer, resultEntry())?.render(100).join("\n") ?? "";
	assert.match(unloaded, /full history marker/);
	addProvider(bound.events, (presentation, context) => { seen.push("reloaded"); return plainFrame(presentation, context); });
	render(renderer, resultEntry());
	assert.deepEqual(seen, ["first", "reloaded"]);
});

test("a provider loaded before Mind is discovered by the later renderer invocation", () => {
	const events = createEventBus();
	const seen: string[] = [];
	addProvider(events, (presentation, context) => { seen.push("loaded-first"); return plainFrame(presentation, context); });
	const bound = bind(events);
	registerMindResultRenderer(bound.pi as never, bound.ui);
	const output = render(rendererFor(bound.renderers, MIND_RESULT_ENTRY_TYPE), resultEntry())?.render(100).join("\n") ?? "";
	assert.match(output, /Mind automatic review/);
	assert.deepEqual(seen, ["loaded-first"]);
});

test("incompatible, ambiguous, throwing responders and throwing factories use sanitized full plaintext", () => {
	const bound = bind();
	registerMindResultRenderer(bound.pi as never, bound.ui);
	const renderer = rendererFor(bound.renderers, MIND_RESULT_ENTRY_TYPE);
	const dangerous = "\u001b]0;fake-title\u0007visible\u001b[31m full-history";
	const run = () => render(renderer, resultEntry("Mind \u001b[2Jreview", dangerous))?.render(200).map((line) => line.trimEnd()).join("\n") ?? "";

	for (const response of [
		{ version: 2, provider: "pi-persona", createCard: plainFrame },
		{ version: 1, provider: "other", createCard: plainFrame },
		{ version: 1, provider: "pi-persona", createCard: "not-a-function" },
	]) {
		const dispose = bound.events.on(CARD_FRAME_EVENT, (request: unknown) => {
			if (request && typeof request === "object" && "respond" in request && typeof request.respond === "function") {
				(request.respond as (value: unknown) => void)(response);
			}
		});
		const output = run();
		assert.equal(output, "Mind review\nvisible full-history");
		dispose();
	}

	const good = addProvider(bound.events, plainFrame);
	const duplicate = addProvider(bound.events, plainFrame);
	const ambiguous = run();
	assert.equal(ambiguous, "Mind review\nvisible full-history");
	good(); duplicate();

	const throwingProvider = bound.events.on(CARD_FRAME_EVENT, () => { throw new Error("provider failed"); });
	assert.equal(run(), "Mind review\nvisible full-history");
	throwingProvider();

	addProvider(bound.events, () => { throw new Error("factory failed"); });
	assert.equal(run(), "Mind review\nvisible full-history");

	addProvider(bound.events, () => undefined as never);
	assert.equal(run(), "Mind review\nvisible full-history", "a non-component factory result is rejected");
});

test("factory results missing the native invalidation method are rejected without hiding retained text", () => {
	const bound = bind();
	let calls = 0;
	addProvider(bound.events, () => {
		calls++;
		return { render: () => ["invalid component output"] } as never;
	});
	registerMindResultRenderer(bound.pi as never, bound.ui);
	const component = render(rendererFor(bound.renderers, MIND_RESULT_ENTRY_TYPE), resultEntry());
	assert.equal(calls, 1, "one factory ran; fallback was not caused by ambiguous providers");
	assert.ok(component);
	assert.doesNotThrow(() => component.invalidate());
	assert.match(component.render(100).join("\n"), /full history marker/);
});

test("provider response is synchronous-only; entry data remains unchanged and fallback retains full expansion", () => {
	const bound = bind();
	registerMindResultRenderer(bound.pi as never, bound.ui);
	const renderer = rendererFor(bound.renderers, MIND_RESULT_ENTRY_TYPE);
	const payload = resultEntry("bounded", "Original bounded coverage, model, effort, terminal reference");
	let lateResponder: ((response: CardFrameProviderResponse) => void) | undefined;
	const asyncOff = bound.events.on(CARD_FRAME_EVENT, (request: unknown) => {
		if (request && typeof request === "object" && "respond" in request) lateResponder = request.respond as (response: CardFrameProviderResponse) => void;
	});
	const output = render(renderer, payload, true)?.render(200).join("\n") ?? "";
	lateResponder?.({ version: 1, provider: "pi-persona", createCard: plainFrame });
	asyncOff();
	assert.match(output, /Original bounded coverage, model, effort, terminal reference/);
	assert.deepEqual(payload.data, { title: "bounded", content: "Original bounded coverage, model, effort, terminal reference" });
});

test("each extension instance binds its own event bus and entry settings are read live with default padding 1", () => {
	const left = bind(createEventBus(), { outputPad: 0 });
	const right = bind(createEventBus(), { outputPad: 1 });
	const leftContexts: number[] = [];
	const rightContexts: number[] = [];
	addProvider(left.events, (presentation, context) => { leftContexts.push(context.outputPad); return plainFrame(presentation, context); });
	addProvider(right.events, (presentation, context) => { rightContexts.push(context.outputPad); return plainFrame(presentation, context); });
	registerMindResultRenderer(left.pi as never, left.ui);
	registerSessionNoteRenderer(right.pi as never, right.ui);
	const leftRenderer = rendererFor(left.renderers, MIND_RESULT_ENTRY_TYPE);
	const rightRenderer = rendererFor(right.renderers, SESSION_NOTE_ENTRY_TYPE);
	render(leftRenderer, resultEntry());
	render(rightRenderer, { data: { version: 1, op: "forget", id: "session:123" } });
	assert.deepEqual(leftContexts, [0]);
	assert.deepEqual(rightContexts, [1]);

	left.settings.outputPad = 1;
	render(leftRenderer, resultEntry());
	left.settings.outputPad = 0;
	render(leftRenderer, resultEntry());
	assert.deepEqual(leftContexts, [0, 1, 0]);

	const defaults = bind(createEventBus(), {});
	const defaultPads: number[] = [];
	addProvider(defaults.events, (presentation, context) => { defaultPads.push(context.outputPad); return plainFrame(presentation, context); });
	registerMindResultRenderer(defaults.pi as never, defaults.ui);
	render(rendererFor(defaults.renderers, MIND_RESULT_ENTRY_TYPE), resultEntry());
	assert.deepEqual(defaultPads, [1]);
});

test("shared renderer receives sanitized compact Unicode preview, original expansion, theme, and injected hint", () => {
	const bound = bind(createEventBus(), { outputPad: 1 });
	let captured: CardFramePresentation | undefined;
	let seenTheme: unknown;
	let seenHint = "";
	const release = addProvider(bound.events, (presentation, context) => {
		captured = presentation;
		seenTheme = context.theme;
		seenHint = context.detailHint();
		return new Text(context.expanded ? presentation.full : presentation.preview(18).text, 0, 0);
	});
	registerMindResultRenderer(bound.pi as never, bound.ui);
	const renderer = rendererFor(bound.renderers, MIND_RESULT_ENTRY_TYPE);
	const content = "\u001b]8;;https://invalid\u0007visible facts\n" + "界面 facts remain bounded. ".repeat(8) + "tail-history-marker";
	const data = { title: "Unicode review", content };
	const collapsed = render(renderer, { data }, false)?.render(18).join("\n") ?? "";
	assert.doesNotMatch(collapsed, /tail-history-marker|\u001b/);
	assert.match(collapsed, /visible facts/);
	assert.ok(captured);
	assert.equal(captured.full, content, "history payload is passed through without rewriting");
	assert.equal(captured.preview(18).truncated, true);
	assert.doesNotMatch(captured.preview(18).text, /https:|\u001b/);
	assert.equal(seenTheme, theme);
	assert.equal(seenHint, "app.tools.expand to expand (F6)");
	const expanded = render(renderer, { data }, true)?.render(2000).join("\n") ?? "";
	assert.match(expanded, /tail-history-marker/);
	assert.deepEqual(data, { title: "Unicode review", content });
	release();
});

test("session-note renderer only registers presentation and preserves the original entry data", () => {
	const bound = bind();
	let registrations = 0;
	const pi = {
		events: bound.events,
		getSettings: bound.pi.getSettings,
		registerEntryRenderer(type: string, renderer: EntryRenderer) {
			registrations++;
			bound.renderers.set(type, renderer);
		},
	} as unknown as TestPi;
	registerSessionNoteRenderer(pi as never, createMindCardUI(pi));
	const source = { version: 1, op: "forget", id: "session:opaque" };
	const output = render(rendererFor(bound.renderers, SESSION_NOTE_ENTRY_TYPE), { data: source }, true)?.render(100).join("\n") ?? "";
	assert.match(output, /Session note retired/);
	assert.deepEqual(source, { version: 1, op: "forget", id: "session:opaque" });
	assert.equal(registrations, 1);
});
