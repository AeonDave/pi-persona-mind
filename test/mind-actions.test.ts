import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runMindInspectorActions } from "../src/extension/mind-actions.ts";

function fixture(choice: string, approved = true) {
	const calls: unknown[] = [];
	let current = true;
	const ctx = { mode: "tui", ui: { select: async (_title: string, choices: string[]) => { calls.push(choices); return choice; }, confirm: async () => approved, notify: (message: string) => calls.push(message) } } as unknown as ExtensionContext;
	const deps = { consolidate: (target: string) => { calls.push(["consolidate", target]); return true; }, review: {
		start: async (_ctx: unknown, target: string, id?: string) => { calls.push(["review", target, id]); }, show: async () => { calls.push("show"); }, apply: async () => { calls.push("apply"); }, discard: () => { calls.push("discard"); },
	} };
	return { calls, ctx, deps: deps as never, current: () => current, revoke: () => { current = false; } };
}
const request = { tab: "memories", scope: "project-long", query: "", offset: 0, selectedId: "memory-id" } as const;
test("F10 consolidation is explicit, confirmed and target qualified", async () => {
	const f = fixture("Consolidate this scope (bounded window)");
	await runMindInspectorActions(f.ctx, request, f.current, f.deps);
	assert.ok(f.calls.some((value) => JSON.stringify(value) === '["consolidate","project-long"]'));
	const declined = fixture("Consolidate this scope (bounded window)", false);
	await runMindInspectorActions(declined.ctx, request, declined.current, declined.deps);
	assert.equal(declined.calls.some((value) => Array.isArray(value) && value[0] === "consolidate"), false);
});
test("F10 selected knowledge review carries exact record identity, not its label", async () => {
	const f = fixture("Review selected fact against evidence");
	await runMindInspectorActions(f.ctx, request, f.current, f.deps);
	assert.ok(f.calls.some((value) => JSON.stringify(value) === '["review","project-long","memory-id"]'));
});
test("shared/session actions offer no model-driven scope mutation; stale actions do nothing", async () => {
	const f = fixture("Review this scope against evidence (bounded window)");
	await runMindInspectorActions(f.ctx, { ...request, scope: "shared" }, f.current, f.deps);
	assert.equal(f.calls.some((value) => Array.isArray(value) && value[0] === "review"), false);
	assert.equal((f.calls[0] as string[]).some((value) => value.startsWith("Consolidate")), false);
	const g = fixture("Consolidate this scope (bounded window)"); g.revoke();
	await runMindInspectorActions(g.ctx, request, g.current, g.deps); assert.deepEqual(g.calls, []);
});
