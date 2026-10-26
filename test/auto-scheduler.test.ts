import test from "node:test";
import assert from "node:assert/strict";
import { AutoOptimizeScheduler, AUTO_COOLDOWN_MS, AUTO_INPUT_TOKEN_THRESHOLD, type AutoAttempt, type AutoOptimizeOwner } from "../src/extension/auto-optimize.ts";
import { autoOptimizeTarget } from "../src/extension/auto-optimize-session.ts";
import type { AutoOptimizeTarget } from "../src/core/auto-optimize.ts";
import type { MindWorkerResult } from "../src/extension/mind-worker.ts";
import { makeMemory, type MemoryEntry } from "../src/core/memory.ts";
import type { OptimizeInspection, OptimizeTarget } from "../src/core/optimize.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}

function fixture(options: {
	inspectGate?: Promise<void>;
	inspectFailsAfterGate?: boolean;
	previewGate?: Promise<void>;
	wrongInspectTarget?: boolean;
	applyWarning?: string;
	previewThrows?: boolean;
	applyThrows?: boolean;
	latestSnapshotMismatch?: boolean;
	allowedTargets?: readonly AutoOptimizeTarget[];
	entriesByTarget?: Partial<Record<AutoOptimizeTarget, MemoryEntry[]>>;
	recordAttempt?: (attempt: AutoAttempt) => void;
	initialAttempts?: AutoAttempt[];
	cancelCompletes?: boolean;
} = {}) {
	let now = 1_000_000;
	let idle = true;
	let current = true;
	const timers: Array<{ work: () => void; delay: number }> = [];
	const events: string[] = [];
	const reports: Array<{ title: string; body: string }> = [];
	const entriesByTarget: Record<AutoOptimizeTarget, MemoryEntry[]> = {
		project: [
			makeMemory({ term: "short", kind: "convention", text: "Project style uses concise sentences.", tags: ["style"], source: "project session one", persona: "dev" }, now),
			makeMemory({ term: "short", kind: "convention", text: "Project style uses concise sentences and explicit examples.", tags: ["writing"], source: "project session two", persona: "dev" }, now + 1),
		],
		"project-long": [
			makeMemory({ term: "long", kind: "convention", text: "Project release history stays durable.", tags: ["release"], source: "project repository one", persona: "dev" }, now),
			makeMemory({ term: "long", kind: "convention", text: "Durable project release notes retain verified context.", tags: ["release"], source: "project repository two", persona: "dev" }, now + 1),
		],
		persona: [
			makeMemory({ term: "long", kind: "convention", text: "Persona prefers concise sentences.", tags: ["style"], source: "persona profile one", persona: "dev" }, now),
			makeMemory({ term: "long", kind: "convention", text: "Persona prefers concise sentences and explicit examples.", tags: ["writing"], source: "persona profile two", persona: "dev" }, now + 1),
		],
	};
	for (const target of Object.keys(options.entriesByTarget ?? {}) as AutoOptimizeTarget[]) entriesByTarget[target] = options.entriesByTarget![target]!;
	const attempts = [...(options.initialAttempts ?? [])];
	let finish: ((value: MindWorkerResult) => void) | undefined;
	let launches = 0;
	let applied = 0;
	const inspected: OptimizeTarget[] = [];
	const inspectCalls: Array<{ target: OptimizeTarget; offset: number; max: number }> = [];
	const tasks: string[] = [];
	let plan: { target: OptimizeTarget; before: MemoryEntry[]; after: MemoryEntry } | undefined;
	const optimizer = {
		inspect: async (target: OptimizeTarget, inspectOptions: { max?: number; offset?: number } = {}): Promise<OptimizeInspection> => {
			inspected.push(target);
			if (options.inspectGate && inspected.length === 1) await options.inspectGate;
			if (options.inspectFailsAfterGate && inspected.length === 1) throw new Error("inspection interrupted");
			const actualTarget = options.wrongInspectTarget ? target === "persona" ? "project" : "persona" : target;
			const all = actualTarget === "shared" ? [] : entriesByTarget[actualTarget];
			const offset = inspectOptions.offset ?? 0;
			const max = inspectOptions.max ?? 100;
			inspectCalls.push({ target, offset, max });
			const entries = [...all].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || a.id.localeCompare(b.id)).slice(offset, offset + max);
			const nextOffset = offset + entries.length;
			const fingerprint = options.latestSnapshotMismatch && offset === 0 && inspectCalls.length > 1 ? `changed:${actualTarget}` : `snapshot:${actualTarget}`;
			return { ok: true, target: actualTarget, fingerprint, entries, total: all.length, withheld: 0, candidates: [], offset, matched: all.length, ...(nextOffset < all.length ? { nextOffset } : {}) };
		},
		preview: async ({ target, operations }: { target?: OptimizeTarget; fingerprint: string; operations: Array<{ sourceIds: string[]; kind: MemoryEntry["kind"]; text: string }> }) => {
			events.push("preview");
			if (options.previewGate) await options.previewGate;
			if (options.previewThrows) throw new Error("preview rejected");
			assert.ok(target === "project" || target === "project-long" || target === "persona");
			const before = entriesByTarget[target].filter((entry) => operations[0]!.sourceIds.includes(entry.id));
			const after = makeMemory({ term: target === "project" ? "short" : "long", kind: operations[0]!.kind, text: operations[0]!.text, tags: before.flatMap((entry) => entry.tags), persona: "dev" }, now + 2);
			after.source = before.map((entry) => entry.source).filter(Boolean).join("; ");
			after.derivedFrom = before.map((entry) => entry.id);
			if (target === "project" && before[0]!.expiresAt !== undefined) after.expiresAt = before[0]!.expiresAt;
			plan = { target, before, after };
			return { ok: true as const, planId: "plan", target, fingerprint: `snapshot:${target}`, expiresAt: new Date(now + 10_000).toISOString(), changes: [{ before, after }], beforeCount: entriesByTarget[target].length, afterCount: entriesByTarget[target].length - before.length + 1 };
		},
		apply: async () => {
			events.push("apply"); applied++;
			if (options.applyThrows) throw new Error("apply rejected after possible commit");
			return { ok: true as const, planId: "plan", target: plan?.target ?? "persona", changed: 1, beforeCount: 2, afterCount: 1, receiptId: "auto-receipt", ...(options.applyWarning ? { warning: options.applyWarning } : {}) };
		},
		invalidate: () => { events.push("invalidate"); },
	};
	const owner: AutoOptimizeOwner = {
		key: "owner", persona: "dev", allowedTargets: options.allowedTargets ?? ["project", "project-long", "persona"], current: () => current, idle: () => idle,
		optimizer: () => optimizer,
		launch: (task) => {
			launches++;
			tasks.push(task);
			return { ok: true, runId: "run", model: "provider/current", thinking: "high", completion: new Promise((resolve) => { finish = resolve; }), cancel: () => { events.push("cancel"); if (options.cancelCompletes !== false) finish?.({ ok: false, output: "", status: "stopped", error: "Mind worker cancelled" }); } };
		},
		report: (title, body) => { events.push(`report:${title}`); reports.push({ title, body }); },
		recordAttempt: (attempt) => { options.recordAttempt?.(attempt); attempts.push(attempt); events.push("recordAttempt"); },
		attempts,
	};
	const scheduler = new AutoOptimizeScheduler({ now: () => now, schedule: (work, delay) => {
		const timer = { work, delay }; timers.push(timer);
		return () => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); };
	} });
	scheduler.activate(owner);
	return {
		scheduler, owner, entries: entriesByTarget.persona, entriesByTarget, events, reports, attempts, inspected, inspectCalls, tasks,
		setIdle: (v: boolean) => { idle = v; }, revoke: () => { current = false; }, advance: (ms = AUTO_COOLDOWN_MS + 1) => { now += ms; },
		launches: () => launches, applied: () => applied, delays: () => timers.map((timer) => timer.delay), takeTimerWork: () => timers[0]?.work,
		fire: async () => { timers.shift()?.work(); for (let i = 0; i < 12; i++) await Promise.resolve(); },
		finish: (output: string | MindWorkerResult) => finish?.(typeof output === "string" ? { ok: true, output, status: "done" } : output), pending: () => timers.length,
	};
}

