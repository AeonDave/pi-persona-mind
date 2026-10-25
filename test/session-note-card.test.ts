import assert from "node:assert/strict";
import { test } from "node:test";

import { SESSION_NOTE_ENTRY_TYPE } from "../src/core/session-memory.ts";
import { registerSessionNoteRenderer } from "../src/ui/session-note-card.ts";

type CardTheme = { fg: (_name: string, text: string) => string; bold: (text: string) => string };
const theme: CardTheme = { fg: (_name, text) => text, bold: (text) => text };

function rendererForEntry() {
	let renderer: ((entry: { data?: unknown }, options: { expanded: boolean }, theme: CardTheme) => { render(width: number): string[] } | undefined) | undefined;
	const pi = {
		registerEntryRenderer(type: string, callback: typeof renderer) {
			assert.equal(type, SESSION_NOTE_ENTRY_TYPE);
			renderer = callback;
		},
	};
	registerSessionNoteRenderer(pi as never);
	assert.ok(renderer);
	return renderer;
}

test("session note card has a semantic title and expands to the full note with provenance", () => {
	const renderer = rendererForEntry();
	const text = `A durable session observation ${"detail ".repeat(30)}tail-marker`;
	const entry = { data: { version: 1, op: "save", note: { id: "session:00000000-0000-4000-8000-000000000001", kind: "preference", text, source: "result:opaque-ref", recordedAt: "2026-10-25T00:00:00.000Z", originSessionId: "session-42" } } };
	const collapsed = renderer(entry, { expanded: false }, theme)?.render(200).join("\n") ?? "";
	const expanded = renderer(entry, { expanded: true }, theme)?.render(200).join("\n") ?? "";
	assert.match(collapsed, /Session note · preference/);
	assert.doesNotMatch(collapsed, /tail-marker/);
	assert.match(collapsed, /expand/i);
	assert.match(expanded, /tail-marker/);
	assert.match(expanded, /result:opaque-ref/);
	assert.match(expanded, /origin session: session-42.*not auto-resolved/);
});

test("session note tombstones render as retired entries and malformed data stays harmless", () => {
	const renderer = rendererForEntry();
	const retired = renderer({ data: { version: 1, op: "forget", id: "session:00000000-0000-4000-8000-000000000001" } }, { expanded: false }, theme)?.render(200).join("\n") ?? "";
	assert.match(retired, /Session note retired/);
	assert.match(retired, /session:00000000-0000-4000-8000-000000000001/);
	assert.equal(renderer({ data: { version: 1, op: "save", note: { text: "bad" } } }, { expanded: false }, theme), undefined);
});
