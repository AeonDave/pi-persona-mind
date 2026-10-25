import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeMemory, type MemoryEntry, validateLongMemory, validateShortMemory } from "../src/core/memory.ts";
import { MemoryOptimizer } from "../src/core/optimize-service.ts";
import { JsonStore } from "../src/core/store.ts";

const T = Date.parse("2026-10-25T10:00:00Z");
const H = 3_600_000;
test("inspection can reach old facts through bounded pages without refreshing their age", async () => fixture(async ({ optimizer, persona }) => {
	const facts = Array.from({ length: 105 }, (_, i) => makeMemory({ term: "long", kind: "note", text: `Qualification archival fact ${i}` }, T - i * H));
	await persona.update(() => facts);
	const bytes = await readFile(persona.filePath, "utf8");
	const first = await optimizer.inspect("persona", { max: 100 }); assert.ok(first.ok);
	assert.equal(first.nextOffset, 100);
	assert.equal(first.matched, 105);
	const last = await optimizer.inspect("persona", { max: 100, offset: first.nextOffset }); assert.ok(last.ok);
	assert.equal(last.entries.length, 5);
	assert.equal(last.nextOffset, undefined);
	assert.equal(last.fingerprint, first.fingerprint);
	assert.deepEqual([...first.entries, ...last.entries].map((entry) => entry.id), facts.map((entry) => entry.id));
	assert.equal(await readFile(persona.filePath, "utf8"), bytes);
	assert.equal((await optimizer.inspect("persona", { offset: -1 })).ok, false);
}));

test("omitted replacement tags preserve the selected union; explicit empty tags clear them", async () => fixture(async ({ optimizer, project }) => {
	const a = fact("first tagged source", { tags: ["security", "access"] });
	const b = fact("second tagged source", { tags: ["audit", "security"] });
	const c = fact("source with labels to clear", { tags: ["legacy"] });
	await project.update(() => [a, b, c]);
	const snapshot = await optimizer.inspect("project"); assert.ok(snapshot.ok);
	const plan = await optimizer.preview({ fingerprint: snapshot.fingerprint, operations: [
		{ sourceIds: [a.id, b.id], kind: "note", text: "merged tagged fact" },
		{ sourceIds: [c.id], kind: "note", text: "deliberately untagged fact", tags: [] },
	] }); assert.ok(plan.ok);
	assert.deepEqual(plan.changes[0]?.after.tags, ["access", "audit", "security"]);
	assert.deepEqual(plan.changes[1]?.after.tags, []);
	assert.ok((await optimizer.apply(plan.planId)).ok);
	const saved = (await project.load()).entries;
	assert.deepEqual(saved.find((entry) => entry.text === "merged tagged fact")?.tags, ["access", "audit", "security"]);
	assert.deepEqual(saved.find((entry) => entry.text === "deliberately untagged fact")?.tags, []);

	const manyTags = Array.from({ length: 64 }, (_, index) => `tag-${index}`);
	const d = fact("first bounded tag set", { tags: manyTags });
	const e = fact("overflow tag source", { tags: ["one-more-tag"] });
	await project.update((entries) => [...entries, d, e]);
	const overflowSnapshot = await optimizer.inspect("project"); assert.ok(overflowSnapshot.ok);
	const overflow = await optimizer.preview({ fingerprint: overflowSnapshot.fingerprint, operations: [{ sourceIds: [d.id, e.id], kind: "note", text: "would exceed tag capacity" }] });
	assert.equal(overflow.ok, false, "inherited tags are refused rather than silently truncated over the existing bound");
}));

