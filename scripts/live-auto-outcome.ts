import assert from "node:assert/strict";

export interface LiveAutoCard { title: string; content: string }
export interface LiveAutoInspection { total: number; fingerprint: string }
export interface LiveAutoReceipt {
	receiptId: string; target: string; state: string;
	changes: readonly { before: readonly { id: string }[]; after: { id: string } }[];
}
export interface LiveAutoOutcomeInput {
	cards: readonly LiveAutoCard[];
	notifications: readonly { message: string; level: string }[];
	proposals: readonly { content: string }[];
	proposalBeforeSettlement: boolean;
	workerOutput: string;
	before: LiveAutoInspection;
	after: LiveAutoInspection;
	receipts: readonly LiveAutoReceipt[];
}
export type LiveAutoOutcome = "applied" | "conservative-no-op";

/** Qualify the settled worker through independent audit, UI, store and history evidence. */
export function assertLiveAutoOutcome(input: LiveAutoOutcomeInput): LiveAutoOutcome {
	assert.equal(input.cards.length, 0, "automatic success or no-op must not create result cards");
	assert.equal(input.before.total, 2, "fixture must start with two persona records");
	assert.ok(input.before.fingerprint && input.after.fingerprint, "store inspections need fingerprints");
	const output: unknown = JSON.parse(input.workerOutput);
	assert.ok(output && typeof output === "object" && Array.isArray((output as { operations?: unknown }).operations), "worker output must contain operations");
	const operations = (output as { operations: { sourceIds?: unknown }[] }).operations;
	if (operations.length === 0) {
		assert.equal(input.notifications.length, 0, "no-op is silent");
		assert.equal(input.proposals.length, 0);
		assert.equal(input.receipts.length, 0);
		assert.equal(input.after.total, 2);
		assert.equal(input.after.fingerprint, input.before.fingerprint);
		return "conservative-no-op";
	}
	assert.equal(operations.length, 1);
	const sourceIds = operations[0]?.sourceIds;
	assert.ok(Array.isArray(sourceIds) && sourceIds.length === 2 && new Set(sourceIds).size === 2, "automatic consolidation must use both distinct records");
	assert.deepEqual(input.notifications, [{ message: "mind · persona · 1 replacement applied", level: "info" }]);
	assert.equal(input.proposals.length, 1);
	assert.match(input.proposals[0]!.content, /Staged proposed change/);
	assert.match(input.proposals[0]!.content, /"before":/);
	assert.match(input.proposals[0]!.content, /"after":/);
	assert.equal(input.proposalBeforeSettlement, true, "proposal audit precedes apply settlement");
	assert.equal(input.after.total, 1, "both records must consolidate into one");
	assert.notEqual(input.after.fingerprint, input.before.fingerprint);
	assert.equal(input.receipts.length, 1);
	const receipt = input.receipts[0]!;
	assert.ok(receipt.receiptId && receipt.target === "persona" && receipt.state === "applied", "one finalized persona receipt is required");
	assert.equal(receipt.changes.length, 1);
	assert.deepEqual(receipt.changes[0]!.before.map((entry) => entry.id).sort(), [...sourceIds].sort(), "receipt must cover the actual proposal sources");
	assert.ok(receipt.changes[0]!.after.id, "receipt must retain replacement");
	return "applied";
}
