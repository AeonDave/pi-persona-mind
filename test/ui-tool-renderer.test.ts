import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";

import { registerBacklogTool } from "../src/tools/backlog.ts";
import { registerMemoryTool } from "../src/tools/memory.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
type FakeTheme = typeof theme;
const customHint = (_id: string, _description: string) => "F9 expands";
const longBody = `A full tool result remains in the native tool shell. ${"Unicode 界面 details. ".repeat(12)}`;

function registerAndRenderTool(register: (pi: never) => void): string {
	let definition: { renderResult?: unknown } | undefined;
	const pi = { registerTool: (value: unknown) => { definition = value as typeof definition; } };
	register(pi as never);
	const renderResult = definition?.renderResult;
	assert.equal(typeof renderResult, "function");
	const invoke = renderResult as (
		result: { content: { type: string; text: string }[]; details: Record<string, unknown> },
		options: { expanded: boolean },
		theme: FakeTheme,
		context: { keyHint: typeof customHint; outputPad: number },
	) => Component;
	const component = invoke(
		{ content: [{ type: "text", text: longBody }], details: {} },
		{ expanded: false },
		theme,
		{ keyHint: customHint, outputPad: 1 },
	);
	return component.render(160).join("\n");
}

test("backlog and memory renderers forward Pi's custom key hint without taking over the tool shell", () => {
	const backlog = registerAndRenderTool((pi) => registerBacklogTool(pi as never, (() => { throw new Error("not executed"); }) as never));
	const memory = registerAndRenderTool((pi) => registerMemoryTool(pi as never, (() => { throw new Error("not executed"); }) as never));
	for (const output of [backlog, memory]) {
		assert.match(output, /F9 expands/);
		assert.doesNotMatch(output, /ctrl\+o/);
		assert.match(output, /A full tool result/);
		assert.doesNotMatch(output, /^\s{1,}A full tool result/, "Pi's outer tool shell owns padding");
		assert.doesNotMatch(output, /^memory(?:\n|$)|^backlog(?:\n|$)/, "Pi owns the tool title");
	}
});