test("memory scope selects STM, durable project LTM, persona LTM, and excludes shared LTM", () => {
	assert.equal(autoOptimizeTarget({ action: "remember", term: "short" }), "project");
	assert.equal(autoOptimizeTarget({ action: "remember", term: "long", scope: "project" }), "project-long");
	assert.equal(autoOptimizeTarget({ action: "remember", term: "long" }), "persona");
	assert.equal(autoOptimizeTarget({ action: "remember", term: "long", scope: "persona" }), "persona");
	assert.equal(autoOptimizeTarget({ action: "remember", term: "long", scope: "shared" }), undefined);
	assert.equal(autoOptimizeTarget({ action: "promote" }), "project-long");
	assert.equal(autoOptimizeTarget({ action: "promote", scope: "persona" }), "persona");
	assert.equal(autoOptimizeTarget({ action: "promote", scope: "shared" }), undefined);
});

test("explicit review bypasses automatic off, token and cooldown gates but requires an idle owner", async () => {
	const f = fixture();
	f.scheduler.setEnabled(false); f.setIdle(false);
	assert.equal(f.scheduler.startExplicit("persona"), false, "manual review must not start while the session is busy");
	f.setIdle(true);
	assert.equal(f.scheduler.startExplicit("persona"), true);
	assert.equal(f.scheduler.startExplicit("project"), false, "the instance never overlaps workers");
	for (let index = 0; index < 8; index++) await Promise.resolve();
	assert.equal(f.launches(), 1);
	f.finish(JSON.stringify({ operations: [{ sourceIds: f.entries.map((entry) => entry.id), kind: "convention", text: "Persona keeps concise explicit memory." }] }));
	await f.scheduler.join();
	assert.equal(f.applied(), 1, "valid worker output follows the existing preview/apply pipeline even while auto is off");
	assert.equal(f.attempts.length, 0, "manual work does not create automatic retry receipts");
	assert.match(f.reports.find((report) => report.title === "Mind optimization result")?.body ?? "", /Undo: \/mind optimize undo auto-receipt persona/, "the ordinary result preserves the durable undo receipt reference");
	assert.match(f.reports.at(-1)?.body ?? "", /Bounded coverage: one selected record window/);
	assert.match(f.reports.find((report) => report.title === "Mind optimization proposal")?.body ?? "", /Staged proposed change/);
	assert.doesNotMatch(f.reports.find((report) => report.title === "Mind optimization proposal")?.body ?? "", /Staged automatic/);
	assert.ok(f.events.indexOf("report:Mind optimization proposal") < f.events.indexOf("apply"));
});

