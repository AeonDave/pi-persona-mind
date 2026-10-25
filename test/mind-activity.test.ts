import assert from "node:assert/strict";
import { test } from "node:test";

import { MIND_ACTIVITY_EVENT, createMindActivityRunner, type MindActivityEvent } from "../src/extension/activity.ts";

function harness() {
	let ownerCurrent = true;
	let enabled = true;
	const events: Array<{ channel: string; payload: MindActivityEvent }> = [];
	const runner = createMindActivityRunner({
		sessionId: "native-session-1",
		enabled: () => enabled,
		isCurrent: () => ownerCurrent,
		emit: (channel, payload) => events.push({ channel, payload }),
	});
	return { runner, events, revoke: () => { ownerCurrent = false; }, disable: () => { enabled = false; } };
}

test("Mind activity reports inspection start and completion with only the public bounded metadata", async () => {
	const h = harness();
	const result = await h.runner.run("inspect", "persona", async () => ({ ok: true, text: "private memory text", model: "provider/secret" }));
	assert.equal(result.ok, true);
	assert.equal(h.events.length, 2);
	assert.deepEqual(h.events.map((entry) => entry.channel), [MIND_ACTIVITY_EVENT, MIND_ACTIVITY_EVENT]);
	const [start, finish] = h.events.map((entry) => entry.payload);
	assert.deepEqual(Object.keys(start!).sort(), ["activityId", "phase", "producerId", "sessionId", "state", "target", "version"]);
	assert.equal(start?.state, "running");
	assert.equal(finish?.state, "done");
	assert.equal(start?.activityId, finish?.activityId);
	assert.equal(start?.producerId, "pi-persona-mind");
	assert.equal(start?.sessionId, "native-session-1");
	assert.equal(start?.phase, "inspect");
	assert.equal(start?.target, "persona");
	assert.doesNotMatch(JSON.stringify(h.events), /private memory text|provider\/secret/);
});

test("successful staging is labelled staged, while a failed apply is terminal failed", async () => {
	const h = harness();
	await h.runner.run("stage", "project", async () => ({ ok: true }));
	await h.runner.run("apply", "shared", async () => ({ ok: false, reason: "stale" }));
	assert.deepEqual(h.events.map((entry) => [entry.payload.phase, entry.payload.state]), [
		["stage", "running"], ["stage", "staged"],
		["apply", "running"], ["apply", "failed"],
	]);
});

test("revoked owner or missing companion capability suppresses activity without changing the operation", async () => {
	const h = harness();
	let finish!: (value: { ok: true }) => void;
	const pending = h.runner.run("inspect", "project", () => new Promise<{ ok: true }>((resolve) => { finish = resolve; }));
	assert.equal(h.events.length, 1, "the active owner publishes its initial row");
	h.revoke();
	finish({ ok: true });
	await pending;
	assert.equal(h.events.length, 1, "late completion from a revoked owner is suppressed");

	const disabled = harness();
	disabled.disable();
	let ran = false;
	const result = await disabled.runner.run("stage", "project", async () => { ran = true; return { ok: true }; });
	assert.equal(result.ok, true);
	assert.equal(ran, true);
	assert.equal(disabled.events.length, 0, "activity remains an optional public projection; the caller's Persona gate owns access");
});

test("event receiver failures do not change the inspected operation", async () => {
	const runner = createMindActivityRunner({ sessionId: "native-session-1", enabled: () => true, isCurrent: () => true, emit: () => { throw new Error("listener failed"); } });
	assert.deepEqual(await runner.run("inspect", "project", async () => ({ ok: true })), { ok: true });
});
