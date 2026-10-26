import assert from "node:assert/strict";
import { test } from "node:test";

import { parseMindCommand, registerMindCommands } from "../src/extension/mind-command.ts";
import { createMindActivityRunner, type MindActivityEvent } from "../src/extension/activity.ts";

test("mind command parser accepts the snapshot, help, and existing explicit actions", () => {
	assert.deepEqual(parseMindCommand(""), { type: "snapshot" });
	assert.deepEqual(parseMindCommand("help"), { type: "help" });
	assert.deepEqual(parseMindCommand("doctor"), { type: "doctor" });
	assert.deepEqual(parseMindCommand("reset"), { type: "reset" });
	assert.deepEqual(parseMindCommand("reset workspace"), { type: "reset" });
	assert.deepEqual(parseMindCommand("migrate-persona"), { type: "migrate-persona" });
});

test("mind command parser rejects trailing reset arguments instead of resetting anyway", () => {
	assert.equal(parseMindCommand("reset all").type, "invalid");
	assert.equal(parseMindCommand("reset workspace all").type, "invalid");
	const unsupportedReset = parseMindCommand("reset all");
	assert.equal(unsupportedReset.type, "invalid");
	if (unsupportedReset.type === "invalid") assert.match(unsupportedReset.message, /Long-term persona identity is not workspace-scoped/);
	assert.equal(parseMindCommand("migrate-persona now").type, "invalid");
});

test("mind command parser scopes optimize inspection and validates explicit plan commands", () => {
	assert.deepEqual(parseMindCommand("optimize history"), { type: "optimize-history", target: "project" });
	assert.deepEqual(parseMindCommand("optimize inspect shared"), { type: "optimize-inspect", target: "shared" });
	assert.deepEqual(parseMindCommand("optimize history project-long"), { type: "optimize-history", target: "project-long" });
	assert.deepEqual(parseMindCommand("optimize undo receipt-ABC project-long"), { type: "optimize-undo", receiptId: "receipt-ABC", target: "project-long" });
	assert.deepEqual(parseMindCommand("optimize undo receipt-ABC"), { type: "optimize-undo", receiptId: "receipt-ABC", target: "project" });
	assert.equal(parseMindCommand("optimize history unknown").type, "invalid");
	assert.equal(parseMindCommand("optimize undo receipt-ABC project extra").type, "invalid");
	assert.deepEqual(parseMindCommand("optimize"), { type: "optimize-run" });
	assert.deepEqual(parseMindCommand("optimize all"), { type: "optimize-run" });
	assert.deepEqual(parseMindCommand("optimize project-long"), { type: "optimize-run", target: "project-long" });
	assert.deepEqual(parseMindCommand("optimize inspect"), { type: "optimize-inspect", target: "project" });
	assert.deepEqual(parseMindCommand("optimize inspect shared"), { type: "optimize-inspect", target: "shared" });
	assert.deepEqual(parseMindCommand("optimize shared"), { type: "optimize-shared-refused" });
	assert.deepEqual(parseMindCommand("optimize show plan-abc"), { type: "optimize-show", planId: "plan-abc" });
	assert.deepEqual(parseMindCommand("optimize apply plan-abc"), { type: "optimize-apply", planId: "plan-abc" });
	assert.equal(parseMindCommand("optimize apply plan-abc extra").type, "invalid");
	assert.equal(parseMindCommand("optimize unknown").type, "invalid");
});

