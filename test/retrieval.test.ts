import assert from "node:assert/strict";
import { test } from "node:test";

import { makeMemory } from "../src/core/memory.ts";
import { rankMemoryEntries } from "../src/core/retrieval.ts";

const NOW = Date.parse("2026-10-25T00:00:00.000Z");
const HOUR = 3_600_000;

test("known query terms outrank a newer irrelevant memory", () => {
	const irrelevant = makeMemory({ term: "long", kind: "note", text: "The release screenshot uses a dark theme" }, NOW);
	const relevant = makeMemory({ term: "long", kind: "note", text: "Retry provider errors only after a timeout" }, NOW - 30 * 24 * HOUR);
	const ranked = rankMemoryEntries([irrelevant, relevant], "retry provider timeout");
	assert.equal(ranked[0]?.entry.id, relevant.id);
	assert.deepEqual(ranked[0]?.textTerms, ["retry", "provider", "timeout"]);
});

test("explicit tags provide a controlled paraphrase bridge without a synonym dictionary", () => {
	const tagged = makeMemory({ term: "long", kind: "gotcha", text: "MCP adapter waits on interactive OAuth", tags: ["startup stall"] }, NOW);
	const unrelated = makeMemory({ term: "long", kind: "note", text: "Startup commands are documented here" }, NOW);
	const ranked = rankMemoryEntries([unrelated, tagged], "startup stall");
	assert.equal(ranked[0]?.entry.id, tagged.id);
	assert.deepEqual(ranked[0]?.tagTerms, ["startup", "stall"]);
});

test("repository paths receive an exact path boost and expose the matched path", () => {
	const neighbor = makeMemory({ term: "long", kind: "note", text: "src/core/service.ts builds the injection" }, NOW);
	const target = makeMemory({ term: "long", kind: "note", text: "src/core/inject.ts renders bounded memory" }, NOW - HOUR);
	const ranked = rankMemoryEntries([neighbor, target], "src/core/inject.ts");
	assert.equal(ranked[0]?.entry.id, target.id);
	assert.deepEqual(ranked[0]?.pathMatches, ["src/core/inject.ts"]);
});

test("negation and exception words remain searchable as explicit terms", () => {
	const broad = makeMemory({ term: "long", kind: "invariant", text: "Retry provider errors automatically after every failure" }, NOW);
	const constrained = makeMemory({ term: "long", kind: "invariant", text: "Do not retry provider errors except after explicit operator approval" }, NOW - HOUR);
	const ranked = rankMemoryEntries([broad, constrained], "do not retry provider errors except after explicit operator approval");
	assert.equal(ranked[0]?.entry.id, constrained.id);
	assert.ok(ranked[0]?.textTerms.includes("not"));
	assert.ok(ranked[0]?.textTerms.includes("except"));
});

test("an empty query keeps deterministic load-bearing kind and recency ordering", () => {
	const recentNote = makeMemory({ term: "long", kind: "note", text: "recent" }, NOW);
	const oldInvariant = makeMemory({ term: "long", kind: "invariant", text: "old" }, NOW - 30 * 24 * HOUR);
	const ranked = rankMemoryEntries([recentNote, oldInvariant], "");
	assert.deepEqual(ranked.map((item) => item.entry.id), [oldInvariant.id, recentNote.id]);
});

test("contiguous CJK text can be queried with overlapping character bigrams", () => {
	const cjk = makeMemory({ term: "long", kind: "note", text: "修复登录流程" }, NOW);
	assert.equal(rankMemoryEntries([cjk], "修复")[0]?.entry.id, cjk.id);
});

test("synthetic lexical retrieval fixtures score 4/4 top-one without claiming semantic quality", () => {
	const cases = [
		{
			query: "retry provider timeout",
			irrelevant: makeMemory({ term: "long", kind: "note", text: "Recent release screenshot uses a dark theme" }, NOW),
			target: makeMemory({ term: "long", kind: "note", text: "Retry provider errors only after a timeout" }, NOW - 30 * 24 * HOUR),
		},
		{
			query: "startup stall",
			irrelevant: makeMemory({ term: "long", kind: "note", text: "Startup commands are documented here" }, NOW),
			target: makeMemory({ term: "long", kind: "gotcha", text: "MCP adapter waits on interactive OAuth", tags: ["startup stall"] }, NOW - HOUR),
		},
		{
			query: "src/core/inject.ts",
			irrelevant: makeMemory({ term: "long", kind: "note", text: "src/core/service.ts builds the injection" }, NOW),
			target: makeMemory({ term: "long", kind: "note", text: "src/core/inject.ts renders bounded memory" }, NOW - HOUR),
		},
		{
			query: "do not retry provider errors except after explicit operator approval",
			irrelevant: makeMemory({ term: "long", kind: "invariant", text: "Retry provider errors automatically after every failure" }, NOW),
			target: makeMemory({ term: "long", kind: "invariant", text: "Do not retry provider errors except after explicit operator approval" }, NOW - HOUR),
		},
	];
	const hits = cases.filter(({ query, irrelevant, target }) => rankMemoryEntries([irrelevant, target], query)[0]?.entry.id === target.id).length;
	const topOneRate = hits / cases.length;
	assert.equal(hits, 4);
	assert.equal(topOneRate, 1);
});
