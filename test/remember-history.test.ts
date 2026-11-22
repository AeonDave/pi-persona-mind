import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeMemory } from "../src/core/memory.ts";
import { MAX_OPTIMIZE_HISTORY, OptimizeHistoryStore } from "../src/core/optimize-history.ts";
import { memoryMutationLockPath, mindPaths, type Scope } from "../src/core/scope.ts";
import { MindService, type RememberInput } from "../src/core/service.ts";
import { JsonStore, withFileLock } from "../src/core/store.ts";
import { runMemoryHistory } from "../src/tools/memory-history.ts";

const T = Date.parse("2026-11-22T10:00:00Z");
async function fixture(run: (f: { mind: MindService; scope: Scope; reopen: (persona?: string) => MindService; tick: (now: number) => void }) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "mind-remember-history-"));
	let now = T;
	const scope: Scope = { persona: "elite", projectRoot: join(dir, "repo"), slug: "repo", paths: mindPaths(join(dir, "agent"), "elite", "repo") };
	const reopen = (persona = "elite") => new MindService({ ...scope, persona, paths: mindPaths(join(dir, "agent"), persona, "repo") }, { now: () => now });
	try { await run({ mind: reopen(), scope, reopen, tick: (time) => { now = time; } }); }
	finally { await rm(dir, { recursive: true, force: true }); }
}
function fact(text: string, supersedes?: string): RememberInput {
	return { term: "long", scope: "project", kind: "note", text, ...(supersedes ? { supersedes } : {}) };
}

test("ordinary replacement retains original provenance in the existing history, outside active recall and injection", async () => fixture(async ({ mind, reopen }) => {
	const old = await mind.remember({ ...fact("Project runtime is version twenty"), source: "original decision", derivedFrom: ["evidence-a"] }); assert.ok(old.ok);
	const next = await mind.remember({ ...fact("Project runtime is version twenty two", old.entry.id), source: "updated decision" }); assert.ok(next.ok);
	assert.ok(next.receiptId);
	assert.deepEqual((await mind.recall("", "project", 10)).hits, [next.entry]);
	assert.doesNotMatch(await mind.buildInjection(), /version twenty<|version twenty\n|original decision/);
	const optimizer = reopen().createOptimizer();
	const history = await optimizer.history("project-long"); assert.ok(history.ok); assert.equal(history.receipts.length, 1);
	const receipt = history.receipts[0]!;
	assert.equal(receipt.origin, "replacement"); assert.equal(receipt.planId, undefined); assert.equal(receipt.state, "applied");
	assert.deepEqual(receipt.changes, [{ before: [old.entry], after: next.entry }]);
	const detail = await optimizer.getReceipt(next.receiptId, "project-long"); assert.ok(detail.ok); assert.deepEqual(detail.receipt, receipt);
	assert.equal((await optimizer.getReceipt(next.receiptId, "project")).ok, false);
	const undo = await optimizer.undo(next.receiptId, "project-long"); assert.ok(!undo.ok); assert.match(undo.reason, /ordinary replacement.*undo/i);
}));

test("plain remember, exact re-recording, self-supersession and missing source do not create history", async () => fixture(async ({ mind, scope }) => {
	const first = await mind.remember(fact("stable fact")); assert.ok(first.ok);
	assert.ok((await mind.remember(fact("stable fact"))).ok);
	assert.ok((await mind.remember(fact("stable fact", first.entry.id))).ok);
	assert.ok((await mind.remember(fact("additional fact", "missing-source"))).ok);
	assert.equal(existsSync(`${scope.paths.projectLtm}.optimize-history.json`), false);
	const history = await mind.createOptimizer().history("project-long"); assert.ok(history.ok); assert.equal(history.retained, 0);
}));

