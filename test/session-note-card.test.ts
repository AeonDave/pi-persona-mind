import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import { CARD_FRAME_EVENT, createMindCardUI, type CardFrameContext, type CardFrameFactory } from "../src/ui/card-frame.ts";
import { SESSION_NOTE_ENTRY_TYPE } from "../src/core/session-memory.ts";
import { registerSessionNoteRenderer } from "../src/ui/session-note-card.ts";

type CardTheme = { fg: (_name: string, text: string) => string; bold: (text: string) => string };
type Renderer = (entry: { data?: unknown }, options: { expanded: boolean; keyHint: (id: string, description: string) => string }, theme: CardTheme) => Component | undefined;
const theme: CardTheme = { fg: (_name, text) => text, bold: (text) => text };
const keyHint = (id: string, description: string) => `${id} ${description}`;

function rendererForEntry() {
	const events = createEventBus();
	events.on(CARD_FRAME_EVENT, (request: unknown) => {
		if (!request || typeof request !== "object" || !("respond" in request) || typeof request.respond !== "function") return;
		request.respond({
			version: 1,
			provider: "pi-persona",
			createCard: (presentation: { title: string; full: string; preview: (width: number) => { text: string; truncated: boolean } }, context: CardFrameContext) => {
				const preview = presentation.preview(80);
				return new Text(`${presentation.title}\n${context.expanded ? presentation.full : `${preview.text}${preview.truncated ? `\n${context.detailHint()}` : ""}`}`, 0, 0);
			},
		});
	});
	let renderer: Renderer | undefined;
	const pi = {
		events,
		getSettings: () => ({ outputPad: 1 }),
		registerEntryRenderer(type: string, callback: Renderer) {
			assert.equal(type, SESSION_NOTE_ENTRY_TYPE);
			renderer = callback;
		},
	} as unknown as Pick<ExtensionAPI, "events" | "getSettings" | "registerEntryRenderer">;
	registerSessionNoteRenderer(pi, createMindCardUI(pi));
	assert.ok(renderer);
	return renderer;
}

test("session note card has a semantic title and expands to the full note with provenance", () => {
	const renderer = rendererForEntry();
	const text = `A durable session observation ${"detail ".repeat(30)}tail-marker`;
	const entry = { data: { version: 1, op: "save", note: { id: "session:00000000-0000-4000-8000-000000000001", kind: "preference", text, source: "result:opaque-ref", recordedAt: "2026-10-25T00:00:00.000Z", originSessionId: "session-42" } } };
	const collapsed = renderer(entry, { expanded: false, keyHint }, theme)?.render(200).join("\n") ?? "";
	const expanded = renderer(entry, { expanded: true, keyHint }, theme)?.render(200).join("\n") ?? "";
	assert.match(collapsed, /session note · preference/);
	assert.doesNotMatch(collapsed, /tail-marker/);
	assert.match(collapsed, /expand/i);
	assert.match(expanded, /tail-marker/);
	assert.match(expanded, /result:opaque-ref/);
	assert.match(expanded, /origin session: session-42.*not auto-resolved/);
});

test("session-note renderer passes the original entry as the shared expansion key", () => {
	const events = createEventBus();
	let key: object | undefined;
	events.on(CARD_FRAME_EVENT, (request: unknown) => {
		if (!request || typeof request !== "object" || !("respond" in request) || typeof request.respond !== "function") return;
		request.respond({ version: 1, provider: "pi-persona", createCard: ((_presentation, context) => {
			key = context.expansionKey;
			return new Text("ok", 0, 0);
		}) satisfies CardFrameFactory });
	});
	let renderer: Renderer | undefined;
	const pi = {
		events,
		getSettings: () => ({ outputPad: 1 }),
		registerEntryRenderer(_type: string, callback: Renderer) { renderer = callback; },
	} as unknown as Pick<ExtensionAPI, "events" | "getSettings" | "registerEntryRenderer">;
	registerSessionNoteRenderer(pi, createMindCardUI(pi));
	assert.ok(renderer);
	const entry = { type: SESSION_NOTE_ENTRY_TYPE, data: { version: 1, op: "forget", id: "session:identity" } };
	renderer(entry, { expanded: false, keyHint }, theme);
	assert.equal(key, entry);
});

test("session note tombstones render as retired entries and malformed data stays harmless", () => {
	const renderer = rendererForEntry();
	const retired = renderer({ data: { version: 1, op: "forget", id: "session:00000000-0000-4000-8000-000000000001" } }, { expanded: false, keyHint }, theme)?.render(200).join("\n") ?? "";
	assert.match(retired, /session note retired/);
	assert.match(retired, /session:00000000-0000-4000-8000-000000000001/);
	assert.equal(renderer({ data: { version: 1, op: "save", note: { text: "bad" } } }, { expanded: false, keyHint }, theme), undefined);
});