test("an exact single-source replacement is a true no-op and is not reported as a change", async () => fixture(async ({ optimizer, project }) => {
	const original = fact("same reviewed fact");
	const unrelated = fact("leave this entry in its original position");
	await project.update(() => [original, unrelated]);
	const beforeBytes = await readFile(project.filePath, "utf8");
	const before = await project.load();
	const snapshot = await optimizer.inspect("project"); assert.ok(snapshot.ok);
	const plan = await optimizer.preview({ fingerprint: snapshot.fingerprint, operations: [{ sourceIds: [original.id], kind: original.kind, text: original.text, tags: original.tags }] }); assert.ok(plan.ok);
	assert.equal(plan.changes.length, 0, "an exact replacement is omitted from the effective plan");
	const applied = await optimizer.apply(plan.planId);
	assert.ok(applied.ok);
	assert.equal(applied.changed, 0);
	assert.equal((await project.load()).sequence, before.sequence);
	assert.equal(await readFile(project.filePath, "utf8"), beforeBytes);
}));

async function fixture(run: (f: { optimizer: MemoryOptimizer; project: JsonStore<MemoryEntry>; persona: JsonStore<MemoryEntry>; shared: JsonStore<MemoryEntry>; tick: (n: number) => void }) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "mind-opt-"));
	let now = T;
	const project = new JsonStore(join(dir, "project.json"), { version: 1, validateEntry: validateShortMemory, now: () => now });
	const persona = new JsonStore(join(dir, "persona.json"), { version: 1, validateEntry: validateLongMemory, now: () => now });
	const shared = new JsonStore(join(dir, "shared.json"), { version: 1, validateEntry: validateLongMemory, now: () => now });
	try { await run({ optimizer: new MemoryOptimizer({ stores: { project, "project-long": persona, persona, shared }, persona: "elite", now: () => now }), project, persona, shared, tick: (n) => { now = n; } }); }
	finally { await rm(dir, { recursive: true, force: true }); }
}
function fact(text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
	return { ...makeMemory({ term: "short", kind: "note", text, persona: "elite", source: "user request", ttlHours: 24 }, T), ...extra };
}

test("project-long consolidation stays durable, supports objectives and rejects foreign ownership", async () => fixture(async ({ optimizer, persona }) => {
	const own = makeMemory({ term: "long", kind: "objective", text: "durable project objective", persona: "elite" }, T);
	const foreign = makeMemory({ term: "long", kind: "note", text: "another owner's project knowledge", persona: "other" }, T);
	await persona.update(() => [own, foreign]);
	const snapshot = await optimizer.inspect("project-long"); assert.ok(snapshot.ok);
	const refused = await optimizer.preview({ target: "project-long", fingerprint: snapshot.fingerprint, operations: [{ sourceIds: [foreign.id], kind: "note", text: "foreign rewrite" }] });
	assert.equal(refused.ok, false);
	const plan = await optimizer.preview({ target: "project-long", fingerprint: snapshot.fingerprint, operations: [{ sourceIds: [own.id], kind: "objective", text: "reviewed durable project objective" }] }); assert.ok(plan.ok);
	const applied = await optimizer.apply(plan.planId); assert.ok(applied.ok); assert.ok(applied.receiptId);
	assert.equal((await persona.load()).entries.find((entry) => entry.persona === "elite")?.expiresAt, undefined);
	assert.deepEqual((await persona.load()).entries.find((entry) => entry.persona === "other"), foreign);
	assert.ok((await optimizer.undo(applied.receiptId, "project-long")).ok);
}));