test("replacement into an existing fact retains both retired and updated provenance", async () => fixture(async ({ mind }) => {
	const old = await mind.remember({ ...fact("old fact"), source: "first decision" }); assert.ok(old.ok);
	const existing = await mind.remember({ ...fact("current fact"), source: "independent observation", derivedFrom: ["existing-evidence"] }); assert.ok(existing.ok);
	const result = await mind.remember(fact("current fact", old.entry.id)); assert.ok(result.ok);
	assert.equal(result.entry.source, existing.entry.source); assert.deepEqual(result.entry.derivedFrom, existing.entry.derivedFrom);
	const history = await mind.createOptimizer().history("project-long"); assert.ok(history.ok);
	assert.deepEqual(history.receipts[0]?.changes, [{ before: [old.entry, existing.entry], after: result.entry }]);
}));

test("concurrent ordinary replacements preserve both facts and both before images", async () => fixture(async ({ mind, reopen }) => {
	const first = await mind.remember(fact("first original")); assert.ok(first.ok);
	const second = await mind.remember(fact("second original")); assert.ok(second.ok);
	const results = await Promise.all([mind.remember(fact("first replacement", first.entry.id)), reopen().remember(fact("second replacement", second.entry.id))]);
	assert.ok(results.every((result) => result.ok));
	assert.deepEqual((await mind.recall("", "project", 10)).hits.map((entry) => entry.text).sort(), ["first replacement", "second replacement"]);
	const history = await mind.createOptimizer().history("project-long"); assert.ok(history.ok); assert.equal(history.retained, 2);
	assert.deepEqual(history.receipts.flatMap((receipt) => receipt.changes.flatMap((change) => change.before.map((entry) => entry.text))).sort(), ["first original", "second original"]);
}));

test("receipt preparation failure refuses ordinary replacement without repairing corrupt history", async () => fixture(async ({ mind, scope }) => {
	const old = await mind.remember(fact("old fact")); assert.ok(old.ok);
	const before = await readFile(scope.paths.projectLtm, "utf8");
	const historyPath = `${scope.paths.projectLtm}.optimize-history.json`;
	await writeFile(historyPath, "broken recovery evidence");
	const result = await mind.remember(fact("new fact", old.entry.id)); assert.ok(!result.ok);
	assert.equal(await readFile(scope.paths.projectLtm, "utf8"), before);
	assert.equal(await readFile(historyPath, "utf8"), "broken recovery evidence");
}));

test("ordinary supersession refuses invalid source bytes without recovering or quarantining them", async () => fixture(async ({ mind, scope }) => {
	const old = await mind.remember(fact("old fact")); assert.ok(old.ok);
	await mind.remember(fact("unrelated fact"));
	await writeFile(scope.paths.projectLtm, "broken source evidence");
	const result = await mind.remember(fact("new fact", old.entry.id)); assert.ok(!result.ok);
	assert.equal(await readFile(scope.paths.projectLtm, "utf8"), "broken source evidence");
	assert.equal(existsSync(`${scope.paths.projectLtm}.optimize-history.json`), false);
}));

test("ordinary replacement reports finalization failure while retaining a prepared before image", async () => fixture(async ({ mind }) => {
	const old = await mind.remember(fact("old fact")); assert.ok(old.ok);
	const settle = OptimizeHistoryStore.prototype.settle;
	OptimizeHistoryStore.prototype.settle = async () => { throw new Error("finalization unavailable"); };
	try {
		const result = await mind.remember(fact("new fact", old.entry.id)); assert.ok(result.ok); assert.match(result.warning ?? "", /committed.*prepared/);
		const history = await mind.createOptimizer().history("project-long"); assert.ok(history.ok); assert.equal(history.receipts[0]?.state, "prepared");
		assert.deepEqual(history.receipts[0]?.changes[0]?.before, [old.entry]);
		assert.deepEqual((await mind.recall("", "project", 10)).hits, [result.entry]);
	} finally { OptimizeHistoryStore.prototype.settle = settle; }
}));