test("explicit work cancels queued auto timers and join retains the active worker promise", async () => {
	const f = fixture();
	f.scheduler.memoryAdded("project"); f.scheduler.settled();
	const queued = f.takeTimerWork();
	assert.equal(f.scheduler.startExplicit("persona"), true);
	queued?.(); // Simulate a timer callback already queued when cancellation ran.
	for (let index = 0; index < 8; index++) await Promise.resolve();
	let joined = false;
	const join = f.scheduler.join().then(() => { joined = true; });
	await Promise.resolve();
	assert.equal(joined, false, "a stale timer callback must not overwrite the active work promise");
	assert.equal(f.launches(), 1, "the stale callback must not admit a competing auto pass");
	f.finish('{"operations":[]}'); await join;
	assert.equal(joined, true);
	assert.equal(f.pending(), 1, "accepted explicit work preserves independently pending automatic work");
	assert.deepEqual(f.delays(), [2_000], "the preserved automatic pass is rescheduled through its normal idle delay");
});

test("explicit unexpected preview/apply failures append cautious owner-current terminal reports", async () => {
	for (const failure of ["previewThrows", "applyThrows"] as const) {
		const f = fixture({ [failure]: true });
		assert.equal(f.scheduler.startExplicit("persona"), true);
		for (let index = 0; index < 8; index++) await Promise.resolve();
		f.finish(JSON.stringify({ operations: [{ sourceIds: f.entries.map((entry) => entry.id), kind: "convention", text: "A validated replacement proposal." }] }));
		await f.scheduler.join();
		const terminal = f.reports.at(-1)?.body ?? "";
		assert.match(terminal, /failed unexpectedly/);
		assert.match(terminal, /inspect current memory before retrying/);
		assert.doesNotMatch(terminal, /memory unchanged/i, "a thrown apply may have committed before rejecting");
	}
});

test("explicit older-page snapshot mismatch reports a terminal result", async () => {
	const entries = Array.from({ length: 100 }, (_, index) => makeMemory({ term: "long", kind: "note", text: `Foreign row ${index}`, persona: "other" }, 2_000_000 - index));
	entries.push(makeMemory({ term: "long", kind: "note", text: "Owned row on older page", persona: "dev" }, 1_000_000));
	const f = fixture({ allowedTargets: ["persona"], entriesByTarget: { persona: entries }, latestSnapshotMismatch: true });
	f.scheduler.startExplicit("persona"); await f.scheduler.join();
	f.scheduler.startExplicit("persona"); await f.scheduler.join();
	assert.match(f.reports.at(-1)?.body ?? "", /store changed during bounded inspection/);
	assert.doesNotMatch(f.reports.at(-1)?.body ?? "", /waiting for the next settled event/);
});