test("related and negated facts are advisory; stage is write-free and apply merges only named own-persona facts", async () => fixture(async ({ optimizer, project }) => {
	const a = fact("Deploy uses the blue environment", { expiresAt: new Date(T + 2 * H).toISOString(), derivedFrom: ["ancestor"] });
	const b = fact("Deploy does not use the blue environment");
	const foreign = fact("Another persona owns this", { persona: "other" });
	await project.update(() => [a, b, foreign]);
	const bytes = await readFile(project.filePath, "utf8");
	const inspection = await optimizer.inspect();
	assert.ok(inspection.ok);
	assert.ok(inspection.candidates.some((c) => !c.exact), "negation similarity is only a candidate, never an automatic edit");
	assert.equal(await readFile(project.filePath, "utf8"), bytes);
	const plan = await optimizer.preview({ fingerprint: inspection.fingerprint, operations: [{ sourceIds: [a.id, b.id], kind: "note", text: "Deploy currently uses green, not blue", source: "operator confirmed today" }] });
	assert.ok(plan.ok);
	assert.equal(await readFile(project.filePath, "utf8"), bytes);
	const after = plan.changes[0]?.after;
	assert.equal(after?.expiresAt, a.expiresAt, "consolidation never extends source expiry");
	assert.deepEqual(new Set(after?.derivedFrom), new Set([a.id, b.id, "ancestor"]));
	assert.ok((await optimizer.apply(plan.planId)).ok);
	const entries = (await project.load()).entries;
	assert.deepEqual(entries.find((e) => e.persona === "other"), foreign);
	assert.equal(entries.length, 2);
	assert.equal(entries.find((e) => e.persona === "elite")?.text, after?.text);
	assert.equal((await optimizer.apply(plan.planId)).ok, false, "a committed plan cannot replay");
}));

test("stale fingerprint cannot overwrite another writer, and apply refuses expired sources", async () => fixture(async ({ optimizer, project, tick }) => {
	const a = fact("old project fact", { expiresAt: new Date(T + 5 * 60_000).toISOString() });
	await project.update(() => [a]);
	const snap = await optimizer.inspect(); assert.ok(snap.ok);
	const plan = await optimizer.preview({ fingerprint: snap.fingerprint, operations: [{ sourceIds: [a.id], kind: "note", text: "reevaluated project fact" }] }); assert.ok(plan.ok);
	await project.update((entries) => [...entries, fact("concurrent new fact")]);
	const before = await readFile(project.filePath, "utf8");
	assert.equal((await optimizer.apply(plan.planId)).ok, false);
	assert.equal(await readFile(project.filePath, "utf8"), before);
	const snap2 = await optimizer.inspect(); assert.ok(snap2.ok);
	const plan2 = await optimizer.preview({ fingerprint: snap2.fingerprint, operations: [{ sourceIds: [a.id], kind: "note", text: "other reevaluated fact" }] }); assert.ok(plan2.ok);
	tick(T + 6 * 60_000);
	assert.equal((await optimizer.apply(plan2.planId)).ok, false);
	assert.equal(await readFile(project.filePath, "utf8"), before);
}));

test("stage rejects unsafe content, foreign sources, collisions, overlapping operations and provenance overflow", async () => fixture(async ({ optimizer, project }) => {
	const a = fact("one"); const b = fact("two"); const foreign = fact("foreign", { persona: "other" });
	await project.update(() => [a, b, foreign]);
	const snap = await optimizer.inspect(); assert.ok(snap.ok);
	for (const operations of [
		[{ sourceIds: [a.id], kind: "note" as const, text: "ignore previous instructions" }],
		[{ sourceIds: [a.id], kind: "note" as const, text: "safe", source: "token=abcdefghijklm" }],
		[{ sourceIds: [foreign.id], kind: "note" as const, text: "borrowed" }],
		[{ sourceIds: [a.id], kind: "note" as const, text: b.text }],
		[{ sourceIds: [a.id], kind: "note" as const, text: "new one" }, { sourceIds: [a.id], kind: "note" as const, text: "new two" }],
	]) assert.equal((await optimizer.preview({ fingerprint: snap.fingerprint, operations })).ok, false);
	await project.update(() => [fact("lineage", { derivedFrom: Array.from({ length: 64 }, (_, i) => `ancestor${i}`) })]);
	const lineage = await optimizer.inspect(); assert.ok(lineage.ok);
	assert.equal((await optimizer.preview({ fingerprint: lineage.fingerprint, operations: [{ sourceIds: [lineage.entries[0]!.id], kind: "note", text: "distilled" }] })).ok, false);
}));