test("explicit optimize commands start a worker while inspect remains read-only and shared refuses LLM review", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const notices: string[] = [];
	const starts: Array<string | undefined> = [];
	let inspections = 0;
	const optimizer = { inspect: async (target: string) => { inspections++; return { ok: true, target, fingerprint: "fp", entries: [], total: 0, withheld: 0, candidates: [] }; } };
	const pi = { registerCommand: (name: string, definition: { handler: (args: string, ctx: never) => Promise<void> }) => commands.set(name, definition) };
	registerMindCommands(pi as never, {
		agentDir: "unused", resolveScope: () => { throw new Error("run/inspect should use their dedicated seams"); }, rawPersona: () => "reviewer", getMind: () => ({}) as never,
		getSessionMemory: () => ({ captureOwner: () => () => true }) as never,
		getOptimizer: () => optimizer as never,
		ensureLegacyMigrated: async () => {}, migrationStatus: () => "not started", unavailableReason: () => undefined,
		surfaceWarning: () => {}, pendingWarnings: () => [], acknowledgeWarnings: () => {}, capturePolicy: () => "auto",
		isDelegatedLeg: false, isCurrent: () => true, sessionActive: () => true, afterWorkspaceReset: async () => {}, appendResult: () => {},
		autoOptimize: { status: () => "off", setEnabled: () => {}, targets: () => ["project", "project-long", "persona"], startExplicit: (target) => { starts.push(target); return true; } },
	});
	const ctx = { ui: { notify: (message: string) => notices.push(message) } } as never;
	const handler = commands.get("mind")!.handler;
	await handler("optimize", ctx);
	assert.deepEqual(starts, [undefined]);
	assert.match(notices.at(-1) ?? "", /project, project-long, persona.*bounded.*sequentially/i);
	assert.doesNotMatch(notices.at(-1) ?? "", /worker.*started/i);
	assert.equal(inspections, 0, "explicit optimization does not fall through to inspect-only behavior");
	await handler("optimize project-long", ctx);
	assert.deepEqual(starts, [undefined, "project-long"], "a named tier remains a single-target request");
	assert.match(notices.at(-1) ?? "", /Mind project-long review requested/);
	await handler("optimize inspect project-long", ctx);
	assert.equal(inspections, 1);
	await handler("optimize shared", ctx);
	assert.deepEqual(starts, [undefined, "project-long"]);
	assert.match(notices.at(-1) ?? "", /excluded.*inspect shared/i);
});

test("automatic optimization command grammar accepts only status and explicit session switches", () => {
	assert.deepEqual(parseMindCommand("optimize auto"), { type: "optimize-auto", action: "status" });
	for (const action of ["status", "on", "off"] as const) {
		assert.deepEqual(parseMindCommand(`optimize auto ${action}`), { type: "optimize-auto", action });
	}
	assert.equal(parseMindCommand("optimize auto off now").type, "invalid");
	assert.equal(parseMindCommand("optimize auto shared").type, "invalid");
});

test("auto controls change only the current session immediately without joining memory work", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const appended: string[] = [];
	const notices: string[] = [];
	const switches: boolean[] = [];
	let current = true;
	let enabled = true;
	const pi = { registerCommand: (name: string, definition: { handler: (args: string, ctx: never) => Promise<void> }) => commands.set(name, definition) };
	registerMindCommands(pi as never, {
		agentDir: "unused", resolveScope: () => { throw new Error("auto control must not inspect stores"); },
		rawPersona: () => "reviewer", getMind: () => { throw new Error("no storage IO"); },
		getSessionMemory: () => ({ captureOwner: () => () => current }) as never,
		getOptimizer: () => { throw new Error("no optimizer plan needed"); },
		ensureLegacyMigrated: async () => { throw new Error("do not await migration"); }, migrationStatus: () => "not started", unavailableReason: () => undefined,
		surfaceWarning: () => {}, pendingWarnings: () => [], acknowledgeWarnings: () => {}, capturePolicy: () => "auto",
		isDelegatedLeg: false, isCurrent: () => current, sessionActive: () => true, afterWorkspaceReset: async () => {},
		appendResult: (_ctx, _title, body) => appended.push(body),
		autoOptimize: { status: () => enabled ? "on · idle" : "off · cancelled", setEnabled: (value) => { switches.push(value); enabled = value; } },
	});
	const handler = commands.get("mind")!.handler;
	const ctx = { ui: { notify: (message: string) => notices.push(message) } } as never;
	await handler("optimize auto", ctx);
	assert.deepEqual(switches, []);
	assert.match(appended.at(-1) ?? "", /on · idle/);
	await handler("optimize auto off", ctx);
	assert.deepEqual(switches, [false]);
	assert.match(appended.at(-1) ?? "", /off · cancelled/);
	await handler("optimize auto on", ctx);
	assert.deepEqual(switches, [false, true]);
	current = false;
	await handler("optimize auto off", ctx);
	assert.deepEqual(switches, [false, true], "an old native owner cannot change the new session's policy");
	assert.match(notices.at(-1) ?? "", /owner|session/i);
});

