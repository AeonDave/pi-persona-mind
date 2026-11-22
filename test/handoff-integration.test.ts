import { test } from "node:test";
import assert from "node:assert/strict";
import { validateHandoffInput } from "../src/tools/memory-handoff.ts";
import { parseMindCommand } from "../src/extension/mind-command.ts";
import { registerMemoryTool } from "../src/tools/memory.ts";
import { runHandoff } from "../src/extension/handoff.ts";
import { resolveScope } from "../src/core/scope.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore } from "../src/core/store.ts";
import { HandoffStore } from "../src/core/handoff-store.ts";

test("handoff requests reject malformed or extraneous fields before storage", () => {
	assert.equal(validateHandoffInput({ operation: "list", extra: true }), false);
	assert.equal(validateHandoffInput({ operation: "complete", id: "a".repeat(32), revision: 0, resolution: "Done" }), false);
	assert.equal(validateHandoffInput({ operation: "save", goal: "Goal", completed: [], pending: [], nextStep: "Next", references: [] }), true);
});

test("handoff command keeps resolution text and requires explicit revision", () => {
	assert.deepEqual(parseMindCommand(`/mind handoff`), { type: "invalid", message: expectUsage() });
	assert.deepEqual(parseMindCommand(`handoff complete ${"a".repeat(32)} 1 Tests Pass`), { type: "handoff", input: { operation: "complete", id: "a".repeat(32), revision: 1, resolution: "Tests Pass" } });
	assert.equal(parseMindCommand(`handoff forget ${"a".repeat(32)}`).type, "invalid");
});

function expectUsage(): string { return (parseMindCommand("unknown") as { message: string }).message; }

test("registered tool uses explicit handoff, fences full snapshot, and refuses invalid payload before access", async () => {
	const dir = await mkdtemp(join(tmpdir(), "handoff-tool-"));
	try {
		const scope = resolveScope(dir, dir, { persona: "alice", homedir: join(dir, "home") });
		let leaf: string | null = null;
		const ctx = { cwd: dir, sessionManager: { getLeafId: () => leaf, getSessionId: () => "native-session" } };
		let calls = 0;
		let tool: { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> } | undefined;
		registerMemoryTool({ registerTool: (value: typeof tool) => { tool = value; } } as never, (() => { throw new Error("unexpected memory access"); }) as never, undefined, undefined, undefined, async (_ctx, input) => { calls++; return runHandoff(ctx as never, scope, () => true, input); });
		assert.ok(tool);
		const execute = (handoff: unknown) => tool!.execute("id", { action: "handoff", handoff }, undefined, undefined, ctx);
		assert.equal((await execute({ operation: "list", extra: true })).details.ok, false);
		assert.equal(calls, 0);
		const saved = await execute({ operation: "save", goal: "Finish", completed: [], pending: ["Review"], nextStep: "Inspect <files>", references: ["src/a.ts"] });
		assert.equal(saved.details.ok, true);
		assert.match(saved.content[0]!.text, /\\u003cfiles\\u003e/);
		assert.match(saved.content[0]!.text, /"branchId": null/);
		leaf = "branch-b";
		const listed = await execute({ operation: "list" });
		assert.match(listed.content[0]!.text, /Finish/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("ordinary session appends during handoff IO preserve the captured owner and source branch", async () => {
	const dir = await mkdtemp(join(tmpdir(), "handoff-append-"));
	const inspect = JsonStore.prototype.inspectStrict;
	try {
		const scope = resolveScope(dir, dir, { persona: "alice", homedir: join(dir, "home") });
		let leaf = "accepted-leaf";
		const ctx = { cwd: dir, sessionManager: { getLeafId: () => leaf, getSessionId: () => "session" } };
		JsonStore.prototype.inspectStrict = async function () {
			const result = await inspect.call(this);
			if (this.filePath === `${scope.paths.stm}.handoffs.json`) leaf = "ordinary-appended-entry";
			return result;
		};
		const result = await runHandoff(ctx as never, scope, () => true, { operation: "save", goal: "Finish", completed: [], pending: [], nextStep: "Review", references: [] });
		assert.ok(result.ok && result.operation === "save");
		assert.equal(result.entry.origin.branchId, "accepted-leaf");
	} finally { JsonStore.prototype.inspectStrict = inspect; await rm(dir, { recursive: true, force: true }); }
});

test("handoff owner revocation before CAS refuses mutation and late read delivery is withheld", async () => {
	const dir = await mkdtemp(join(tmpdir(), "handoff-revoked-"));
	const compare = JsonStore.prototype.compareAndUpdate;
	const execute = HandoffStore.prototype.execute;
	try {
		const scope = resolveScope(dir, dir, { persona: "alice", homedir: join(dir, "home") });
		let active = true;
		const ctx = { cwd: dir, sessionManager: { getLeafId: () => "leaf", getSessionId: () => "session" } };
		JsonStore.prototype.compareAndUpdate = async function (fingerprint, mutate) { active = false; return compare.call(this, fingerprint, mutate); };
		const refused = await runHandoff(ctx as never, scope, () => active, { operation: "save", goal: "Finish", completed: [], pending: [], nextStep: "Review", references: [] });
		assert.equal(refused.ok, false);
		JsonStore.prototype.compareAndUpdate = compare;
		active = true;
		const empty = await runHandoff(ctx as never, scope, () => active, { operation: "list" });
		assert.ok(empty.ok && empty.operation === "list"); assert.deepEqual(empty.entries, []);
		HandoffStore.prototype.execute = async function (context, input) { const result = await execute.call(this, context, input); active = false; return result; };
		const withheld = await runHandoff(ctx as never, scope, () => active, { operation: "list" });
		assert.ok(!withheld.ok); assert.match(withheld.reason, /snapshot withheld/); assert.doesNotMatch(withheld.reason, /committed/);
		active = true;
		const committed = await runHandoff(ctx as never, scope, () => active, { operation: "save", goal: "Completed in the original scope", completed: [], pending: [], nextStep: "Review", references: [] });
		assert.ok(!committed.ok); assert.match(committed.reason, /save committed in the original scope/);
	} finally { JsonStore.prototype.compareAndUpdate = compare; HandoffStore.prototype.execute = execute; await rm(dir, { recursive: true, force: true }); }
});