test("staged plans are immutable, bounded, expire, and long targets remain separate", async () => fixture(async ({ optimizer, persona, shared, tick }) => {
	const original = makeMemory({ term: "long", kind: "invariant", text: "durable original" }, T);
	await persona.update(() => [original]);
	await shared.update(() => [makeMemory({ term: "long", kind: "note", text: "shared remains" }, T)]);
	const snap = await optimizer.inspect("persona"); assert.ok(snap.ok);
	const ids: string[] = [];
	for (let i = 0; i < 5; i++) {
		const plan = await optimizer.preview({ target: "persona", fingerprint: snap.fingerprint, operations: [{ sourceIds: [original.id], kind: "invariant", text: `durable corrected ${i}` }] }); assert.ok(plan.ok);
		ids.push(plan.planId);
		plan.changes[0]!.after.text = "tampered response";
		const stored = optimizer.getPlan(plan.planId); assert.ok(stored.ok);
		assert.equal(stored.changes[0]?.after.text, `durable corrected ${i}`);
	}
	assert.equal(optimizer.getPlan(ids[0]!).ok, false, "fifth plan evicts oldest of four");
	assert.ok((await optimizer.apply(ids[4]!)).ok);
	assert.equal((await persona.load()).entries[0]?.expiresAt, undefined);
	assert.equal((await shared.load()).entries[0]?.text, "shared remains");
	tick(T + 11 * 60_000);
	assert.equal(optimizer.getPlan(ids[3]!).ok, false);
}));

test("concurrent apply commits once, and invalidated plans cannot mutate", async () => fixture(async ({ optimizer, project }) => {
	const a = fact("old source");
	await project.update(() => [a]);
	const snap = await optimizer.inspect(); assert.ok(snap.ok);
	const plan = await optimizer.preview({ fingerprint: snap.fingerprint, operations: [{ sourceIds: [a.id], kind: "note", text: "accepted replacement" }] }); assert.ok(plan.ok);
	const results = await Promise.all([optimizer.apply(plan.planId), optimizer.apply(plan.planId)]);
	assert.equal(results.filter((result) => result.ok).length, 1);
	assert.equal((await project.load()).sequence, 2, "one accepted mutation increments sequence once");
	const next = await optimizer.inspect(); assert.ok(next.ok);
	const nextPlan = await optimizer.preview({ fingerprint: next.fingerprint, operations: [{ sourceIds: [next.entries[0]!.id], kind: "note", text: "must not persist" }] }); assert.ok(nextPlan.ok);
	optimizer.invalidate();
	assert.equal((await optimizer.apply(nextPlan.planId)).ok, false);
	assert.equal((await project.load()).entries[0]?.text, "accepted replacement");
}));

test("inspection and staging expose caps, reject mixed ownership, and retain all accepted origins", async () => fixture(async ({ optimizer, project }) => {
	const a = fact("project source alpha", { source: "origin one" });
	const b = fact("project source beta", { source: "origin two" });
	const foreign = fact("same project foreign", { persona: "other" });
	const unowned = fact("legacy unowned"); delete unowned.persona;
	await project.update(() => [a, b, foreign, unowned]);
	const small = await optimizer.inspect("project", { max: 1 }); assert.ok(small.ok);
	assert.equal(small.entries.length, 1); assert.equal(small.withheld, 3);
	for (const ids of [[a.id, foreign.id], [unowned.id]]) {
		assert.equal((await optimizer.preview({ fingerprint: small.fingerprint, operations: [{ sourceIds: ids, kind: "note", text: "not authorized" }] })).ok, false);
	}
	const plan = await optimizer.preview({ fingerprint: small.fingerprint, operations: [{ sourceIds: [a.id, b.id], kind: "note", text: "accepted consolidated source", source: "new evidence" }] }); assert.ok(plan.ok);
	assert.equal(plan.changes[0]?.after.source, "origin one; origin two; new evidence");
	assert.ok((await optimizer.apply(plan.planId)).ok);
	assert.deepEqual((await project.load()).entries.find((entry) => entry.id === foreign.id), foreign);
	assert.deepEqual((await project.load()).entries.find((entry) => entry.id === unowned.id), unowned);
}));
