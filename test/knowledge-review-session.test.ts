import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createKnowledgeReview } from "../src/extension/knowledge-review.ts";
import { makeMemory } from "../src/core/memory.ts";
import type { MindWorkerResult } from "../src/extension/mind-worker.ts";

function fixture() {
	const memory = makeMemory({ term: "long", kind: "note", text: "The project uses Node 18.", tags: ["runtime"], persona: "dev" }, Date.now());
	let finish!: (result: MindWorkerResult) => void;
	let current = true, fresh = true, approved = true, reserved = false, failReport = false;
	let confirmation: Promise<boolean> | undefined;
	let confirmationEntered: (() => void) | undefined;
	let applyGate: Promise<void> | undefined;
	let applyEntered: (() => void) | undefined;
	let applyError = false;
	const events: string[] = [], reports: string[] = [], notices: string[] = [];
	const ctx = { mode: "tui", hasUI: true, model: { provider: "selected", id: "current" }, isIdle: () => true, hasPendingMessages: () => false,
		ui: { input: async () => "package.json", confirm: async () => { confirmationEntered?.(); return confirmation ?? approved; }, notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionContext;
	let applies = 0;
	const plan = { ok: true as const, planId: "plan", target: "project-long" as const, fingerprint: "store", expiresAt: new Date(Date.now() + 600000).toISOString(), changes: [{ before: [memory], after: { ...memory, text: "The project requires Node 22." } }], beforeCount: 1, afterCount: 1 };
	const optimizer = { inspect: async () => ({ ok: true, entries: [memory], total: 1, fingerprint: "store" }), invalidate: () => events.push("invalidate"),
		preview: async () => { events.push("preview"); return plan; },
		apply: async (_id: string, guard?: () => void) => {
			try {
				applyEntered?.(); await applyGate;
				guard?.();
				if (applyError) throw new Error("injected persistence failure");
				applies++; events.push("apply"); return { ok: true, target: "project-long", changed: 1, receiptId: "receipt" };
			} finally { events.push("apply-cleanup"); }
		},
	};
	const mind = { inspectionScope: () => ({ persona: "dev", projectRoot: "/project" }), createOptimizer: () => optimizer };
	const review = createKnowledgeReview({ captureOwner: () => () => current, mind: () => mind as never,
		reserve: () => {
			if (reserved) return undefined;
			reserved = true;
			return { current: () => current && reserved, launched: () => events.push("launched"), settled: () => events.push("settled"), release: () => { reserved = false; events.push("release"); } };
		},
		collect: async () => ({ evidence: [{ id: "repo:1", kind: "repository", label: "package.json:1", text: 'engines.node = ">=22"', digest: "a".repeat(64) }], coverage: ["one selected file"], assertFresh: () => { if (!fresh) throw new Error("Evidence changed"); } }),
		launch: (_ctx, task) => { events.push("launch"); assert.match(task, /Node 18/); return { ok: true, model: "selected/current", thinking: "high", runId: "review-worker", completion: new Promise((resolve) => { finish = resolve; }), cancel: () => { events.push("cancel"); finish({ ok: false, status: "stopped", output: "" }); } }; },
		appendResult: (_ctx, title, body) => { if (failReport && title.endsWith("— applied")) throw new Error("native report append failed"); reports.push(body); },
	});
	const output = (status: string, fields = {}) => JSON.stringify({ findings: [{ memoryId: memory.id, status, reason: "Selected repository metadata supplies the current runtime requirement.", evidenceIds: ["repo:1"], ...fields }] });
	return { review, ctx, events, reports, notices, output, finish: (output: string) => finish({ ok: true, status: "done", output }), applies: () => applies,
		revoke: () => { current = false; }, mutate: () => { fresh = false; }, approve: (value: boolean) => { approved = value; },
		gateApproval: (gate: Promise<boolean>, entered?: () => void) => { confirmation = gate; confirmationEntered = entered; },
		gateApply: (gate: Promise<void>, entered: () => void, fail = false) => { applyGate = gate; applyEntered = entered; applyError = fail; },
		failAppliedReport: () => { failReport = true; } };
}

test("evidence review stages only and explicit approval applies through freshness guard", async () => {
	const f = fixture();
	await f.review.start(f.ctx, "project-long");
	assert.equal(f.events.includes("launch"), true);
	f.finish(f.output("correct", { replacement: "The project requires Node 22." }));
	await f.review.join();
	assert.equal(f.applies(), 0);
	assert.equal(f.review.hasPending(), true);
	assert.match(f.reports[0]!, /Node 18/);
	assert.match(f.reports[0]!, /Node 22/);
	assert.match(f.reports[0]!, /not applied/);
	f.approve(false); await f.review.apply(f.ctx); assert.equal(f.applies(), 0);
	f.approve(true); await f.review.apply(f.ctx); assert.equal(f.applies(), 1);
	assert.equal(f.review.hasPending(), false);
	assert.match(f.reports.at(-1)!, /receipt/);
});

test("changed evidence prevents staging and changed evidence after preview prevents apply", async () => {
	const f = fixture(); await f.review.start(f.ctx, "project-long");
	f.finish(f.output("correct", { replacement: "The project requires Node 22." })); await f.review.join();
	f.mutate(); await f.review.apply(f.ctx);
	assert.equal(f.applies(), 0); assert.match(f.notices.join("\n"), /Evidence changed/);
	const g = fixture(); await g.review.start(g.ctx, "project-long"); g.mutate();
	g.finish(g.output("correct", { replacement: "The project requires Node 22." })); await g.review.join();
	assert.equal(g.review.hasPending(), false); assert.equal(g.events.includes("preview"), false);
});

test("retirement is an evidence-linked recommendation, never an implicit delete or rewrite", async () => {
	const f = fixture(); await f.review.start(f.ctx, "project-long");
	f.finish(f.output("retire")); await f.review.join(); await f.review.apply(f.ctx);
	assert.equal(f.applies(), 0); assert.equal(f.events.includes("preview"), false);
	assert.match(f.reports[0]!, /nothing was deleted/);
});

test("interruptions cancel worker, discard pending data and cannot publish late output", async () => {
	const f = fixture(); await f.review.start(f.ctx, "project-long");
	f.review.interrupt(); await f.review.join();
	assert.equal(f.review.hasPending(), false); assert.equal(f.reports.length, 0);
	assert.equal(f.events.includes("cancel"), true);
	assert.equal(f.events.includes("settled"), false, "interrupted attempt is not completed");
	assert.equal(f.events.includes("release"), true);
});

test("forged citations and unavailable owners never authorize a correction", async () => {
	const f = fixture(); await f.review.start(f.ctx, "project-long");
	f.finish(f.output("correct", { replacement: "Changed value", evidenceIds: ["invented-evidence"] })); await f.review.join();
	assert.equal(f.events.includes("preview"), false); assert.equal(f.applies(), 0);
	const g = fixture(); await g.review.start(g.ctx, "project-long"); g.revoke();
	g.finish(g.output("correct", { replacement: "The project requires Node 22." })); await g.review.join();
	assert.equal(g.reports.length, 0); assert.equal(g.review.hasPending(), false);
});

test("concurrent approval cannot apply twice and interruption revokes an open approval", async () => {
	const f = fixture(); await f.review.start(f.ctx, "project-long");
	f.finish(f.output("correct", { replacement: "The project requires Node 22." })); await f.review.join();
	let accept!: (yes: boolean) => void;
	f.gateApproval(new Promise((resolve) => { accept = resolve; }));
	const first = f.review.apply(f.ctx);
	await f.review.apply(f.ctx);
	assert.equal(f.applies(), 0);
	assert.match(f.notices.join("\n"), /busy/);
	accept(true); await first;
	assert.equal(f.applies(), 1);
	const g = fixture(); await g.review.start(g.ctx, "project-long");
	g.finish(g.output("correct", { replacement: "The project requires Node 22." })); await g.review.join();
	let approve!: (yes: boolean) => void;
	g.gateApproval(new Promise((resolve) => { approve = resolve; }));
	const waiting = g.review.apply(g.ctx); g.review.interrupt(); approve(true); await waiting;
	assert.equal(g.applies(), 0); assert.equal(g.review.hasPending(), false);
});

test("join includes open approval and interrupted approval cannot admit a writer or late report", async () => {
	const f = fixture(); await f.review.start(f.ctx, "project-long");
	f.finish(f.output("correct", { replacement: "The project requires Node 22." })); await f.review.join();
	let approve!: (value: boolean) => void, entered!: () => void;
	const confirmed = new Promise<void>((resolve) => { entered = resolve; });
	f.gateApproval(new Promise((resolve) => { approve = resolve; }), entered);
	const applying = f.review.apply(f.ctx); await confirmed;
	f.review.interrupt();
	const reports = f.reports.length, notices = f.notices.length;
	let joined = false;
	const joining = f.review.join().then(() => { joined = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(joined, false, "approval is admitted lifecycle work, even when the UI ignores its abort signal");
	approve(true); await applying; await joining;
	assert.equal(f.applies(), 0);
	assert.equal(f.reports.length, reports); assert.equal(f.notices.length, notices);
});

for (const outcome of ["success", "error", "interrupt"] as const) test(`join retains the admitted apply across overlapping calls and ${outcome} cleanup`, async () => {
	const f = fixture(); await f.review.start(f.ctx, "project-long");
	f.finish(f.output("correct", { replacement: "The project requires Node 22." })); await f.review.join();
	let release!: () => void, entered!: () => void;
	const admitted = new Promise<void>((resolve) => { entered = resolve; });
	f.gateApply(new Promise((resolve) => { release = resolve; }), entered, outcome === "error");
	const applying = f.review.apply(f.ctx); await admitted;
	await f.review.apply(f.ctx); // A rejected overlap must not replace the active join promise.
	assert.match(f.notices.at(-1)!, /busy/);
	if (outcome === "interrupt") f.review.interrupt();
	const reports = f.reports.length, notices = f.notices.length;
	let joined = false;
	const joining = f.review.join().then(() => { joined = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(joined, false);
	release(); await applying; await joining;
	assert.deepEqual(f.events.slice(outcome === "success" ? -3 : -2), outcome === "success" ? ["apply-cleanup", "invalidate", "release"] : ["apply-cleanup", "release"]);
	assert.equal(f.applies(), outcome === "success" ? 1 : 0);
	if (outcome === "error") assert.match(f.notices.at(-1)!, /persistence failure.*uncertain outcome/);
	if (outcome === "interrupt") { assert.equal(f.reports.length, reports); assert.equal(f.notices.length, notices); }
	// The applying flag and maintenance lease are released on ALL terminal paths.
	if (outcome === "error") { f.approve(false); await f.review.apply(f.ctx); assert.doesNotMatch(f.notices.at(-1)!, /busy/); }
});

test("a committed correction with failed reporting is not described as an unapplied change", async () => {
	const f = fixture(); await f.review.start(f.ctx, "project-long");
	f.finish(f.output("correct", { replacement: "The project requires Node 22." })); await f.review.join();
	f.failAppliedReport(); await f.review.apply(f.ctx);
	assert.equal(f.applies(), 1);
	assert.equal(f.review.hasPending(), false);
	assert.match(f.notices.join("\n"), /Corrections were applied, but reporting failed/);
});
