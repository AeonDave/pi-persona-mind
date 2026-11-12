import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLiveAutoOutcome, type LiveAutoOutcomeInput } from "../scripts/live-auto-outcome.ts";

function fixture(overrides: Partial<LiveAutoOutcomeInput> = {}): LiveAutoOutcomeInput {
	return {
		before: { total: 2, fingerprint: "before" }, after: { total: 1, fingerprint: "after" },
		cards: [], notifications: [{ message: "mind · persona · 1 replacement applied", level: "info" }],
		proposals: [{ content: 'Staged proposed change "before": "after":' }],
		proposalBeforeSettlement: true,
		workerOutput: '{"operations":[{"sourceIds":["a","b"]}]}',
		receipts: [{ receiptId: "one", target: "persona", state: "applied", changes: [{ before: [{ id: "a" }, { id: "b" }], after: { id: "c" } }] }],
		...overrides,
	};
}

test("qualified apply requires one toast, an unrendered proposal and a 2-to-1 applied receipt", () => {
	assert.equal(assertLiveAutoOutcome(fixture()), "applied");
	for (const change of [
		{ cards: [{ title: "Mind automatic result", content: "" }] },
		{ notifications: [] },
		{ notifications: [{ message: "mind · persona · 1 replacement applied", level: "warning" }] },
		{ proposals: [] },
		{ proposalBeforeSettlement: false },
		{ receipts: [] },
		{ after: { total: 2, fingerprint: "after" } },
	]) assert.throws(() => assertLiveAutoOutcome(fixture(change)));
});

test("silent no-op requires an empty worker proposal and unchanged exact store", () => {
	const unchanged = { total: 2, fingerprint: "before" };
	const noOp = fixture({ after: unchanged, notifications: [], proposals: [], receipts: [], workerOutput: '{"operations":[]}' });
	assert.equal(assertLiveAutoOutcome(noOp), "conservative-no-op");
	assert.throws(() => assertLiveAutoOutcome({ ...noOp, workerOutput: '{"operations":[{"sourceIds":["a"]}]}' }));
	assert.throws(() => assertLiveAutoOutcome({ ...noOp, notifications: [{ message: "warning", level: "warning" }] }));
});

test("failed, warned, uncertain and single-source outcomes never qualify", () => {
	for (const change of [
		{ workerOutput: '{"operations":[{"sourceIds":["a"]}]}' },
		{ notifications: [{ message: "mind · persona review needs attention", level: "warning" }] },
		{ receipts: [{ receiptId: "one", target: "persona", state: "prepared", changes: [{ before: [{ id: "a" }, { id: "b" }], after: { id: "c" } }] }] },
		{ receipts: [{ receiptId: "one", target: "persona", state: "applied", changes: [{ before: [{ id: "a" }], after: { id: "c" } }] }] },
	]) assert.throws(() => assertLiveAutoOutcome(fixture(change)));
});