test("explicit cancellation or owner change suppresses late apply and report without automatic retry", async () => {
	const f = fixture({ cancelCompletes: false });
	assert.equal(f.scheduler.startExplicit("persona"), true);
	for (let index = 0; index < 8; index++) await Promise.resolve();
	f.scheduler.interrupt();
	f.finish(JSON.stringify({ operations: [{ sourceIds: f.entries.map((entry) => entry.id), kind: "convention", text: "Late proposal must not apply." }] }));
	await f.scheduler.join();
	assert.equal(f.applied(), 0);
	assert.deepEqual(f.reports, []);
	assert.equal(f.attempts.length, 0);

	const stale = fixture();
	assert.equal(stale.scheduler.startExplicit("persona"), true);
	for (let index = 0; index < 8; index++) await Promise.resolve();
	stale.revoke();
	stale.finish('{"operations":[]}');
	await stale.scheduler.join();
	assert.equal(stale.applied(), 0);
	assert.deepEqual(stale.reports, []);
});

test("twenty rapid memory writes coalesce into one first review; a settled digest is not reprocessed", async () => {
	const f = fixture(); for (let index = 0; index < 20; index++) f.scheduler.memoryAdded("persona");
	assert.equal(f.pending(), 0); f.scheduler.settled(); f.scheduler.settled(); assert.equal(f.pending(), 1);
	await f.fire(); assert.equal(f.launches(), 1); f.finish('{"operations":[]}'); await f.scheduler.join();
	f.advance(); f.scheduler.memoryAdded("persona"); f.scheduler.tokensUsed(AUTO_INPUT_TOKEN_THRESHOLD); f.scheduler.settled(); await f.fire(); await f.scheduler.join();
	assert.equal(f.launches(), 1); assert.equal(f.applied(), 0);
});

test("successive explicit no-op reviews rotate windows, while cancellation does not advance", async () => {
	const entries = Array.from({ length: 235 }, (_, index) => makeMemory({ term: "long", kind: "note", text: `Owned record ${index} has enough distinct content for bounded review.`, persona: "dev" }, 2_000_000 - index));
	const f = fixture({ allowedTargets: ["persona"], entriesByTarget: { persona: entries } });
	f.scheduler.startExplicit("persona");
	for (let i = 0; i < 8; i++) await Promise.resolve();
	f.finish('{"operations":[]}'); await f.scheduler.join();
	assert.equal(f.inspectCalls[0]?.offset, 0);
	const firstWindow = JSON.parse(f.tasks[0]!.split("\n").at(-1)!) as { entries: MemoryEntry[] };
	f.scheduler.startExplicit("persona");
	for (let i = 0; i < 8; i++) await Promise.resolve();
	assert.equal(f.inspectCalls.at(-1)?.offset, 0);
	const secondWindow = JSON.parse(f.tasks.at(-1)!.split("\n").at(-1)!) as { entries: MemoryEntry[] };
	assert.notDeepEqual(secondWindow.entries.map((entry) => entry.id), firstWindow.entries.map((entry) => entry.id), "a completed explicit review advances to another bounded window");
	f.scheduler.interrupt(); f.finish('{"operations":[]}'); await f.scheduler.join();
	f.scheduler.startExplicit("persona");
	for (let i = 0; i < 8; i++) await Promise.resolve();
	const afterCancel = JSON.parse(f.tasks.at(-1)!.split("\n").at(-1)!) as { entries: MemoryEntry[] };
	assert.deepEqual(afterCancel.entries.map((entry) => entry.id), secondWindow.entries.map((entry) => entry.id), "cancelled explicit work leaves its cursor unchanged");
	f.scheduler.interrupt(); f.finish('{"operations":[]}'); await f.scheduler.join();
});

test("no-work pages advance to older records, then activation resets coverage for the new scope", async () => {
	const entries = Array.from({ length: 100 }, (_, index) => makeMemory({ term: "long", kind: "note", text: `Foreign owner fact ${index}`, persona: index === 99 ? "dev" : "other" }, 2_000_000 - index));
	const newestOwnedId = entries[99]!.id;
	entries.push(...Array.from({ length: 50 }, (_, index) => makeMemory({ term: "long", kind: "note", text: `Current owner fact ${index}`, persona: "dev" }, 1_000_000 - index)));
	const f = fixture({ allowedTargets: ["persona"], entriesByTarget: { persona: entries } });
	f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire(); await f.scheduler.join();
	assert.equal(f.launches(), 0, "a single short owned row is an intentional no-work page");
	f.advance(); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	assert.ok(f.inspectCalls.some((call) => call.offset === 100 && call.max === 100));
	assert.equal(f.launches(), 1, "the next trigger reaches older owned records after a no-work page");
	const payload = JSON.parse(f.tasks[0]!.split("\n").at(-1)!) as { entries: MemoryEntry[] };
	assert.ok(payload.entries.some((entry) => entry.id === newestOwnedId), "the latest eligible owner row stays admitted when reviewing an older page");
	f.finish('{"operations":[]}'); await f.scheduler.join();
	f.scheduler.activate(f.owner); f.scheduler.memoryAdded("persona"); f.scheduler.tokensUsed(AUTO_INPUT_TOKEN_THRESHOLD); f.advance(); f.scheduler.settled(); await f.fire();
	assert.equal(f.inspectCalls.at(-1)?.offset, 0, "a replacement activation starts coverage at the first page");
	f.finish('{"operations":[]}'); await f.scheduler.join();
});

