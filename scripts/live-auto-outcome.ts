import assert from "node:assert/strict";

export interface LiveAutoCard { title: string; content: string }
export interface LiveAutoInspection { total: number; fingerprint: string }
export interface LiveAutoReceipt { receiptId: string; target: string; state: string }
export interface LiveAutoOutcomeInput {
	cards: readonly LiveAutoCard[];
	before: LiveAutoInspection;
	after: LiveAutoInspection;
	receipts: readonly LiveAutoReceipt[];
}
export type LiveAutoOutcome = "applied" | "conservative-no-op";

const NO_OP_LINE = "Bounded coverage: one selected record window; bounded review found no safe consolidation in this record set.";

/** Qualify the automatic result using the durable card and independent post-run inspection. */
export function assertLiveAutoOutcome(input: LiveAutoOutcomeInput): LiveAutoOutcome {
	const results = input.cards.filter((card) => card.title === "Mind automatic result");
	const noOps = input.cards.filter((card) => card.title === "Mind automatic optimization" && card.content.split(/\r?\n/, 1)[0] === NO_OP_LINE);
	assert.equal(results.length + noOps.length, 1, "expected exactly one successful automatic result or bounded no-op");
	assert.equal(input.before.total, 2, "isolated automatic fixture must start with its two persona records");
	assert.equal(typeof input.before.fingerprint, "string");
	assert.ok(input.before.fingerprint.length > 0, "before inspection must carry the store fingerprint");
	assert.equal(typeof input.after.fingerprint, "string");
	assert.ok(input.after.fingerprint.length > 0, "after inspection must carry the store fingerprint");

	if (noOps.length === 1) {
		assert.equal(input.after.total, input.before.total, "a conservative no-op must preserve the inspected record count");
		assert.equal(input.after.fingerprint, input.before.fingerprint, "a conservative no-op must preserve the exact inspected store fingerprint");
		return "conservative-no-op";
	}

	const result = results[0]!;
	assert.doesNotMatch(result.content, /^\s*Warning\s*:/im, "a warned apply is not a clean automatic success");
	const firstLine = result.content.split(/\r?\n/, 1)[0] ?? "";
	const summary = /^Bounded coverage: one selected record window; (\d+) → (\d+) memories; (\d+) replacement\(s\)$/u.exec(firstLine);
	assert.ok(summary, `automatic result must use the exact success summary grammar: ${firstLine}`);
	const beforeCount = Number(summary[1]);
	const afterCount = Number(summary[2]);
	const replacements = Number(summary[3]);
	assert.equal(beforeCount, input.before.total, "reported before count must match the initial persona inspection");
	assert.equal(afterCount, input.after.total, "reported after count must match the final persona inspection");
	assert.ok(afterCount >= 1 && afterCount <= 2, "the isolated fixture must retain one or two persona records");
	assert.ok(replacements > 0 && replacements <= 2, "successful automatic apply must report one or two replacements");
	assert.notEqual(input.after.fingerprint, input.before.fingerprint, "a successful consolidation must change the inspected store fingerprint");

	const undoLines = [...result.content.matchAll(/^Undo: \/mind optimize undo ([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}) persona\.$/gim)];
	assert.equal(undoLines.length, 1, "successful automatic apply must show one persona undo receipt");
	const receiptId = undoLines[0]?.[1];
	assert.ok(receiptId, "persona undo receipt id must be present");
	assert.ok(input.receipts.some((receipt) => receipt.receiptId === receiptId && receipt.target === "persona" && receipt.state === "applied"), "the undo link must resolve to a durable applied receipt in persona history");
	return "applied";
}
