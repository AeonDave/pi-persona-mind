import assert from "node:assert/strict";
import { test } from "node:test";

import { diagnoseTokenReference, validateTokenReferenceFixture } from "../scripts/token-diagnostic.ts";
import { evaluateMemoryFixture } from "../scripts/evaluate-memory.ts";
import { rankMemoryEntries } from "../src/core/retrieval.ts";
import { MEMORY_EVALUATION_CASES, MEMORY_EVALUATION_FACTS } from "./fixtures/memory-evaluation.ts";
import { TOKEN_REFERENCE_FIXTURE, type TokenReferenceFixture } from "./fixtures/token-reference.ts";

test("synthetic memory evaluation is stable and improves ranking over substring order", () => {
	const report = evaluateMemoryFixture();
	assert.equal(report.facts, 31);
	assert.equal(report.cases, 30);
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

test("paired sentinels report live retrieval and injection outcomes and detect a removed-fact control", () => {
	const report = evaluateMemoryFixture();
	assert.ok(report.sentinels);
	assert.equal(report.sentinels.allPassed, true);
	for (const id of ["owner-current-again", "owner-old-history", "retry-exception", "retry-old-history", "session-branch", "branch-exception", "capture-origin"]) {
		const outcome = report.sentinels.cases.find((item) => item.caseId === id);
		assert.ok(outcome, `missing sentinel ${id}`);
		assert.equal(outcome.rank, 1, `${id}: ${JSON.stringify(outcome)}`);
		assert.equal(outcome.injected, true, `${id}: ${JSON.stringify(outcome)}`);
		assert.equal(outcome.passed, true, `${id}: ${JSON.stringify(outcome)}`);
		if (id !== "capture-origin") {
			assert.ok(outcome.contrastRank !== undefined && outcome.contrastRank !== null && outcome.rank !== null && outcome.contrastRank > outcome.rank, `${id}: ${JSON.stringify(outcome)}`);
		}
	}

	const withoutCurrentOwner = MEMORY_EVALUATION_FACTS.filter((fact) => fact.id !== "owner-current");
	const negativeControl = evaluateMemoryFixture(withoutCurrentOwner);
	const failedSentinel = negativeControl.sentinels.cases.find((item) => item.caseId === "owner-current-again");
	assert.ok(failedSentinel);
	assert.equal(failedSentinel.rank, null);
	assert.equal(failedSentinel.injected, false);
	assert.equal(failedSentinel.passed, false);
	assert.equal(negativeControl.sentinels.allPassed, false);
});

test("published token-reference vectors report the unchanged byte estimate without implying model billing", () => {
	const report = diagnoseTokenReference();
	assert.equal(report.encoding, "cl100k_base");
	assert.equal(report.vectors.length, 8);
	assert.equal(report.verification, "source literals transcribed; source assertions not locally executed tokenizer verification");
	assert.equal(report.interpretation, "published cl100k_base reference vectors, not current-model billing");
	assert.equal(report.languagePolicy, "all text uses the same UTF-8 bytes / 3 estimate; no language detection or per-language factor");
	assert.deepEqual(report.vectors.map((vector) => [vector.id, vector.estimatedTokens, vector.referenceTokenCount, vector.signedDifference]), [
		["hello-world", 4, 2, 2],
		["rer", 1, 1, 0],
		["apostrophe-rer", 2, 2, 0],
		["today-newline-space", 3, 3, 0],
		["today-newline-space-newline", 3, 2, 1],
		["today-newline-two-spaces-newline", 3, 2, 1],
		["control-u0085", 2, 4, -2],
		["thumbs-up", 2, 3, -1],
	]);
	assert.deepEqual(report.errorSummary, {
		vectorCount: 8,
		underestimateCount: 2,
		totalAbsoluteDifference: 7,
		maxAbsoluteDifference: 2,
		meanAbsoluteDifference: 0.875,
	});
	assert.equal(report.provenance.implementation, "openai/tiktoken");
	assert.equal(report.provenance.implementationVersion, "79dc2c0533685b893616c78160b5d9e40876e724");
	assert.equal(report.provenance.sourceCommitterDate, "2026-11-08T08:48:19Z");
	assert.equal(report.provenance.sourceURL, "https://raw.githubusercontent.com/openai/tiktoken/79dc2c0533685b893616c78160b5d9e40876e724/tests/test_encoding.py");
	assert.equal(report.provenance.sourceFileSHA256, "6d81f28bb3c2877a3b02f2520047939c70640fe0104994c97a15a9b493ae6ca7");
	assert.equal(report.provenance.licenseURL, "https://raw.githubusercontent.com/openai/tiktoken/79dc2c0533685b893616c78160b5d9e40876e724/LICENSE");
});

test("token-reference integrity checks detect text, hash, ID, count, and provenance corruption", () => {
	assert.doesNotThrow(() => validateTokenReferenceFixture(TOKEN_REFERENCE_FIXTURE));
	const changedVector = (id: string, update: Partial<TokenReferenceFixture["vectors"][number]>): TokenReferenceFixture => ({
		...TOKEN_REFERENCE_FIXTURE,
		vectors: TOKEN_REFERENCE_FIXTURE.vectors.map((vector) => vector.id === id ? { ...vector, ...update } : vector),
	});
	const first = TOKEN_REFERENCE_FIXTURE.vectors[0];
	assert.ok(first);
	assert.throws(() => validateTokenReferenceFixture(changedVector(first.id, { text: `${first.text}!` })), /text SHA-256/i);
	assert.throws(() => validateTokenReferenceFixture(changedVector(first.id, { textSHA256: "0".repeat(64) })), /text SHA-256/i);
	assert.throws(() => validateTokenReferenceFixture(changedVector(first.id, { expectedTokenIDsSHA256: "0".repeat(64) })), /token ID SHA-256/i);
	assert.throws(() => validateTokenReferenceFixture(changedVector(first.id, { expectedTokenIds: [1, 2] })), /token ID SHA-256/i);
	assert.throws(() => validateTokenReferenceFixture(changedVector(first.id, { expectedTokenCount: first.expectedTokenCount + 1 })), /count/i);
	assert.throws(() => validateTokenReferenceFixture({
		...TOKEN_REFERENCE_FIXTURE,
		provenance: { ...TOKEN_REFERENCE_FIXTURE.provenance, sourceURL: "" },
	}), /provenance/i);
	assert.throws(() => validateTokenReferenceFixture({ ...TOKEN_REFERENCE_FIXTURE, provenance: undefined } as unknown as TokenReferenceFixture), /provenance/i);
});
