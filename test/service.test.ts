import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { mindPaths, type Scope } from "../src/core/scope.ts";
import { MindService } from "../src/core/service.ts";

const H = 3_600_000;

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "ppm-svc-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

// Each test uses a unique namespace `ns` so its stores are fully isolated; within one test, two
// personas share the same ns to exercise the shared tier and the project-wide backlog.
function scopeFor(ns: string, persona: string): Scope {
	const agentDir = join(dir, ns, "agent");
	return { persona, projectRoot: join(dir, ns, "proj"), slug: "proj", paths: mindPaths(agentDir, persona, "proj") };
}

function svc(ns: string, persona: string, now: number): MindService {
	return new MindService(scopeFor(ns, persona), { now: () => now });
}

test("remember(long) then recall finds it", async () => {
	const s = svc("recall", "elite", 1_000_000);
	const r = await s.remember({ term: "long", kind: "preference", text: "prefers verbose recon" });
	assert.equal(r.ok, true);
	const { hits } = await s.recall("recon", "both", 10);
	assert.equal(hits.length, 1);
	assert.equal(hits[0]?.text, "prefers verbose recon");
});

test("the content scanner rejects a secret before it is stored", async () => {
	const s = svc("scan", "elite", 1_000_000);
	const r = await s.remember({ term: "long", kind: "note", text: "key is sk-ant-api03-abcdefabcdefabcdefabcdef" });
	assert.equal(r.ok, false);
	const { hits } = await s.recall("", "both", 10);
	assert.equal(hits.length, 0, "nothing was persisted");
});

test("short-term memory decays out of the injection after its ttl", async () => {
	const t0 = 2_000_000;
	await svc("decay", "elite", t0).remember({ term: "short", kind: "note", text: "prod db read-only today", ttlHours: 1 });
	const soon = await svc("decay", "elite", t0 + 10_000).buildInjection();
	assert.match(soon, /prod db read-only today/);
	const later = await svc("decay", "elite", t0 + 2 * H).buildInjection();
	assert.ok(!later.includes("prod db read-only today"), "expired short-term is gone from context");
});

test("forget removes a memory across tiers", async () => {
	const s = svc("forget", "elite", 1_000_000);
	const r = await s.remember({ term: "long", kind: "note", text: "temporary fact" });
	assert.ok(r.ok);
	const removed = await s.forget(r.ok ? r.entry.id : "");
	assert.equal(removed.removed, 1);
	assert.equal((await s.recall("temporary", "both", 10)).hits.length, 0);
});

test("shared long-term memory is visible to every persona; private memory is not", async () => {
	const now = 1_000_000;
	await svc("shared", "elite", now).remember({ term: "long", kind: "convention", text: "user is on Windows", toShared: true });
	await svc("shared", "elite", now).remember({ term: "long", kind: "note", text: "elite-only tactic" });

	const eliteSees = (await svc("shared", "elite", now).recall("", "both", 20)).hits.map((e) => e.text);
	assert.ok(eliteSees.includes("user is on Windows"));
	assert.ok(eliteSees.includes("elite-only tactic"));

	const devSees = (await svc("shared", "dev", now).recall("", "both", 20)).hits.map((e) => e.text);
	assert.ok(devSees.includes("user is on Windows"), "dev sees shared");
	assert.ok(!devSees.includes("elite-only tactic"), "dev does not see elite's private memory");
});

test("backlog add / list (persona view) / take / done", async () => {
	const now = 1_000_000;
	const s = svc("backlog", "elite", now);
	const add = await s.backlogAdd({ text: "revisit the SMB share" });
	assert.ok(add.ok);
	const id = add.ok ? add.entry.id : "";
	await svc("backlog", "dev", now).backlogAdd({ text: "refactor the auth module" });

	const eliteView = await s.backlogList({ all: false });
	assert.deepEqual(
		eliteView.map((e) => e.text),
		["revisit the SMB share"],
	);
	const allView = await s.backlogList({ all: true });
	assert.equal(allView.length, 2);

	assert.ok((await s.backlogSet(id, "taken")).ok);
	assert.ok((await s.backlogSet(id, "done", "handled")).ok);
	const openNow = await s.backlogList({ all: false, state: "open" });
	assert.equal(openNow.length, 0, "done item is no longer open");
});