test("an uncertain ordinary memory commit keeps its receipt and honestly reports the unknown outcome", async () => fixture(async ({ mind, scope }) => {
	const old = await mind.remember(fact("old fact")); assert.ok(old.ok);
	const compare = JsonStore.prototype.compareAndUpdate;
	JsonStore.prototype.compareAndUpdate = async function (fingerprint, mutate) {
		const result = await compare.call(this, fingerprint, mutate);
		if (this.filePath === scope.paths.projectLtm) throw new Error("lost confirmation after rename");
		return result;
	};
	try {
		const result = await mind.remember(fact("new fact", old.entry.id)); assert.ok(!result.ok); assert.match(result.reason, /uncertain.*prepared/);
	} finally { JsonStore.prototype.compareAndUpdate = compare; }
	const history = await mind.createOptimizer().history("project-long"); assert.ok(history.ok); assert.equal(history.receipts[0]?.state, "prepared");
	assert.deepEqual(history.receipts[0]?.changes[0]?.before, [old.entry]);
	assert.deepEqual((await mind.recall("", "project", 10)).hits.map((entry) => entry.text), ["new fact"]);
}));

test("ordinary replacement refuses a racing external write and preserves its unrelated fact", async () => fixture(async ({ mind, scope }) => {
	const old = await mind.remember(fact("old fact")); assert.ok(old.ok);
	const prepare = OptimizeHistoryStore.prototype.prepare;
	OptimizeHistoryStore.prototype.prepare = async function (receipt) {
		await prepare.call(this, receipt);
		const raw = JSON.parse(await readFile(scope.paths.projectLtm, "utf8"));
		raw.entries.push(makeMemory({ term: "long", kind: "note", text: "racing writer", persona: "elite" }, T));
		await writeFile(scope.paths.projectLtm, JSON.stringify(raw));
	};
	try { assert.equal((await mind.remember(fact("new fact", old.entry.id))).ok, false); }
	finally { OptimizeHistoryStore.prototype.prepare = prepare; }
	assert.deepEqual((await mind.recall("", "project", 10)).hits.map((entry) => entry.text).sort(), ["old fact", "racing writer"]);
	const history = await mind.createOptimizer().history("project-long"); assert.ok(history.ok); assert.equal(history.receipts[0]?.state, "rejected");
}));

test("expired source while awaiting commit refuses retirement and records a rejected intent", async () => fixture(async ({ mind, tick }) => {
	const old = await mind.remember({ term: "short", kind: "note", text: "working fact", ttlHours: 1 }); assert.ok(old.ok);
	const prepare = OptimizeHistoryStore.prototype.prepare;
	OptimizeHistoryStore.prototype.prepare = async function (receipt) { await prepare.call(this, receipt); tick(T + 2 * 3_600_000); };
	try {
		const result = await mind.remember({ term: "short", kind: "note", text: "replacement", supersedes: old.entry.id }); assert.ok(!result.ok); assert.match(result.reason, /expired/);
	} finally { OptimizeHistoryStore.prototype.prepare = prepare; }
	const history = await mind.createOptimizer().history("project"); assert.ok(history.ok); assert.equal(history.receipts[0]?.state, "rejected");
}));

test("a replacement that expires while preparing cannot retire a still-live source", async () => fixture(async ({ mind, tick }) => {
	const old = await mind.remember({ term: "short", kind: "note", text: "still-live original", ttlHours: 1 }); assert.ok(old.ok);
	const prepare = OptimizeHistoryStore.prototype.prepare;
	OptimizeHistoryStore.prototype.prepare = async function (receipt) { await prepare.call(this, receipt); tick(T + 10_000); };
	try {
		const result = await mind.remember({ term: "short", kind: "note", text: "short replacement", ttlHours: 1 / 3_600, supersedes: old.entry.id });
		assert.ok(!result.ok);
		assert.match(result.reason, /replacement.*expired/);
	} finally { OptimizeHistoryStore.prototype.prepare = prepare; }
	assert.deepEqual((await mind.recall("", "short", 10)).hits, [old.entry]);
	const history = await mind.createOptimizer().history("project"); assert.ok(history.ok);
	assert.equal(history.receipts[0]?.state, "rejected");
}));

