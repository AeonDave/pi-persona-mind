/** Actual Pi 1.5.2 branch/shutdown lifecycle, real stores and deterministic persistence gates.
 * Only Persona's worker transport is an offline protocol fixture, not a real model call. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MindService } from "../src/core/service.ts";
import { createExtension } from "../src/index.ts";
import { AutoOptimizeScheduler } from "../src/extension/auto-optimize.ts";
import { OptimizeHistoryStore } from "../src/core/optimize-history.ts";
import { resolveScope } from "../src/core/scope.ts";
import type { MindWorkerResult } from "../src/extension/mind-worker.ts";
import { runtimeHarness } from "./setup/pi-runtime.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

for (const automatic of [false, true]) test(`native branch navigation cancels held ${automatic ? "automatic" : "explicit"} consolidation in the same session`, { timeout: 20_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mind-branch-lifecycle-"));
	const admitted = deferred<string>(), retry = deferred<string>();
	const completion = deferred<MindWorkerResult>(), retryCompletion = deferred<MindWorkerResult>();
	let cancellations = 0, requests = 0;
	let scheduler!: AutoOptimizeScheduler;
	const activate = AutoOptimizeScheduler.prototype.activate;
	t.mock.method(AutoOptimizeScheduler.prototype, "activate", function(this: AutoOptimizeScheduler, ...args: Parameters<typeof activate>) { scheduler = this; return activate.apply(this, args); });
	const realNow = Date.now;
	let clockOffset = 0;
	Date.now = () => realNow() + clockOffset;
	const worker: ExtensionFactory = (pi) => {
		pi.events.on("pi-persona:mind-worker:v1", (raw: unknown) => {
			const request = raw as { task: string; respond(value: unknown): void };
			requests++;
			request.respond({ ok: true, runId: `held-consolidation-${requests}`, model: "offline/current", thinking: "off", completion: requests === 1 ? completion.promise : retryCompletion.promise, cancel: () => { cancellations++; } });
			(requests === 1 ? admitted : retry).resolve(request.task);
		});
	};
	const h = await runtimeHarness(root, (pi) => createExtension(pi), [worker]);
	try {
		await h.bind();
		const manager = h.session.sessionManager;
		const scope = resolveScope(h.agentDir, h.cwd, { persona: null });
		const mind = new MindService(scope);
		for (const text of ["Keep release evidence concise.", "Release evidence includes exact test exits."]) await mind.remember({ term: "long", scope: "persona", kind: "convention", text });
		const before = await readFile(scope.paths.ltm, "utf8");
		const destination = manager.appendCustomEntry("branch-destination", {});
		manager.appendCustomEntry("branch-origin", {});
		const id = manager.getSessionId(), file = manager.getSessionFile();
		if (automatic) {
			// Use the actual tool-result and settled hooks without spending main-model tokens.
			await h.session.extensionRunner!.emitToolResult({ type: "tool_result", toolName: "memory", toolCallId: "save", input: { action: "remember", term: "long", scope: "persona" }, content: [], details: { ok: true }, isError: false });
			await h.session.extensionRunner!.emit({ type: "agent_settled", aborted: false });
		} else await h.session.prompt("/mind optimize persona");
		const task = await admitted.promise;
		const payload = JSON.parse(task.split("\n").at(-1)!) as { entries: { id: string }[] };
		const reports = manager.getEntries().length, notifications = h.notifications.length;
		const navigated = await h.session.navigateTree(destination);
		assert.equal(navigated.cancelled, false);
		assert.equal(h.session.sessionManager, manager);
		assert.equal(manager.getSessionId(), id);
		assert.equal(manager.getSessionFile(), file);
		assert.equal(manager.getLeafId(), destination);
		assert.equal(cancellations, 1, "branch event must cancel the held worker even though native owner identity is unchanged");
		completion.resolve({ ok: true, status: "done", output: JSON.stringify({ operations: [{ sourceIds: payload.entries.map(({ id }) => id), kind: "convention", text: "Keep concise release evidence with exact test exits." }] }) });
		// Join the old task BEFORE shutdown; shutdown must not mask a branch invalidation failure.
		await scheduler.join();
		assert.equal(await readFile(scope.paths.ltm, "utf8"), before);
		assert.equal(manager.getEntries().length, reports, "no late audit/result/attempt is appended on the destination branch");
		assert.equal(h.notifications.length, notifications, "no stale report/toast");
		clockOffset = 5 * 60_000 + 1;
		await h.session.extensionRunner!.emit({ type: "agent_settled", aborted: false });
		if (automatic) {
			const freshTask = await retry.promise;
			assert.equal(requests, 2, "documented settled+cooldown retry starts a NEW worker");
			assert.equal(await readFile(scope.paths.ltm, "utf8"), before, "old proposal was not resurrected by retry admission");
			assert.match(freshTask, /read-only memory-consolidation reviewer/);
			retryCompletion.resolve({ ok: true, status: "done", output: '{"operations":[]}' });
			await scheduler.join();
			assert.equal(await readFile(scope.paths.ltm, "utf8"), before, "fresh reviewed no-op, not old replacement, decides the retry outcome");
		} else {
			assert.equal(requests, 1);
			assert.doesNotMatch(scheduler.status(), /interrupted review pending/);
		}
	} finally {
		completion.resolve({ ok: false, status: "stopped", output: "" }); retryCompletion.resolve({ ok: false, status: "stopped", output: "" });
		await h.dispose(); Date.now = realNow; t.mock.restoreAll(); await rm(root, { recursive: true, force: true });
	}
});

for (const scenario of ["applied", "rejected", "finalization-error"] as const) test(`native shutdown joins approved review persistence and ${scenario} cleanup`, { timeout: 20_000 }, async (t) => {
	const state = scenario === "rejected" ? "rejected" : "applied";
	const root = await mkdtemp(join(tmpdir(), "mind-review-join-"));
	const proposal = deferred<void>(), reached = deferred<void>(), release = deferred<void>();
	const worker: ExtensionFactory = (pi) => {
		pi.events.on("pi-persona:mind-worker:v1", (raw: unknown) => {
			const request = raw as { task: string; respond(value: unknown): void };
			const data = JSON.parse(request.task.split("<quoted-review-data>")[1]!.split("</quoted-review-data>")[0]!) as { memories: { id: string }[]; evidence: { id: string }[] };
			request.respond({ ok: true, runId: "knowledge-review", model: "offline/current", thinking: "off", cancel() {}, completion: Promise.resolve({ ok: true, status: "done", output: JSON.stringify({ findings: [{ memoryId: data.memories[0]!.id, status: "correct", reason: "The supplied current user-role evidence specifies Node 22.", evidenceIds: [data.evidence[0]!.id], replacement: "The project requires Node 22." }] }) }) });
		});
	};
	const h = await runtimeHarness(root, (pi) => createExtension(pi), [worker]);
	const originalSettle = OptimizeHistoryStore.prototype.settle;
	const originalPrepare = OptimizeHistoryStore.prototype.prepare;
	let active = false;
	try {
		h.ui.input = async () => "";
		h.ui.confirm = async () => true;
		const notify = h.ui.notify;
		h.ui.notify = (message, kind) => { notify(message, kind); if (message.includes("knowledge review ready")) proposal.resolve(); };
		await h.session.bindExtensions({ mode: "tui", uiContext: h.ui });
		const scope = resolveScope(h.agentDir, h.cwd, { persona: null });
		const mind = new MindService(scope);
		await mind.remember({ term: "long", scope: "persona", kind: "note", text: "The project requires Node 18." });
		h.session.sessionManager.appendMessage({ role: "user", content: "The project requires Node 22.", timestamp: Date.now() });
		await h.session.prompt("/mind review persona");
		await Promise.race([proposal.promise, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error(`proposal missing: ${h.notifications.join(" | ")}`)), 3_000); timer.unref(); })]);
		// Gate the real history writer: after commit for success, after guarded refusal for cleanup.
		if (state === "rejected") t.mock.method(OptimizeHistoryStore.prototype, "prepare", async function(this: OptimizeHistoryStore, ...args: Parameters<typeof originalPrepare>) {
			await originalPrepare.apply(this, args);
			await h.session.navigateTree(h.session.sessionManager.getBranch().find((e) => e.type === "message")!.id);
		});
		t.mock.method(OptimizeHistoryStore.prototype, "settle", async function(this: OptimizeHistoryStore, ...args: Parameters<typeof originalSettle>) {
			if (args[1] === state) { active = true; reached.resolve(); await release.promise; }
			try {
				if (scenario === "finalization-error") throw new Error("injected history finalization IO failure after confirmed commit");
				await originalSettle.apply(this, args);
			} finally { active = false; }
		});
		const applying = h.session.prompt("/mind review apply");
		await Promise.race([reached.promise, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error(`persistence gate missing: ${h.notifications.join(" | ")}`)), 3_000); timer.unref(); })]);
		const notifications = h.notifications.length;
		const entries = h.session.sessionManager.getEntries().length;
		let shutdownSettled = false;
		const shutdown = h.session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" }).then(() => { shutdownSettled = true; });
		// One event-loop checkpoint is not a delay-based race: the gate remains closed until this test releases it.
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			assert.equal(shutdownSettled, false, "shutdown must not settle while admitted history persistence is gated");
			assert.equal(active, true);
		} finally { release.resolve(); await applying; await shutdown; }
		assert.equal(active, false);
		assert.equal(h.notifications.length, notifications, "no late approval result/toast after branch revocation/shutdown");
		assert.equal(h.session.sessionManager.getEntries().length, entries);
		const history = await mind.createOptimizer().history("persona");
		assert.equal(history.ok, true);
		if (history.ok) assert.equal(history.receipts[0]!.state, scenario === "finalization-error" ? "prepared" : state);
		const recalled = await mind.recall("Node", "persona", 5);
		assert.equal(recalled.hits[0]!.text, state === "applied" ? "The project requires Node 22." : "The project requires Node 18.");
	} finally { release.resolve(); t.mock.restoreAll(); await h.dispose(); await rm(root, { recursive: true, force: true }); }
});