test("buildInjection composes long-term + working-context + open backlog", async () => {
	const now = 3_000_000;
	const s = svc("inject", "elite", now);
	await s.remember({ term: "long", kind: "preference", text: "prefers verbose recon" });
	await s.remember({ term: "short", kind: "note", text: "auth refactor on branch x", ttlHours: 48 });
	await s.backlogAdd({ text: "revisit the SMB share" });
	const block = await s.buildInjection();
	assert.match(block, /<persona-mind persona="elite"/);
	assert.match(block, /prefers verbose recon/);
	assert.match(block, /auth refactor on branch x/);
	assert.match(block, /revisit the SMB share/);
});

test("promote graduates a short-term memory into durable long-term", async () => {
	const now = 1_000_000;
	const s = svc("promote", "elite", now);
	const r = await s.remember({ term: "short", kind: "note", text: "this became important", ttlHours: 12 });
	assert.ok(r.ok);
	const id = r.ok ? r.entry.id : "";
	const p = await s.promote(id);
	assert.ok(p.ok);
	// it now survives past the old short-term ttl (long-term never decays)
	const later = svc("promote", "elite", now + 100 * H);
	const hits = (await later.recall("important", "long", 10)).hits;
	assert.equal(hits.length, 1, "found in long-term after its short-term ttl would have expired");
	assert.equal((await later.recall("important", "short", 10)).hits.length, 0, "gone from short-term");
});

test("recall does not double-count a fact stored in both tiers", async () => {
	const s = svc("dedup", "elite", 1_000_000);
	await s.remember({ term: "long", kind: "note", text: "same fact both tiers" });
	await s.remember({ term: "short", kind: "note", text: "same fact both tiers" });
	const { hits, total } = await s.recall("same fact", "both", 10);
	assert.equal(total, 1, "the cross-tier duplicate is collapsed by id, not counted twice");
	assert.equal(hits.length, 1);
});

test("recall reports the total number of matches, not just the returned page", async () => {
	const now = 1_000_000;
	const s = svc("total", "elite", now);
	for (let i = 0; i < 5; i++) await s.remember({ term: "long", kind: "note", text: `smb detail ${i}` });
	const { hits, total } = await s.recall("smb", "long", 2);
	assert.equal(hits.length, 2, "page honored");
	assert.equal(total, 5, "total exposed for a withheld-count footer");
});

test("summary counts live long-term, non-expired short-term, and open backlog", async () => {
	const now = 4_000_000;
	const s = svc("summary", "elite", now);
	await s.remember({ term: "long", kind: "note", text: "durable" });
	await s.remember({ term: "short", kind: "note", text: "ephemeral", ttlHours: 24 });
	await s.backlogAdd({ text: "a lead" });
	assert.deepEqual(await s.summary(), { ltm: 1, stm: 1, backlogOpen: 1 });
});

test("dueBacklog returns open items whose wake time has passed", async () => {
	const t0 = 5_000_000;
	await svc("due", "elite", t0).backlogAdd({ text: "re-run nmap after reset", dueInSeconds: 60 });
	await svc("due", "elite", t0).backlogAdd({ text: "no timer here" });
	assert.equal((await svc("due", "elite", t0 + 30_000).dueBacklog()).length, 0, "not due yet");
	const due = await svc("due", "elite", t0 + 90_000).dueBacklog();
	assert.equal(due.length, 1);
	assert.equal(due[0]?.text, "re-run nmap after reset");
});

test("buildInjection lean mode = north-star + identity only (a delegated worker drops STM + backlog)", async () => {
	const s = svc("lean", "elite", 5_000_000);
	await s.remember({ term: "long", kind: "objective", text: "root every box on the range" });
	await s.remember({ term: "long", kind: "preference", text: "prefers verbose recon" });
	await s.remember({ term: "short", kind: "note", text: "prod db is read-only right now" });
	await s.backlogAdd({ text: "revisit the SMB share on 10.0.0.5" });

	const full = await s.buildInjection();
	assert.match(full, /root every box/, "full: north-star");
	assert.match(full, /verbose recon/, "full: identity");
	assert.match(full, /prod db is read-only/, "full: working context");
	assert.match(full, /revisit the SMB share/, "full: backlog");

	const lean = await s.buildInjection({ lean: true });
	assert.match(lean, /root every box/, "lean keeps the north-star");
	assert.match(lean, /verbose recon/, "lean keeps durable identity");
	assert.doesNotMatch(lean, /prod db is read-only/, "lean drops the supervisor's working context");
	assert.doesNotMatch(lean, /revisit the SMB share/, "lean drops the supervisor's backlog");
});