test("admitted passes rotate beyond 12 rows and 100-row pages while new entries keep arriving", async () => {
	const original = Array.from({ length: 235 }, (_, index) => makeMemory({ term: "long", kind: "note", text: `Repository fact ${index} records a distinct verified deployment detail.`, source: `source-${index}` }, 1_000_000 - index));
	const oldestId = original.at(-1)!.id;
	const f = fixture({ allowedTargets: ["persona"], entriesByTarget: { persona: original } });
	const visited = new Set<string>();
	const admitted = 31;
	for (let pass = 0; pass < admitted; pass++) {
		const newest = makeMemory({ term: "long", kind: "note", text: `New fact storm ${pass} preserves this latest session detail.`, source: `storm-${pass}` }, 2_000_000 + pass);
		f.entriesByTarget.persona.push(newest);
		if (pass > 0) { f.advance(); f.scheduler.tokensUsed(AUTO_INPUT_TOKEN_THRESHOLD); }
		f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
		assert.ok(f.launches() >= pass + 1, "each bounded record set changes as the newest fact arrives");
		const task = f.tasks.at(-1)!;
		const payload = JSON.parse(task.split("\n").at(-1)!) as { entries: MemoryEntry[] };
		assert.ok(payload.entries.some((entry) => entry.id === newest.id), "newest eligible fact is admitted on every pass");
		for (const entry of payload.entries) visited.add(entry.id);
		assert.ok(payload.entries.length <= 12);
		f.finish('{"operations":[]}'); await f.scheduler.join();
	}
	assert.ok(f.inspectCalls.some((call) => call.offset >= 200), "rotation scans pages beyond the first 100 records despite new-entry triggers");
	assert.ok(visited.has(oldestId), "the oldest eligible fact eventually reaches a worker");
	assert.equal(f.events.includes("cancel"), false, "completed receipts remain settled and are not cancelled by cursor advancement");
});
test("later reviews require one million main input tokens plus dirty memory; usage alone never dirties a tier", async () => {
	const f = fixture(); assert.equal(AUTO_INPUT_TOKEN_THRESHOLD, 1_000_000);
	f.scheduler.tokensUsed(AUTO_INPUT_TOKEN_THRESHOLD); f.scheduler.tokensUsed(NaN); f.scheduler.settled();
	assert.equal(f.pending(), 0, "usage without a new or interrupted memory set cannot start a review");
	f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire(); assert.equal(f.launches(), 1, "the first dirty review skips the token floor");
	f.finish('{"operations":[]}'); await f.scheduler.join();
	f.entriesByTarget.persona.push(makeMemory({ term: "long", kind: "note", text: "A later owner fact makes the tier dirty again." }, 3_000_000));
	f.advance(); f.scheduler.memoryAdded("persona"); f.scheduler.tokensUsed(999_999); f.scheduler.settled();
	assert.equal(f.pending(), 0);
	assert.match(f.scheduler.status(), /1 main input tokens remain/);
	f.scheduler.tokensUsed(1); f.scheduler.settled(); assert.deepEqual(f.delays(), [2_000]);
	await f.fire(); assert.equal(f.launches(), 2);
	f.finish('{"operations":[]}'); await f.scheduler.join(); f.scheduler.stop();
});
test("busy/queued foreground work prevents admission, and off cancels a real worker", async () => {
	const f = fixture(); f.scheduler.memoryAdded("persona"); f.setIdle(false); f.scheduler.settled(); assert.equal(f.pending(), 0);
	f.setIdle(true); f.scheduler.settled(); await f.fire(); f.scheduler.setEnabled(false); await f.scheduler.join();
	assert.ok(f.events.includes("cancel")); assert.equal(f.applied(), 0); assert.match(f.scheduler.status(), /off/i);
});
test("automatic proposal report contains full before/after evidence and precedes apply", async () => {
	const f = fixture({ applyWarning: "durable receipt remains prepared because history finalization failed" }); const output = JSON.stringify({ operations: [{ sourceIds: f.entries.map((e) => e.id), kind: "convention", text: "Persona prefers concise sentences and explicit examples." }] });
	f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire(); f.finish(output); await f.scheduler.join();
	assert.equal(f.applied(), 1); assert.ok(f.events.indexOf("report:Mind automatic proposal") < f.events.indexOf("apply"));
	const proposal = f.reports.find((report) => report.title === "Mind automatic proposal")?.body ?? "";
	assert.match(proposal, /Persona prefers concise sentences\./); assert.match(proposal, /persona profile one/); assert.match(proposal, /derivedFrom/);
	assert.match(proposal, /Persona prefers concise sentences and explicit examples\./); assert.match(proposal, /Automatic apply pending/);
	assert.doesNotMatch(proposal, /Review then call apply/i);
	const result = f.reports.find((report) => report.title === "Mind automatic result")?.body ?? "";
	assert.match(result, /Undo: \/mind optimize undo auto-receipt persona/);
	assert.match(result, /Warning: durable receipt remains prepared because history finalization failed/);
	assert.match(result, /Worker run · provider\/current · high/, "the final receipt keeps worker provenance");
});
test("foreground interruption prevents applying a worker's late JSON", async () => {
	const f = fixture(); const output = '{"operations":[]}';
	f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire(); f.scheduler.interrupt(); f.finish(output); await f.scheduler.join();
	assert.equal(f.applied(), 0);
});

