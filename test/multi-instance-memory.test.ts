import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolveScope } from "../src/core/scope.ts";
import { MindService } from "../src/core/service.ts";
import type { MemoryEntry } from "../src/core/memory.ts";

const fixture = fileURLToPath(new URL("./fixtures/memory-process.ts", import.meta.url));

interface ProcessRequest {
	action: "remember" | "recall" | "auto-input-project-long" | "compete";
	agentDir: string;
	workspace: string;
	persona: string;
	remember?: { term: "long"; kind: "note"; text: string; scope?: "project" | "persona" | "shared" };
	query?: string;
	readScope?: "long" | "short" | "both" | "project" | "persona" | "shared";
	sourceId?: string;
	replacement?: string;
	stagedFile?: string;
	releaseFile?: string;
}

interface RunningProcess {
	child: ChildProcess;
	result: Promise<unknown>;
}

function startProcess(request: ProcessRequest): RunningProcess {
	const child = spawn(process.execPath, ["--import", "tsx", "--import", "./test/setup/hermetic-env.ts", fixture, JSON.stringify(request)], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
	const result = new Promise<unknown>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => {
			if (code !== 0) { reject(new Error(`memory process exited ${code}: ${stderr}`)); return; }
			try { resolve(JSON.parse(stdout)); }
			catch (error) { reject(new Error(`memory process returned invalid JSON: ${String(error)}; stderr=${stderr}; stdout=${stdout}`)); }
		});
	});
	return { child, result };
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		try { await access(path); return; }
		catch { if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`); }
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

function stop(children: readonly RunningProcess[]): void {
	for (const item of children) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill();
}

async function fixtureScope(root: string): Promise<{ agentDir: string; workspace: string }> {
	const agentDir = join(root, "agent");
	const workspace = join(root, "repo");
	await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(workspace, { recursive: true })]);
	return { agentDir, workspace };
}

test("separate processes serialize distinct project-long remembers without lost writes", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "mind-multiprocess-write-"));
	const children: RunningProcess[] = [];
	try {
		const paths = await fixtureScope(root);
		const facts = Array.from({ length: 8 }, (_, index) => `Concurrent repository fact ${index}: owner ${index} records an independent durable detail.`);
		for (const text of facts) children.push(startProcess({ action: "remember", ...paths, persona: "alice", remember: { term: "long", kind: "note", scope: "project", text } }));
		const results = await Promise.all(children.map((process) => process.result)) as { ok: boolean }[];
		assert.ok(results.every((result) => result.ok), "every independent process reports a committed remember");
		const scope = resolveScope(paths.agentDir, paths.workspace, { persona: "alice" });
		const store = JSON.parse(await readFile(scope.paths.projectLtm, "utf8")) as { entries: MemoryEntry[]; sequence: number };
		assert.equal(store.entries.length, facts.length);
		assert.equal(store.sequence, facts.length);
		assert.deepEqual(new Set(store.entries.map((entry) => entry.text)), new Set(facts));
		assert.ok(store.entries.every((entry) => entry.persona === "alice"));
	} finally {
		stop(children);
		await rm(root, { recursive: true, force: true });
	}
});

test("separate personas share project/shared reads, keep persona facts private, and exclude foreign project facts from automatic review", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "mind-multiprocess-scopes-"));
	const children: RunningProcess[] = [];
	try {
		const paths = await fixtureScope(root);
		const writes = [
			{ scope: "persona" as const, text: "Alice private preference: keep project notes concise." },
			{ scope: "project" as const, text: "Repository fact visible across its persona owners." },
			{ scope: "shared" as const, text: "Shared fact visible across repositories and personas." },
		];
		for (const remember of writes) {
			const process = startProcess({ action: "remember", ...paths, persona: "alice", remember: { term: "long", kind: "note", ...remember } });
			children.push(process);
			assert.equal((await process.result as { ok: boolean }).ok, true);
		}
		const bobPersona = await startProcess({ action: "recall", ...paths, persona: "bob", query: "private preference", readScope: "persona" });
		children.push(bobPersona);
		assert.deepEqual((await bobPersona.result as { hits: MemoryEntry[] }).hits, [], "another persona cannot read Alice's private long-term store");
		const bobProject = await startProcess({ action: "recall", ...paths, persona: "bob", query: "Repository fact", readScope: "project" });
		children.push(bobProject);
		assert.deepEqual((await bobProject.result as { hits: MemoryEntry[] }).hits.map((entry) => entry.text), ["Repository fact visible across its persona owners."]);
		const bobShared = await startProcess({ action: "recall", ...paths, persona: "bob", query: "Shared fact", readScope: "shared" });
		children.push(bobShared);
		assert.deepEqual((await bobShared.result as { hits: MemoryEntry[] }).hits.map((entry) => entry.text), ["Shared fact visible across repositories and personas."]);
		const bobReview = await startProcess({ action: "auto-input-project-long", ...paths, persona: "bob" });
		children.push(bobReview);
		const review = await bobReview.result as { ok: boolean; entries: MemoryEntry[]; eligibleCount: number };
		assert.equal(review.ok, true);
		assert.equal(review.entries.length, 0, "automatic project-long review filters Alice-owned records for Bob");
		assert.equal(review.eligibleCount, 0);
	} finally {
		stop(children);
		await rm(root, { recursive: true, force: true });
	}
});

test("competing process optimizers allow one commit, reject the stale plan, and retain unrelated facts", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "mind-multiprocess-optimize-"));
	const children: RunningProcess[] = [];
	try {
		const paths = await fixtureScope(root);
		for (const text of ["Repository fact to consolidate.", "Unrelated repository fact that must survive both plans."]) {
			const result = await startProcess({ action: "remember", ...paths, persona: "alice", remember: { term: "long", kind: "note", scope: "project", text } }).result as { ok: boolean };
			assert.equal(result.ok, true);
		}
		const scope = resolveScope(paths.agentDir, paths.workspace, { persona: "alice" });
		const initial = JSON.parse(await readFile(scope.paths.projectLtm, "utf8")) as { entries: MemoryEntry[] };
		const source = initial.entries.find((entry) => entry.text.startsWith("Repository fact to consolidate"));
		assert.ok(source);
		const gateDir = join(root, "gate");
		await mkdir(gateDir);
		const releaseFile = join(gateDir, "release");
		const stageFiles = [join(gateDir, "first.staged"), join(gateDir, "second.staged")];
		for (const [index, replacement] of ["Reviewed repository fact version one.", "Reviewed repository fact version two."].entries()) {
			children.push(startProcess({ action: "compete", ...paths, persona: "alice", sourceId: source.id, replacement, stagedFile: stageFiles[index]!, releaseFile }));
		}
		await Promise.all(stageFiles.map(waitForFile));
		await writeFile(releaseFile, "go", "utf8");
		const results = await Promise.all(children.map((process) => process.result)) as { applied: { ok: boolean; reason?: string }; final: { ok: boolean; entries: MemoryEntry[] } }[];
		assert.equal(results.filter((result) => result.applied.ok).length, 1, "exactly one process commits its staged fingerprint");
		const rejected = results.find((result) => !result.applied.ok);
		assert.match(rejected?.applied.reason ?? "", /changed since preview/i);
		assert.ok(results.every((result) => result.final.ok));
		const finalEntries = results[0]!.final.entries;
		assert.equal(finalEntries.length, 2);
		assert.ok(finalEntries.some((entry) => entry.text === "Unrelated repository fact that must survive both plans."));
		assert.ok(finalEntries.some((entry) => entry.text === "Reviewed repository fact version one." || entry.text === "Reviewed repository fact version two."));
	} finally {
		stop(children);
		await rm(root, { recursive: true, force: true });
	}
});
