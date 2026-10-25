import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateMemoryFixture } from "../scripts/evaluate-memory.ts";
import { rankMemoryEntries } from "../src/core/retrieval.ts";
import { MEMORY_EVALUATION_CASES, MEMORY_EVALUATION_FACTS } from "./fixtures/memory-evaluation.ts";

test("synthetic memory evaluation is stable and improves ranking over substring order", () => {
	const report = evaluateMemoryFixture();
	assert.equal(report.facts, 31);
	assert.equal(report.cases, 28);
	assert.ok(report.methods.ranked.hitAt1 >= 0.9, JSON.stringify(report.methods));
	assert.ok(report.methods.ranked.hitAt3 >= 0.95, JSON.stringify(report.methods));
	assert.ok(report.methods.ranked.mrr >= 0.9, JSON.stringify(report.methods));
	assert.ok(report.methods.ranked.hitAt1 > report.methods.substringBaseline.hitAt1, JSON.stringify(report.methods));
	assert.equal(report.methods.ranked.abstentionCorrect, 1);
	assert.equal(report.injection.withinBudget, true);
	assert.ok(report.injection.maxCharacters <= 6_000, JSON.stringify(report.injection));
	assert.ok(report.injection.maxEstimatedTokens <= report.injection.tokenBudget, JSON.stringify(report.injection));
});

test("a missing synonym tag produces an honest lexical abstention", () => {
	const item = MEMORY_EVALUATION_CASES.find((candidate) => candidate.id === "unlabeled-synonym-abstention");
	assert.ok(item);
	assert.deepEqual(item.relevantIds, []);
	const ranked = rankMemoryEntries(MEMORY_EVALUATION_FACTS, item.query).filter((entry) => entry.score > 0);
	assert.deepEqual(ranked, []);
	assert.ok(MEMORY_EVALUATION_FACTS.find((entry) => entry.id === "no-synonym")?.tags.includes("compaction"));
});