test("cancelled review retains its cooldown and retries the same dirty tier only after settled", async () => {
	const f = fixture(); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	f.scheduler.interrupt(); await f.scheduler.join();
	assert.deepEqual(f.attempts.map((attempt) => attempt.state), ["started"]);
	assert.match(f.scheduler.status(), /review interrupted; waiting for the next settled event/);
	assert.match(f.scheduler.status(), /without another token wait/);
	assert.doesNotMatch(f.scheduler.status(), /worker active|is reviewing memory/);
	assert.equal(f.pending(), 0, "interruption cannot rearm itself");
	f.scheduler.settled(); assert.deepEqual(f.delays(), [AUTO_COOLDOWN_MS]);
	f.advance(); await f.fire(); assert.equal(f.launches(), 2, "an unfinished review is not a seen digest");
	f.finish('{"operations":[]}'); await f.scheduler.join();
	assert.deepEqual(f.attempts.map((attempt) => attempt.state), ["started", "started", "settled"]);
	f.advance(); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire(); await f.scheduler.join();
	assert.equal(f.launches(), 2, "a completed no-op remains suppressed");
});

test("an interrupted tier cannot spend its token-floor exception on an earlier dirty tier", async () => {
	const f = fixture({ allowedTargets: ["project-long", "persona"] });
	f.scheduler.memoryAdded("project-long"); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	assert.equal(f.launches(), 1);
	assert.equal((JSON.parse(f.tasks[0]!.split("\n").at(-1)!) as { target: string }).target, "project-long");
	f.scheduler.interrupt(); await f.scheduler.join();
	f.scheduler.settled(); assert.deepEqual(f.delays(), [AUTO_COOLDOWN_MS]);
	f.advance(); await f.fire();
	assert.equal(f.launches(), 2);
	assert.equal((JSON.parse(f.tasks[1]!.split("\n").at(-1)!) as { target: string }).target, "project-long", "only the interrupted tier may retry below the token floor");
	f.finish('{"operations":[]}'); await f.scheduler.join();
	assert.match(f.scheduler.status(), /dirty review pending; 1,000,000 main input tokens remain/, "the untouched persona tier stays dirty for a later admitted pass");
});

test("interruption after model completion but during preview remains retryable", async () => {
	const gate = deferred<void>(); const f = fixture({ previewGate: gate.promise });
	f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	f.finish(JSON.stringify({ operations: [{ sourceIds: f.entries.map((entry) => entry.id), kind: "convention", text: "Persona prefers concise sentences and explicit examples." }] }));
	for (let i = 0; i < 12; i++) await Promise.resolve();
	assert.ok(f.events.includes("preview"));
	f.scheduler.interrupt(); gate.resolve(); await f.scheduler.join();
	assert.equal(f.applied(), 0);
	assert.deepEqual(f.attempts.map((attempt) => attempt.state), ["started"]);
	f.scheduler.settled(); f.advance(); await f.fire();
	assert.equal(f.launches(), 2);
	f.finish('{"operations":[]}'); await f.scheduler.join();
});

