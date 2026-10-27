import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLiveAutoOutcome, type LiveAutoCard, type LiveAutoInspection, type LiveAutoOutcomeInput } from "../scripts/live-auto-outcome.ts";

const receiptId = "00000000-0000-4000-8000-000000000001";
const successBody = `Bounded coverage: one selected record window; 2 → 1 memories; 1 replacement(s)\nUndo: /mind optimize undo ${receiptId} persona.`;

function fixture(overrides: Partial<LiveAutoOutcomeInput> = {}): LiveAutoOutcomeInput {
	const before: LiveAutoInspection = { total: 2, fingerprint: "before-fingerprint" };
	const after: LiveAutoInspection = { total: 1, fingerprint: "after-fingerprint" };
	const cards: LiveAutoCard[] = [{ title: "Mind automatic result", content: successBody }];
	return {
		cards, before, after,
		receipts: [{ receiptId, target: "persona", state: "applied" }],
		...overrides,
	};
}

test("a successful automatic consolidation has matching counts and a durable persona undo receipt", () => {
	assert.equal(assertLiveAutoOutcome(fixture()), "applied");
});

test("a valid single-source rewrite may retain both inspected records", () => {
	const content = `Bounded coverage: one selected record window; 2 → 2 memories; 1 replacement(s)\nUndo: /mind optimize undo ${receiptId} persona.`;
	assert.equal(assertLiveAutoOutcome(fixture({
		after: { total: 2, fingerprint: "changed-after-fingerprint" },
		cards: [{ title: "Mind automatic result", content }],
	})), "applied");
});

test("a refused apply with the result title and unchanged two-record store is rejected", () => {
	const before = { total: 2, fingerprint: "same-fingerprint" };
	assert.throws(() => assertLiveAutoOutcome(fixture({
		before, after: before,
		cards: [{ title: "Mind automatic result", content: "Bounded coverage: one selected record window; not applied: memory store changed." }],
		receipts: [],
	})));
});

test("a conservative no-op is accepted only when the exact store fingerprint is unchanged", () => {
	const before = { total: 2, fingerprint: "same-fingerprint" };
	const cards = [{ title: "Mind automatic optimization", content: "Bounded coverage: one selected record window; bounded review found no safe consolidation in this record set." }];
	assert.equal(assertLiveAutoOutcome(fixture({ before, after: before, cards, receipts: [] })), "conservative-no-op");
	assert.throws(() => assertLiveAutoOutcome(fixture({
		before,
		after: { total: 2, fingerprint: "changed-fingerprint" },
		cards,
		receipts: [],
	})));
});

test("successful summary counts must agree with the before and after inspections", () => {
	assert.throws(() => assertLiveAutoOutcome(fixture({ after: { total: 2, fingerprint: "after-fingerprint" } })));
});

test("a result title without the exact coverage and replacement grammar is not success", () => {
	assert.throws(() => assertLiveAutoOutcome(fixture({
		cards: [{ title: "Mind automatic result", content: `Applied 1 replacement\nUndo: /mind optimize undo ${receiptId} persona.` }],
	})));
	assert.throws(() => assertLiveAutoOutcome(fixture({
		cards: [{ title: "Mind automatic result", content: `Bounded coverage: one selected record window; 2 → 1 memories; 0 replacement(s)\nUndo: /mind optimize undo ${receiptId} persona.` }],
	})));
});

test("an apply warning cannot qualify as a clean automatic success", () => {
	assert.throws(() => assertLiveAutoOutcome(fixture({
		cards: [{ title: "Mind automatic result", content: `${successBody}\nWarning: receipt finalization failed.` }],
	})));
});

test("the undo link must resolve to a retained applied receipt for persona", () => {
	assert.throws(() => assertLiveAutoOutcome(fixture({ receipts: [] })));
	for (const receipt of [
		{ receiptId, target: "persona", state: "prepared" },
		{ receiptId, target: "persona", state: "rejected" },
		{ receiptId, target: "persona", state: "undone" },
		{ receiptId, target: "project", state: "applied" },
		{ receiptId: "00000000-0000-4000-8000-000000000002", target: "persona", state: "applied" },
	]) assert.throws(() => assertLiveAutoOutcome(fixture({ receipts: [receipt] })));
});

test("missing automatic outcome cards are rejected", () => {
	assert.throws(() => assertLiveAutoOutcome(fixture({ cards: [] })));
});
