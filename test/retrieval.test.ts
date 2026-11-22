import assert from "node:assert/strict";
import { test } from "node:test";

import { makeMemory } from "../src/core/memory.ts";
import { rankMemoryEntries, rankRetrievalEntries } from "../src/core/retrieval.ts";

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
	assert.ok((rankMemoryEntries([cjk], "修复")[0]?.score ?? 0) > 0);
	for (const text of ["로그인", "ログイン", "Καλημέρα", "привет"]) {
		const entry = makeMemory({ term: "long", kind: "note", text }, NOW);
		assert.ok((rankMemoryEntries([entry], text)[0]?.score ?? 0) > 0, text);
	}
});

test("word queries discover camelCase and acronym boundaries without replacing original tokens", () => {
	const entry = makeMemory({ term: "long", kind: "note", text: "resolveMemoryOwner and parseHTTPResponse" }, NOW);
	assert.ok((rankMemoryEntries([entry], "memory owner")[0]?.score ?? 0) > 0);
	assert.ok((rankMemoryEntries([entry], "http response")[0]?.score ?? 0) > 0);
	assert.ok((rankMemoryEntries([entry], "resolveMemoryOwner")[0]?.score ?? 0) > 0);
	const exact = makeMemory({ term: "long", kind: "note", text: "memory owner" }, NOW - HOUR);
	assert.equal(rankMemoryEntries([entry, exact], "memory owner")[0]?.entry.id, exact.id);
	assert.equal(rankMemoryEntries([exact, entry], "resolveMemoryOwner")[0]?.entry.id, entry.id);
});

test("Latin accented case boundaries bridge words without crossing scripts or merging protected atoms", () => {
	for (const [text, query] of [["résuméOwner", "resume owner"], ["parseHTTPRéponse", "http reponse"]]) {
		const result = rankRetrievalEntries([{ text: text! }], query!)[0]!;
		assert.equal(result.score, 2, text);
		assert.deepEqual(result.normalizedTerms, query!.split(" "));
	}
	for (const [text, query] of [["alphaЖук", "alpha"], ["版本2.14.9", "2.14.8"], ["a17bc92f", "a17bc92e"]]) {
		assert.equal(rankRetrievalEntries([{ text: text! }], query!)[0]?.score, 0, text);
	}
});

test("repeated tokens preserve each unique term's score and attribution", () => {
	const once = { text: "résuméOwner cafe parser never", tags: ["startupStall"] };
	const repeated = { text: `${once.text} `.repeat(120), tags: Array(80).fill("startupStall") };
	const query = "resume owner cafe parser never startup stall";
	const a = rankRetrievalEntries([once], query)[0]!;
	const b = rankRetrievalEntries([repeated], query)[0]!;
	assert.deepEqual({ ...a, entry: undefined }, { ...b, entry: undefined });
});

test("vowel accent variants are weaker bridges, preserve NFC equivalence and do not conflate consonants", () => {
	const accented = makeMemory({ term: "long", kind: "note", text: "café naïve résumé año" }, NOW);
	assert.ok((rankMemoryEntries([accented], "cafe naive resume")[0]?.score ?? 0) > 0);
	assert.equal(rankMemoryEntries([accented], "cafe\u0301")[0]?.score, rankMemoryEntries([accented], "café")[0]?.score);
	assert.equal(rankMemoryEntries([accented], "ano")[0]?.score, 0);
	const exact = makeMemory({ term: "long", kind: "note", text: "cafe" }, NOW - HOUR);
	assert.equal(rankMemoryEntries([accented, exact], "cafe")[0]?.entry.id, exact.id);
});

test("near-misses, numeric versions and hashes do not collapse into normalized word matches", () => {
	const entry = makeMemory({ term: "long", kind: "note", text: "v2.14.9 3.15.2 a17bc92f deadBeef memoryOwnership" }, NOW);
	for (const query of ["v2.14.8", "3.15.3", "a17bc92e", "dead beef", "owner"]) {
		assert.equal(rankMemoryEntries([entry], query)[0]?.score, 0, query);
	}
	assert.ok((rankMemoryEntries([entry], "v2.14.9")[0]?.score ?? 0) > 0);
});

test("dotted prerelease and build versions match only their complete version atom", () => {
	const entry = { text: "Qualified v2.14.9-alpha.1+build.7. Next release is 3.2.1-rc.4." };
	for (const query of ["v2.14.9-alpha.2+build.7", "v2.14.9-alpha.1+build.8", "v2.14.9-alpha.1", "3.2.1-rc.5"]) {
		assert.equal(rankRetrievalEntries([entry], query)[0]?.score, 0, query);
	}
	for (const query of ["v2.14.9-alpha.1+build.7", "3.2.1-rc.4"]) {
		assert.equal(rankRetrievalEntries([entry], query)[0]?.score, 3, query);
	}
	assert.equal(rankRetrievalEntries([entry], "next release")[0]?.score, 6);
});

test("normalized tags and reverse identifier queries share the ranker and expose weak matches", () => {
	const tagged = { text: "Transport settings", tags: ["parseHTTPResponse", "café"] };
	const ranked = rankRetrievalEntries([tagged], "http response cafe")[0];
	assert.deepEqual(ranked?.tagTerms, ["http", "response", "cafe"]);
	assert.deepEqual(ranked?.normalizedTerms, ["http", "response", "cafe"]);
	const prose = makeMemory({ term: "long", kind: "note", text: "resolve memory owner" }, NOW);
	assert.deepEqual(rankMemoryEntries([prose], "resolveMemoryOwner")[0]?.normalizedTerms, ["resolvememoryowner"]);
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