test("an old cancelled worker cannot queue work in a replacement owner", async () => {
	const f = fixture(); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	f.scheduler.activate({ ...f.owner, key: "replacement", attempts: [] }); await f.scheduler.join();
	f.scheduler.settled();
	assert.equal(f.pending(), 0);
	assert.equal(f.launches(), 1);
	f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	assert.equal(f.launches(), 2, "a new owner gets its own first-review exemption");
	f.finish('{"operations":[]}'); await f.scheduler.join();
});

test("restoring a started-only attempt preserves cooldown without suppressing its digest", async () => {
	const f = fixture(); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	f.scheduler.interrupt(); await f.scheduler.join();
	f.scheduler.activate(f.owner); f.scheduler.settled();
	assert.deepEqual(f.delays(), [AUTO_COOLDOWN_MS]);
	f.advance(); await f.fire(); assert.equal(f.launches(), 2);
	f.finish('{"operations":[]}'); await f.scheduler.join();
});

test("off does not carry a cancelled tier into a later on switch", async () => {
	const f = fixture(); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	f.scheduler.setEnabled(false); await f.scheduler.join();
	f.scheduler.setEnabled(true); assert.equal(f.pending(), 0);
	assert.equal(f.attempts.some((attempt) => attempt.state === "settled"), false);
});
test("off clears an idle pending review; saves while off wait for a new post-on write", async () => {
	const f = fixture(); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); assert.deepEqual(f.delays(), [2_000]);
	f.scheduler.setEnabled(false); assert.deepEqual(f.delays(), []);
	f.scheduler.memoryAdded("persona"); f.scheduler.setEnabled(true); f.scheduler.settled();
	assert.deepEqual(f.delays(), [], "a save made while off does not queue background work");
	assert.doesNotMatch(f.scheduler.status(), /disabled/, "re-enabling reports the current state");
	assert.equal(f.launches(), 0);
	f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	assert.equal(f.launches(), 1, "the next post-on write creates a fresh first-owner trigger");
	f.finish('{"operations":[]}'); await f.scheduler.join();
});
test("off then on cannot let a late worker completion requeue or settle its cancelled attempt", async () => {
	const f = fixture({ cancelCompletes: false }); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	assert.equal(f.launches(), 1);
	f.scheduler.setEnabled(false); assert.ok(f.events.includes("cancel"));
	assert.deepEqual(f.attempts.map((attempt) => attempt.state), ["started"]);
	f.scheduler.memoryAdded("project-long"); f.scheduler.setEnabled(true); f.scheduler.settled();
	f.finish('{"operations":[]}'); await f.scheduler.join();
	assert.deepEqual(f.attempts.map((attempt) => attempt.state), ["started"], "a stale successful completion is not recorded as reviewed");
	assert.equal(f.applied(), 0);
	assert.equal(f.pending(), 0, "late completion cannot restore the cleared retry queue after re-enable");
	f.scheduler.settled(); assert.equal(f.pending(), 0, "on waits for a new post-on memory write");
});

