import assert from "node:assert/strict";
import { test } from "node:test";
import { launchMindWorker } from "../src/extension/mind-worker.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function fixture(emit: (request: { respond(value: unknown): void }) => void) {
	return { events: { emit: (_name: string, request: unknown) => emit(request as { respond(value: unknown): void }) } } as Pick<ExtensionAPI, "events">;
}
function worker(cancel: () => void) {
	return { ok: true, runId: "mind-1", model: "current/model", thinking: "high", completion: Promise.resolve({ status: "done", ok: true, output: '{"operations":[]}' }), cancel };
}
test("a single synchronous compatible worker is admitted", () => {
	const accepted = worker(() => {});
	assert.equal(launchMindWorker(fixture((request) => request.respond(accepted)), "session", null, "task"), accepted);
});
test("a missing or ambiguous worker service fails closed and stops every admitted worker", () => {
	assert.equal(launchMindWorker(fixture(() => {}), "session", null, "task").ok, false);
	let cancelled = 0;
	const result = launchMindWorker(fixture((request) => { request.respond(worker(() => { cancelled++; })); request.respond(worker(() => { cancelled++; })); }), "session", null, "task");
	assert.equal(result.ok, false);
	assert.equal(cancelled, 2);
});
test("an admission that throws after accepting cannot leave an orphan worker", () => {
	let cancelled = 0;
	const result = launchMindWorker(fixture((request) => { request.respond(worker(() => { cancelled++; })); throw new Error("broken service"); }), "session", null, "task");
	assert.equal(result.ok, false);
	assert.equal(cancelled, 1);
});
test("a service that responds after the synchronous boundary loses admission and is cancelled", async () => {
	let cancelled = 0;
	const result = launchMindWorker(fixture((request) => { queueMicrotask(() => request.respond(worker(() => { cancelled++; }))); }), "session", null, "task");
	assert.equal(result.ok, false);
	await Promise.resolve();
	assert.equal(cancelled, 1);
});