test("history refuses oversized or noncanonical receipt timestamps without echoing stored metadata", async () => fixture(async ({ mind, scope }) => {
	const old = await mind.remember(fact("original")); assert.ok(old.ok);
	const next = await mind.remember(fact("replacement", old.entry.id)); assert.ok(next.ok);
	const path = `${scope.paths.projectLtm}.optimize-history.json`;
	const raw = JSON.parse(await readFile(path, "utf8"));
	for (const createdAt of [" ".repeat(100_000) + "2026-11-22", "2026-11-22", "2026-11-22T00:00:00.000Z<metadata>"]) {
		raw.entries[0].createdAt = createdAt;
		await writeFile(path, JSON.stringify(raw));
		const result = await runMemoryHistory(mind.createOptimizer(), { target: "project-long" });
		assert.equal(result.details.ok, false);
		assert.ok(JSON.stringify(result).length < 1_000);
		assert.ok(!JSON.stringify(result).includes(createdAt));
	}
}));

test("remember refuses a revoked or throwing owner before any memory IO", async () => fixture(async ({ scope }) => {
	for (const isCurrent of [() => false, () => { throw new Error("owner unavailable"); }]) {
		const guarded = new MindService(scope, { now: () => T, isCurrent });
		const result = await guarded.remember(fact("unaccepted fact"));
		assert.ok(!result.ok); assert.match(result.reason, /owner/);
		assert.equal(existsSync(scope.paths.projectLtm), false);
	}
}));

test("remember rechecks owner after waiting for the real mutation lock, preserving active facts", async () => fixture(async ({ mind, scope }) => {
	const old = await mind.remember(fact("original owner fact")); assert.ok(old.ok);
	for (const supersedes of [undefined, old.entry.id]) {
		let current = true;
		const guarded = new MindService(scope, { now: () => T, isCurrent: () => current });
		let release!: () => void; let acquired!: () => void;
		const ready = new Promise<void>((resolve) => { acquired = resolve; });
		const holding = withFileLock(memoryMutationLockPath(scope.paths), async () => { acquired(); await new Promise<void>((resolve) => { release = resolve; }); });
		await ready;
		const pending = guarded.remember(fact("stale queued fact", supersedes));
		current = false; release(); await holding;
		const result = await pending;
		assert.ok(!result.ok); assert.match(result.reason, /owner/);
		assert.deepEqual((await mind.recall("", "project", 10)).hits, [old.entry]);
	}
}));

test("remember owner checks run inside the actual store mutation callback on both write paths", async () => fixture(async ({ mind, scope }) => {
	const old = await mind.remember(fact("guarded original")); assert.ok(old.ok);
	const update = JsonStore.prototype.update;
	const compare = JsonStore.prototype.compareAndUpdate;
	let current = true;
	const guarded = new MindService(scope, { now: () => T, isCurrent: () => current });
	JsonStore.prototype.update = async function (mutate) { return update.call(this, (entries) => { if (this.filePath === scope.paths.projectLtm) current = false; return mutate(entries); }); };
	JsonStore.prototype.compareAndUpdate = async function (fingerprint, mutate) { return compare.call(this, fingerprint, (entries) => { if (this.filePath === scope.paths.projectLtm) current = false; return mutate(entries); }); };
	try {
		for (const supersedes of [undefined, old.entry.id]) {
			current = true;
			const result = await guarded.remember(fact("stale callback fact", supersedes));
			assert.ok(!result.ok); assert.match(result.reason, /owner/);
			assert.deepEqual((await mind.recall("", "project", 10)).hits, [old.entry]);
		}
	} finally { JsonStore.prototype.update = update; JsonStore.prototype.compareAndUpdate = compare; }
	const history = await mind.createOptimizer().history("project-long"); assert.ok(history.ok);
	assert.equal(history.receipts[0]?.state, "rejected");
}));