test("off during inspection does not requeue the interrupted read", async () => {
	const gate = deferred<void>(); const f = fixture({ inspectGate: gate.promise });
	f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	f.scheduler.setEnabled(false); f.scheduler.setEnabled(true); gate.resolve(); await f.scheduler.join();
	f.scheduler.settled(); assert.equal(f.pending(), 0);
	assert.equal(f.launches(), 0);
});
test("interrupting a worker does not rearm another tier until a later settled event", async () => {
	const f = fixture({ allowedTargets: ["persona", "project-long"] }); f.scheduler.memoryAdded("persona"); f.scheduler.memoryAdded("project-long"); f.scheduler.settled(); await f.fire();
	assert.equal(f.launches(), 1); f.scheduler.interrupt(); await f.scheduler.join();
	assert.equal(f.pending(), 0, "cancellation alone cannot schedule background work during a foreground turn");
	f.scheduler.settled(); assert.deepEqual(f.delays(), [AUTO_COOLDOWN_MS]);
});
test("inspection interruption preserves its target even when the invalidated read rejects", async () => {
	const gate = deferred<void>(); const f = fixture({ inspectGate: gate.promise, inspectFailsAfterGate: true });
	f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	f.scheduler.interrupt(); gate.resolve(); await f.scheduler.join();
	f.scheduler.settled(); assert.equal(f.pending(), 1); assert.equal(f.launches(), 0);
});
test("automatic review validates returned store tier and does not process mismatched rows", async () => {
	const f = fixture({ wrongInspectTarget: true }); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire(); await f.scheduler.join();
	assert.equal(f.launches(), 0); assert.equal(f.applied(), 0);
});
test("attempt history persists the digest and cooldown across owner activation", async () => {
	const f = fixture(); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire(); f.finish('{"operations":[]}'); await f.scheduler.join();
	assert.deepEqual(f.attempts.map((attempt) => attempt.state), ["started", "settled"]);
	assert.ok(f.attempts.every((attempt) => attempt.target === "persona"));
	assert.equal(f.attempts[0]!.at, f.attempts[1]!.at, "settlement preserves the actual launch timestamp for cooldown");
	f.scheduler.activate(f.owner); f.scheduler.memoryAdded("persona"); f.scheduler.settled();
	assert.equal(f.pending(), 0, "restored completed attempts do not make usage-only work dirty");
	f.scheduler.tokensUsed(AUTO_INPUT_TOKEN_THRESHOLD); f.scheduler.settled();
	assert.deepEqual(f.delays(), [AUTO_COOLDOWN_MS]);
	f.advance(); await f.fire(); await f.scheduler.join();
	assert.equal(f.launches(), 1, "the persisted semantic digest is not reviewed twice after reactivation");
});
test("a restored started receipt is not retryable when the same digest already settled", async () => {
	const f = fixture(); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire(); f.finish('{"operations":[]}'); await f.scheduler.join();
	const settled = f.attempts.find((attempt) => attempt.state === "settled")!;
	f.attempts.push({ ...settled, state: "started", at: settled.at + 1 });
	f.scheduler.activate(f.owner); f.scheduler.settled();
	assert.deepEqual(f.delays(), [], "a stale duplicate started receipt cannot requeue already reviewed input");
	assert.equal(f.launches(), 1);
});
test("a second dirty tier waits for one million input tokens and the five-minute cooldown", async () => {
	const f = fixture({ allowedTargets: ["persona", "project-long"] });
	f.scheduler.memoryAdded("persona"); f.scheduler.memoryAdded("project-long"); f.scheduler.settled(); await f.fire();
	assert.equal(f.launches(), 1); f.finish('{"operations":[]}'); await f.scheduler.join();
	assert.equal(f.pending(), 0, "the other first-burst tier stays dirty but does not get a cooldown-only exception");
	assert.match(f.scheduler.status(), /1,000,000 main input tokens remain/);
	f.scheduler.tokensUsed(AUTO_INPUT_TOKEN_THRESHOLD); f.scheduler.settled();
	assert.deepEqual(f.delays(), [AUTO_COOLDOWN_MS]);
	f.advance(); await f.fire(); assert.equal(f.launches(), 2);
	f.finish('{"operations":[]}'); await f.scheduler.join();
});
test("token and memory triggers only inspect tiers allowed to the active owner", async () => {
	const f = fixture({ allowedTargets: ["persona"] });
	f.scheduler.memoryAdded("project"); f.scheduler.tokensUsed(AUTO_INPUT_TOKEN_THRESHOLD); f.scheduler.settled(); await f.fire();
	assert.deepEqual(f.inspected, []); assert.equal(f.launches(), 0, "a token threshold cannot dirty allowed tiers by itself");
	f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire();
	assert.deepEqual(f.inspected, ["persona"]); assert.equal(f.launches(), 1);
	f.finish('{"operations":[]}'); await f.scheduler.join();
});
test("attempt persistence failure cancels the admitted worker before any apply", async () => {
	const f = fixture({ recordAttempt: () => { throw new Error("persist failed"); } });
	f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire(); await f.scheduler.join();
	assert.equal(f.launches(), 1); assert.ok(f.events.includes("cancel")); assert.equal(f.applied(), 0);
});
test("revoked owner and malformed output cannot commit into a replacement session", async () => {
	const f = fixture(); f.scheduler.memoryAdded("persona"); f.scheduler.settled(); await f.fire(); f.revoke(); f.finish('{"operations":[]}'); await f.scheduler.join(); assert.equal(f.events.some((event) => event.startsWith("report:")), false);
	const g = fixture(); g.scheduler.memoryAdded("persona"); g.scheduler.settled(); await g.fire(); g.finish('{"operations":[],"execute":"bad"}'); await g.scheduler.join(); assert.equal(g.applied(), 0);
	assert.deepEqual(g.attempts.map((attempt) => attempt.state), ["started", "settled"], "completed malformed output is suppressed to avoid a failure loop");
});
