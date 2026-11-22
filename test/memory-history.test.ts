import assert from "node:assert/strict";
import { test } from "node:test";
import { makeMemory } from "../src/core/memory.ts";
import type { OptimizeHistory, OptimizeReceipt } from "../src/core/optimize-history.ts";
import type { MemoryOptimizer } from "../src/core/optimize-service.ts";
import { formatMemoryHistory, runMemoryHistory } from "../src/tools/memory-history.ts";

const entry = makeMemory({ term: "long", kind: "note", text: "A".repeat(8_000) }, Date.parse("2026-11-22T10:00:00Z"));
const receipt: OptimizeReceipt = { receiptId: "00000000-0000-0000-0000-000000000001", origin: "replacement", target: "project-long", persona: "dev", createdAt: "2026-11-22T10:00:00Z", state: "applied", storePath: "private-store-location", changes: [{ before: [entry], after: { ...entry, text: "B".repeat(8_000) } }] };
const history: OptimizeHistory = { ok: true, target: "project-long", receipts: [receipt], retained: 1, omitted: 0, withheldUnsafe: 0, limit: 32, maxBytes: 2_097_152 };

test("history discovery is compact and does not reveal bodies or storage paths", () => {
	const result = formatMemoryHistory(history);
	assert.match(result.content[0]!.text, /replacement/);
	assert.doesNotMatch(JSON.stringify(result), /AAAA|BBBB|private-store-location/);
	assert.match(result.content[0]!.text, /receiptId/);
});

test("receipt detail is explicitly scoped, paged and reconstructs the retained record", async () => {
	let calls = 0;
	const optimizer = { getReceipt: async () => { calls++; return { ok: true, target: "project-long", receipt }; } } as unknown as MemoryOptimizer;
	assert.equal((await runMemoryHistory(optimizer, { receiptId: receipt.receiptId })).details.ok, false);
	assert.equal((await runMemoryHistory(optimizer, { target: "project-long", offset: 1 })).details.ok, false);
	assert.equal(calls, 0);
	let offset = 0; let body = "";
	for (;;) {
		const result = await runMemoryHistory(optimizer, { target: "project-long", receiptId: receipt.receiptId, offset });
		assert.equal(result.details.ok, true);
		assert.ok((result.details.page as string).length <= 12_000);
		assert.doesNotMatch(JSON.stringify(result), /private-store-location/);
		assert.match(result.content[0]!.text, /historical.*not active/i);
		body += result.details.page;
		if (result.details.nextOffset === undefined) break;
		offset = result.details.nextOffset as number;
	}
	const parsed = JSON.parse(body);
	assert.deepEqual(parsed.changes, receipt.changes);
	assert.equal(parsed.origin, "replacement");
	assert.equal(parsed.storePath, undefined);
	assert.equal(calls, 2);
});
