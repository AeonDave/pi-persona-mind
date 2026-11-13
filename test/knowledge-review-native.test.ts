import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MindService } from "../src/core/service.ts";
import { resolveScope } from "../src/core/scope.ts";
import { createKnowledgeReview } from "../src/extension/knowledge-review.ts";

test("native evidence review stages, refuses changed files, then applies and supports guarded undo", async () => {
	const root = await mkdtemp(join(tmpdir(), "mind-knowledge-native-"));
	try {
		const packagePath = join(root, "package.json");
		await writeFile(packagePath, '{"engines":{"node":">=22"}}\n');
		const manager = SessionManager.inMemory(root);
		const scope = resolveScope(join(root, "profile"), root, { persona: "dev" });
		const mind = new MindService(scope);
		const newOptimizer = mind.createOptimizer.bind(mind);
		let stagedPlanId = "";
		mind.createOptimizer = () => {
			const optimizer = newOptimizer();
			const preview = optimizer.preview.bind(optimizer);
			optimizer.preview = async (input) => { const result = await preview(input); if (result.ok) stagedPlanId = result.planId; return result; };
			return optimizer;
		};
		const saved = await mind.remember({ term: "long", scope: "project", kind: "convention", text: "The project requires Node 18.", tags: ["runtime"] });
		assert.equal(saved.ok, true); if (!saved.ok) return;
		const notices: string[] = [];
		const ctx = { cwd: root, sessionManager: manager, mode: "tui", hasUI: true, model: { provider: "offline", id: "review" }, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
			ui: { input: async () => "package.json", confirm: async () => true, notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
		const review = createKnowledgeReview({ captureOwner: () => () => true, mind: () => mind,
			reserve: () => ({ current: () => true, launched() {}, settled() {}, release() {} }),
			appendResult: (_ctx, title, body) => { manager.appendCustomEntry("review-test", { title, body }); },
			launch: (_ctx, task) => {
				const data = JSON.parse(task.split("<quoted-review-data>")[1]!.split("</quoted-review-data>")[0]!) as { memories: { id: string }[]; evidence: { id: string; kind: string; text: string }[] };
				const evidence = data.evidence.find((item) => item.kind === "repository")!;
				assert.match(evidence.text, />=22/);
				const output = JSON.stringify({ findings: [{ memoryId: data.memories[0]!.id, status: "correct", reason: "The selected package.json engine requirement contradicts the old record.", evidenceIds: [evidence.id], replacement: "The project requires Node 22 or newer." }] });
				return { ok: true, runId: "offline-review", model: "offline/review", thinking: "off", cancel() {}, completion: Promise.resolve({ ok: true, status: "done", output }) };
			},
		});
		const before = await readFile(scope.paths.projectLtm, "utf8");
		await review.start(ctx, "project-long", saved.entry.id); await review.join();
		assert.equal(review.hasPending(), true, notices.join("\n"));
		assert.equal(await readFile(scope.paths.projectLtm, "utf8"), before, "review is proposal-only");
		assert.ok(stagedPlanId);
		assert.equal((await newOptimizer().apply(stagedPlanId)).ok, false, "generic optimizer cache cannot bypass review evidence/approval");
		assert.equal(await readFile(scope.paths.projectLtm, "utf8"), before, "generic apply left the review unapplied");
		await writeFile(packagePath, '{"engines":{"node":">=24"}}\n');
		await review.apply(ctx);
		assert.equal(await readFile(scope.paths.projectLtm, "utf8"), before, "changed source prevents apply");
		assert.match(notices.join("\n"), /changed|revoked/i);
		review.discard(ctx);
		await writeFile(packagePath, '{"engines":{"node":">=22"}}\n');
		await review.start(ctx, "project-long", saved.entry.id); await review.join(); await review.apply(ctx);
		assert.equal(review.hasPending(), false, notices.join("\n"));
		const after = await mind.recall("Node", "project", 5);
		assert.equal(after.hits.length, 1);
		assert.equal(after.hits[0]!.text, "The project requires Node 22 or newer.");
		assert.match(after.hits[0]!.source ?? "", /knowledge-review/);
		assert.ok(after.hits[0]!.derivedFrom?.includes(saved.entry.id));
		const optimizer = mind.createOptimizer();
		const history = await optimizer.history("project-long");
		assert.equal(history.ok, true); if (!history.ok) return;
		assert.equal(history.receipts.length, 1);
		const undone = await optimizer.undo(history.receipts[0]!.receiptId, "project-long");
		assert.equal(undone.ok, true);
		assert.equal((await mind.recall("Node", "project", 5)).hits[0]!.text, "The project requires Node 18.");
	} finally { await rm(root, { recursive: true, force: true }); }
});
