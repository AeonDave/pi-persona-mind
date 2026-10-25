/** Exercise new memory contracts through the loaded host tool pipeline, never private stores. */
import assert from "node:assert/strict";

export async function qualifyMemory(session) {
	const context = session.extensionRunner.createToolContext("mind-memory-qualification", undefined);
	const call = async (args, expected = true) => {
		const outcome = await context.executeTool("memory", args);
		assert.equal(outcome.isError, !expected, JSON.stringify(outcome));
		assert.equal(outcome.result?.details?.ok, expected, JSON.stringify(outcome.result));
		return outcome.result;
	};
	const text = "The isolated session investigation concerns the amber fixture. ".repeat(20);
	const saved = await call({ action: "remember", term: "session", kind: "note", text, source: "local qualification" });
	const sessionId = saved.details.id;
	assert.match(sessionId, /^session:/);
	const read = await call({ action: "read", id: sessionId });
	assert.equal(read.details.entry.text, text.trim());
	assert.equal(read.details.entry.originSessionId, session.sessionManager.getSessionId());
	assert.equal(read.details.storage, session.sessionManager.getSessionFile() ? "session" : "memory");
	const recall = await call({ action: "recall", scope: "session", query: "amber" });
	assert.deepEqual(recall.details.ids, [sessionId]);
	assert.ok(JSON.stringify(recall.content).length < text.length, "Discovery stays compact; explicit read owns the full note");

	const sourceText = "The qualifier uses the amber fixture during local project review.";
	const source = await call({ action: "remember", term: "short", kind: "note", text: sourceText, source: "fixture A" });
	const inspection = await call({ action: "optimize", target: "project", query: "amber fixture" });
	const replacement = "The local project qualifier uses the verified amber fixture.";
	const staged = await call({ action: "optimize", mode: "stage", target: "project", fingerprint: inspection.details.fingerprint,
		operations: [{ sourceIds: [source.details.id], kind: "note", text: replacement, source: "fixture B" }] });
	assert.match(JSON.stringify(staged.content), /Nothing has been applied/);
	const before = await call({ action: "read", scope: "short", id: source.details.id });
	assert.equal(before.details.entries[0].entry.text, sourceText);
	const applied = await call({ action: "optimize", mode: "apply", planId: staged.details.planId });
	assert.equal(typeof applied.details.receiptId, "string");
	const afterId = staged.details.changes[0].after.id;
	const after = await call({ action: "read", scope: "short", id: afterId });
	assert.equal(after.details.entries[0].entry.text, replacement);
	assert.equal(after.details.entries[0].entry.expiresAt, before.details.entries[0].entry.expiresAt);
	assert.ok(after.details.entries[0].entry.derivedFrom.includes(source.details.id));
	assert.match(after.details.entries[0].entry.source, /fixture A; fixture B/);

	const fresh = await call({ action: "optimize", target: "project", query: "amber fixture" });
	const stale = await call({ action: "optimize", mode: "stage", fingerprint: fresh.details.fingerprint,
		operations: [{ sourceIds: [afterId], kind: "note", text: "The amber fixture revision is ready for another review." }] });
	await call({ action: "remember", term: "short", kind: "note", text: "A concurrent qualifier recorded a separate observation." });
	const refused = await call({ action: "optimize", mode: "apply", planId: stale.details.planId }, false);
	assert.match(refused.details.reason, /changed/);
	const retained = await call({ action: "read", scope: "short", id: afterId });
	assert.equal(retained.details.entries[0].entry.text, replacement);
	const history = await call({ action: "optimize", mode: "history", target: "project" });
	assert.match(JSON.stringify(history.content), new RegExp(applied.details.receiptId));
	await call({ action: "optimize", mode: "undo", target: "project", receiptId: applied.details.receiptId });
	const restored = await call({ action: "read", scope: "short", id: source.details.id });
	assert.equal(restored.details.entries[0].entry.text, sourceText);
	await call({ action: "promote", id: source.details.id });
	const durable = await call({ action: "read", scope: "project", id: source.details.id });
	assert.equal(durable.details.entries[0].target, "project-long");
	assert.equal(durable.details.entries[0].entry.expiresAt, undefined);
	await call({ action: "read", scope: "short", id: source.details.id }, false);
	await call({ action: "forget", id: sessionId });
	await call({ action: "read", id: sessionId }, false);
	return { sessionNotes: true, fullRead: true, explicitOptimization: true, stalePlanRefused: true, expiryAndOriginsPreserved: true, durableProject: true, consolidationUndo: true };
}
