import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mindPaths } from "../src/core/scope.ts";
import { MindService } from "../src/core/service.ts";
import { estimateTokens } from "../src/core/context-budget.ts";

async function fixture(run: (service: (project: string, persona?: string, hours?: number) => MindService) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "mind-project-"));
	try {
		await run((project, persona = "dev", hours = 0) => new MindService({ persona, slug: project,
			projectRoot: join(dir, project), paths: mindPaths(dir, persona, project) },
			{ now: () => Date.parse("2026-10-25T12:00:00Z") + hours * 3_600_000 }));
	} finally { await rm(dir, { recursive: true, force: true }); }
}

test("durable project facts survive weeks, stay in their repository and are visible to its colleagues", async () => fixture(async (service) => {
	const saved = await service("a").remember({ term: "long", scope: "project", kind: "rationale", text: "Repository A chose PostgreSQL for transactional migrations." });
	assert.ok(saved.ok);
	assert.equal(saved.entry.persona, "dev");
	assert.equal(saved.entry.expiresAt, undefined);
	assert.equal((await service("a", "dev", 720).recall("PostgreSQL", "long", 8)).hits.length, 1);
	assert.equal((await service("a", "reviewer").recall("PostgreSQL", "long", 8)).hits.length, 1);
	assert.equal((await service("b").recall("PostgreSQL", "both", 8)).hits.length, 0);
	assert.match(await service("a").buildInjection(), /PostgreSQL/);
	assert.doesNotMatch(await service("a").buildInjection({ lean: true }), /PostgreSQL/);
	const read = await service("a").readMemory(saved.entry.id, "project");
	assert.ok(read.ok);
	assert.equal(read.entries[0]?.target, "project-long");
}));

test("promotion retains project scope by default and refuses a colleague's source", async () => fixture(async (service) => {
	const note = await service("a").remember({ term: "short", kind: "note", text: "Project deploys only after migration validation." });
	assert.ok(note.ok);
	assert.equal((await service("a", "reviewer").promote(note.entry.id)).ok, false);
	const result = await service("a").promote(note.entry.id);
	assert.ok(result.ok);
	assert.equal(result.entry.persona, "dev");
	assert.equal((await service("a", "dev", 720).recall("migration", "long", 8)).hits.length, 1);
	assert.equal((await service("a").recall("", "short", 8)).hits.length, 0);
	assert.equal((await service("b").recall("migration", "both", 8)).hits.length, 0);
}));

test("explicit persona promotion is cross-project and workspace reset preserves project knowledge", async () => fixture(async (service) => {
	const note = await service("a").remember({ term: "short", kind: "preference", text: "User prefers concise reviews." });
	assert.ok(note.ok);
	assert.ok((await service("a").promote(note.entry.id, "persona")).ok);
	assert.equal((await service("b").recall("concise", "long", 8)).hits.length, 1);
	assert.ok((await service("a").remember({ term: "long", scope: "project", kind: "note", text: "Project uses PostgreSQL." })).ok);
	assert.ok((await service("a").resetWorkspace()).ok);
	assert.equal((await service("a").recall("PostgreSQL", "long", 8)).hits.length, 1);
}));

test("project optimizer refuses foreign owners and forgetting can be scoped", async () => fixture(async (service) => {
	const saved = await service("a").remember({ term: "long", scope: "project", kind: "note", text: "Project uses PostgreSQL." });
	assert.ok(saved.ok);
	const colleague = service("a", "reviewer").createOptimizer();
	const inspection = await colleague.inspect("project-long");
	assert.ok(inspection.ok);
	assert.equal((await colleague.preview({ target: "project-long", fingerprint: inspection.fingerprint,
		operations: [{ sourceIds: [saved.entry.id], kind: "note", text: "Project uses PostgreSQL for storage." }] })).ok, false);
	assert.ok((await service("a").remember({ term: "long", kind: "note", text: "Project uses PostgreSQL." })).ok);
	assert.equal((await service("a").forget(saved.entry.id, "project")).removed, 1);
	assert.equal((await service("a").recall("PostgreSQL", "persona", 8)).hits.length, 1);
}));

test("all durable and working tiers share one token estimate with session context", async () => fixture(async (service) => {
	const mind = service("a");
	for (let i = 0; i < 16; i++) {
		assert.ok((await mind.remember({ term: "long", scope: i % 2 ? "project" : "persona", kind: "note", text: `Knowledge ${i}: ${"database behavior ".repeat(80)}` })).ok);
	}
	const sessionBlock = `[Session notes reference data]\n<session-notes>\n${"local context ".repeat(80)}\n</session-notes>`;
	const block = await mind.buildInjection({ query: "database", fixedBlocks: [`${sessionBlock}\n\n`] });
	assert.ok(estimateTokens(`${block}\n\n${sessionBlock}`) <= 2400);
	assert.match(block, /not shown/);
}));
