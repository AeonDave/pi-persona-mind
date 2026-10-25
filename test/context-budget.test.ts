import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateTokens, fitContextItems } from "../src/core/context-budget.ts";

const render = (items: readonly string[], omitted: number): string =>
	`<session-notes>\n${items.map((item) => JSON.stringify({ text: item })).join("\n")}\n</session-notes>\n${omitted} more notes omitted.`;

test("the shared estimate counts Unicode by UTF-8 bytes and is explicitly an approximation", () => {
	assert.equal(estimateTokens(""), 0);
	assert.ok(estimateTokens("🧠") > estimateTokens("x"));
	assert.equal(estimateTokens(["abc", "def"]), estimateTokens("abc") + estimateTokens("def") + 1, "the shared-block separator is budgeted");
});

test("whole entries fit together with fixed blocks and the rendered fence stays intact", () => {
	const firstOnly = render(["first whole note"], 1);
	const fixed = ["<session-notes>objective</session-notes>", "<session-summary>current branch</session-summary>"];
	const result = fitContextItems(
		[{ value: "first whole note" }, { value: "second whole note" }],
		{ maxTokens: estimateTokens([...fixed, firstOnly]), fixedBlocks: fixed, render },
	);
	assert.deepEqual(result.items, ["first whole note"]);
	assert.equal(result.omitted, 1);
	assert.equal(result.text, firstOnly);
	assert.ok(result.text.endsWith("</session-notes>\n1 more notes omitted."));
	assert.ok(result.estimatedTokens <= estimateTokens([...fixed, firstOnly]));
});

test("a pinned constraint has priority but is omitted whole when it cannot fit the hard budget", () => {
	const constraint = "Never remove the old store before the replacement is durable.";
	const disclosureBudget = estimateTokens(render([], 1));
	const result = fitContextItems(
		[{ value: constraint, pinned: true }],
		{ maxTokens: disclosureBudget, render },
	);
	assert.deepEqual(result.items, []);
	assert.equal(result.omitted, 1);
	assert.equal(result.overBudget, false);
	assert.ok(!result.text.includes(constraint));
	assert.ok(result.text.endsWith("</session-notes>\n1 more notes omitted."));
});

test("an optional section is omitted as a whole and reported instead of clipping its contents", () => {
	const longEntry = "exception: retry only when the provider marks the timeout recoverable";
	const result = fitContextItems(
		[{ value: longEntry }],
		{ maxTokens: 1, render },
	);
	assert.deepEqual(result.items, []);
	assert.equal(result.omitted, 1);
	assert.equal(result.text, render([], 1));
	assert.ok(!result.text.includes("recoverable"));
});