test("mind commands register one shared alias handler and reject trailing destructive arguments", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const notices: string[] = [];
	let resetCalls = 0;
	const optimizer = { inspect: async () => ({ ok: true }), getPlan: () => ({ ok: false, reason: "missing" }), apply: async () => ({ ok: true }) };
	const pi = { registerCommand: (name: string, definition: { handler: (args: string, ctx: never) => Promise<void> }) => commands.set(name, definition) };
	registerMindCommands(pi as never, {
		agentDir: "C:\\temp\\mind",
		resolveScope: () => ({ persona: "reviewer", projectRoot: "C:\\work", slug: "work", paths: { projectLtm: "project-ltm", ltm: "ltm", shared: "shared", stm: "stm", backlog: "backlog" } }),
		rawPersona: () => "reviewer",
		getMind: () => ({ resetWorkspace: async () => { resetCalls++; return { ok: true, stmRemoved: 1, backlogRemoved: 2, ltmKept: 3 }; } }) as never,
		getSessionMemory: () => ({ isCurrent: () => true, captureOwner: () => () => true, snapshot: () => ({ ok: true, storage: "memory", notes: [] }) }) as never,
		getOptimizer: () => optimizer as never, unavailableReason: () => undefined,
		ensureLegacyMigrated: async () => {}, migrationStatus: () => "not started", surfaceWarning: () => {}, pendingWarnings: () => [], acknowledgeWarnings: () => {},
		capturePolicy: () => "auto", isDelegatedLeg: false, isCurrent: () => true, sessionActive: () => false, afterWorkspaceReset: async () => {}, appendResult: () => {},
	});
	assert.equal(commands.get("mind")?.handler, commands.get("persona-mind")?.handler);
	const ctx = { ui: { notify: (message: string) => notices.push(message) } } as never;
	await commands.get("mind")!.handler("reset workspace all", ctx);
	assert.equal(resetCalls, 0);
	assert.match(notices[0] ?? "", /reset only.*long-term persona identity is not workspace-scoped/i);
});