test("owner revocation after a real memory commit reports uncertainty without pretending rollback", async () => fixture(async ({ mind, scope }) => {
	const update = JsonStore.prototype.update;
	const compare = JsonStore.prototype.compareAndUpdate;
	let current = true;
	const guarded = new MindService(scope, { now: () => T, isCurrent: () => current });
	JsonStore.prototype.update = async function (mutate) { const result = await update.call(this, mutate); if (this.filePath === scope.paths.projectLtm) current = false; return result; };
	JsonStore.prototype.compareAndUpdate = async function (fingerprint, mutate) { const result = await compare.call(this, fingerprint, mutate); if (this.filePath === scope.paths.projectLtm) current = false; return result; };
	try {
		const first = await guarded.remember(fact("committed before owner changed"));
		assert.ok(!first.ok); assert.match(first.reason, /may have committed.*original scope/);
		const saved = (await mind.recall("", "project", 10)).hits[0]!;
		assert.equal(saved.text, "committed before owner changed");
		current = true;
		const next = await guarded.remember(fact("replacement committed before owner changed", saved.id));
		assert.ok(!next.ok); assert.match(next.reason, /may have committed.*original scope/);
		assert.deepEqual((await mind.recall("", "project", 10)).hits.map((entry) => entry.text), ["replacement committed before owner changed"]);
	} finally { JsonStore.prototype.update = update; JsonStore.prototype.compareAndUpdate = compare; }
}));

test("ordinary and optimizer changes share one retention budget and protect unresolved receipts", async () => fixture(async ({ mind, scope }) => {
	let current = await mind.remember(fact("initial fact")); assert.ok(current.ok);
	const optimizer = mind.createOptimizer();
	const snapshot = await optimizer.inspect("project-long"); assert.ok(snapshot.ok);
	const plan = await optimizer.preview({ target: "project-long", fingerprint: snapshot.fingerprint, operations: [{ sourceIds: [current.entry.id], kind: "note", text: "optimized fact" }] }); assert.ok(plan.ok);
	assert.ok((await optimizer.apply(plan.planId)).ok);
	let id = plan.changes[0]!.after.id;
	for (let index = 0; index < MAX_OPTIMIZE_HISTORY; index++) {
		current = await mind.remember(fact(`generation ${index}`, id)); assert.ok(current.ok); id = current.entry.id;
	}
	const history = await optimizer.history("project-long", 100); assert.ok(history.ok); assert.equal(history.retained, MAX_OPTIMIZE_HISTORY);
	assert.ok(history.receipts.every((receipt) => receipt.origin === "replacement"), "optimizer entry is evicted from the same pool");
	const historyPath = `${scope.paths.projectLtm}.optimize-history.json`;
	const raw = JSON.parse(await readFile(historyPath, "utf8"));
	for (const receipt of raw.entries) receipt.state = "prepared";
	await writeFile(historyPath, JSON.stringify(raw));
	const before = await readFile(scope.paths.projectLtm, "utf8");
	const refused = await mind.remember(fact("over capacity", id)); assert.ok(!refused.ok); assert.match(refused.reason, /capacity/);
	assert.equal(await readFile(scope.paths.projectLtm, "utf8"), before);
}));

test("replacement history is owner scoped and never grants undo of shared or foreign project records", async () => fixture(async ({ mind, reopen }) => {
	const old = await mind.remember(fact("owner observation")); assert.ok(old.ok);
	const foreign = reopen("other");
	const replaced = await foreign.remember(fact("new explicit observation", old.entry.id)); assert.ok(replaced.ok); assert.ok(replaced.receiptId);
	const hidden = await mind.createOptimizer().history("project-long"); assert.ok(hidden.ok); assert.equal(hidden.retained, 0);
	assert.equal((await mind.createOptimizer().getReceipt(replaced.receiptId, "project-long")).ok, false);
	assert.equal((await foreign.createOptimizer().undo(replaced.receiptId, "project-long")).ok, false);
	const shared = await mind.remember({ term: "long", scope: "shared", kind: "note", text: "shared before" }); assert.ok(shared.ok);
	const next = await mind.remember({ term: "long", scope: "shared", kind: "note", text: "shared after", supersedes: shared.entry.id }); assert.ok(next.ok); assert.ok(next.receiptId);
	assert.equal((await mind.createOptimizer().undo(next.receiptId, "shared")).ok, false);
}));