test("mind optimize command inspects and applies only an explicitly named staged plan", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const appended: Array<{ title: string; body: string }> = [];
	let inspected = 0;
	let applied = 0;
	const events: MindActivityEvent[] = [];
	const activity = createMindActivityRunner({ sessionId: "native-session", enabled: () => true, isCurrent: () => true, emit: (_channel, payload) => events.push(payload) });
	const optimizer = {
		inspect: async (target: string) => { inspected++; return { ok: true, target, fingerprint: "fp-1", entries: [], total: 0, withheld: 0, candidates: [] }; },
		history: async (target: string) => ({ ok: true, target, receipts: [], retained: 0, omitted: 0, limit: 32, maxBytes: 2097152, withheldUnsafe: 0 }),
		undo: async (receiptId: string, target: string) => ({ ok: true, receiptId, target, restored: 2 }),
		getPlan: (planId: string) => ({ ok: true, planId, target: "project", fingerprint: "fp-1", expiresAt: "later", changes: [], beforeCount: 0, afterCount: 0 }),
		apply: async (planId: string) => { applied++; return { ok: true, planId, target: "project", changed: 1, beforeCount: 2, afterCount: 1 }; },
	};
	const pi = { registerCommand: (name: string, definition: { handler: (args: string, ctx: never) => Promise<void> }) => commands.set(name, definition) };
	registerMindCommands(pi as never, {
		agentDir: "C:\\temp\\mind", resolveScope: () => ({ persona: "reviewer", projectRoot: "C:\\work", slug: "work", paths: { projectLtm: "project-ltm", ltm: "ltm", shared: "shared", stm: "stm", backlog: "backlog" } }),
		rawPersona: () => "reviewer", getMind: () => ({}) as never,
		getSessionMemory: () => ({ isCurrent: () => true, captureOwner: () => () => true }) as never, getOptimizer: () => optimizer as never, activity: () => activity,
		unavailableReason: () => undefined,
		ensureLegacyMigrated: async () => {}, migrationStatus: () => "not started", surfaceWarning: () => {}, pendingWarnings: () => [], acknowledgeWarnings: () => {}, capturePolicy: () => "auto",
		isDelegatedLeg: false, isCurrent: () => true, sessionActive: () => false, afterWorkspaceReset: async () => {}, appendResult: (_ctx, title, body) => appended.push({ title, body }),
	});
	const ctx = { ui: { notify: () => {} } } as never;
	const handler = commands.get("persona-mind")!.handler;
	await handler("optimize inspect shared", ctx);
	assert.equal(inspected, 1);
	assert.equal(applied, 0);
	assert.match(appended.at(-1)?.body ?? "", /No changes were applied/);
	await handler("optimize show plan-1", ctx);
	assert.match(appended.at(-1)?.body ?? "", /Staged plan plan-1/);
	await handler("optimize apply plan-1", ctx);
	assert.equal(applied, 1);
	assert.match(appended.at(-1)?.body ?? "", /Applied staged memory plan plan-1/);
	await handler("optimize history project-long", ctx);
	assert.match(appended.at(-1)?.body ?? "", /history \(project-long\)/);
	await handler("optimize undo receipt-1 project-long", ctx);
	assert.match(appended.at(-1)?.body ?? "", /restored 2 original fact/);
	assert.deepEqual(events.map((event) => [event.phase, event.state, event.target]), [
		["inspect", "running", "shared"], ["inspect", "done", "shared"],
		["apply", "running", "project"], ["apply", "done", "project"],
		["inspect", "running", "project-long"], ["inspect", "done", "project-long"],
		["apply", "running", "project-long"], ["apply", "done", "project-long"],
	]);
});

test("snapshot drops a result when the active owner changes while its store reads are pending", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const appended: string[] = [];
	let generation = 0;
	let resolveSummary!: (value: { ltm: number; stm: number; backlogOpen: number }) => void;
	let resolveInjection!: (value: string) => void;
	const summary = new Promise<{ ltm: number; stm: number; backlogOpen: number }>((resolve) => { resolveSummary = resolve; });
	const injection = new Promise<string>((resolve) => { resolveInjection = resolve; });
	const pi = { registerCommand: (name: string, definition: { handler: (args: string, ctx: never) => Promise<void> }) => commands.set(name, definition) };
	registerMindCommands(pi as never, {
		agentDir: "C:\\temp\\mind", resolveScope: () => ({ persona: "reviewer", projectRoot: "C:\\work", slug: "work", paths: { projectLtm: "project-ltm", ltm: "ltm", shared: "shared", stm: "stm", backlog: "backlog" } }),
		rawPersona: () => "reviewer", getMind: () => ({ summary: () => summary, buildInjection: () => injection }) as never,
		getSessionMemory: () => ({
			isCurrent: () => true,
			captureOwner: () => { const captured = generation; return () => generation === captured; },
		}) as never,
		getOptimizer: () => ({}) as never, ensureLegacyMigrated: async () => {}, migrationStatus: () => "not started", unavailableReason: () => undefined, surfaceWarning: () => {}, pendingWarnings: () => [], acknowledgeWarnings: () => {}, capturePolicy: () => "auto",
		isDelegatedLeg: false, isCurrent: () => true, sessionActive: () => false, afterWorkspaceReset: async () => {}, appendResult: (_ctx, _title, body) => appended.push(body),
	});
	const ctx = { ui: { notify: () => {} } } as never;
	const pending = commands.get("persona-mind")!.handler("", ctx);
	generation++;
	resolveSummary({ ltm: 1, stm: 0, backlogOpen: 0 });
	resolveInjection("private old-owner fact");
	await pending;
	assert.deepEqual(appended, []);
});

test("doctor reports background migration status without joining its completion", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const appended: string[] = [];
	const migrationArgs: Array<[boolean | undefined, boolean | undefined]> = [];
	const pi = { registerCommand: (name: string, definition: { handler: (args: string, ctx: never) => Promise<void> }) => commands.set(name, definition) };
	registerMindCommands(pi as never, {
		agentDir: "C:\\temp\\mind", resolveScope: () => ({ persona: "reviewer", projectRoot: "C:\\work", slug: "work", paths: { projectLtm: "project-ltm", ltm: "C:\\missing\\ltm.json", shared: "C:\\missing\\shared.json", stm: "C:\\missing\\stm.json", backlog: "C:\\missing\\backlog.json" } }),
		rawPersona: () => "reviewer", getMind: () => ({}) as never,
		getSessionMemory: () => ({ isCurrent: () => true, captureOwner: () => () => true }) as never, getOptimizer: () => ({}) as never,
		ensureLegacyMigrated: async (_ctx, includeAmbiguous, awaitCompletion) => { migrationArgs.push([includeAmbiguous, awaitCompletion]); },
		migrationStatus: () => "running in background; existing stores remain available; older imported entries may appear later",
		autoOptimize: { status: () => "on · waiting for idle · 1 pending", setEnabled: () => {} },
		surfaceWarning: () => {}, pendingWarnings: () => [], acknowledgeWarnings: () => {}, capturePolicy: () => "auto",
		isDelegatedLeg: false, isCurrent: () => true, unavailableReason: () => undefined, sessionActive: () => false, afterWorkspaceReset: async () => {}, appendResult: (_ctx, _title, body) => appended.push(body),
	});
	await commands.get("persona-mind")!.handler("doctor", { cwd: "C:\\work", ui: { notify: () => {} } } as never);
	assert.deepEqual(migrationArgs, [[undefined, undefined]], "doctor uses bounded background migration rather than waiting for the whole import");
	assert.match(appended[0] ?? "", /migration: running in background; existing stores remain available/);
	assert.match(appended[0] ?? "", /automatic optimization: on · waiting for idle · 1 pending/);
});

test("mind commands are disabled without a compatible Persona while help stays available", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const notices: string[] = [];
	const appended: string[] = [];
	let migrationCalls = 0;
	const pi = { registerCommand: (name: string, definition: { handler: (args: string, ctx: never) => Promise<void> }) => commands.set(name, definition) };
	registerMindCommands(pi as never, {
		agentDir: "C:\\temp\\mind", resolveScope: () => ({ persona: "reviewer", projectRoot: "C:\\work", slug: "work", paths: { projectLtm: "project-ltm", ltm: "ltm", shared: "shared", stm: "stm", backlog: "backlog" } }),
		rawPersona: () => "reviewer", getMind: () => ({}) as never,
		getSessionMemory: () => ({ isCurrent: () => true, captureOwner: () => () => true }) as never,
		getOptimizer: () => ({}) as never, ensureLegacyMigrated: async () => { migrationCalls++; }, migrationStatus: () => "not started",
		unavailableReason: () => "Mind requires a loaded compatible Persona supervisor.",
		surfaceWarning: () => {}, pendingWarnings: () => [], acknowledgeWarnings: () => {}, capturePolicy: () => "auto",
		isDelegatedLeg: false, isCurrent: () => true, sessionActive: () => false, afterWorkspaceReset: async () => {}, appendResult: (_ctx, _title, body) => appended.push(body),
	});
	const ctx = { ui: { notify: (message: string) => notices.push(message) } } as never;
	const handler = commands.get("persona-mind")!.handler;
	await handler("doctor", ctx);
	assert.deepEqual(notices, ["Mind requires a loaded compatible Persona supervisor."]);
	assert.equal(migrationCalls, 0, "blocked commands do not inspect or migrate Mind stores");
	await handler("help", ctx);
	assert.equal(appended.length, 1, "help is safe and remains available without Persona");
});
