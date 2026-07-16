import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { findProjectRoot, mindPaths, parsePersonaState, projectSlug, resolveScope, sanitizePersona } from "../src/core/scope.ts";

test("parsePersonaState reads lastPersona, else _default", () => {
	assert.equal(parsePersonaState(JSON.stringify({ lastPersona: "elite" })), "elite");
	assert.equal(parsePersonaState(JSON.stringify({ lastPersona: null })), "_default");
	assert.equal(parsePersonaState(JSON.stringify({})), "_default");
	assert.equal(parsePersonaState("not json"), "_default");
	assert.equal(parsePersonaState(undefined), "_default");
});

test("sanitizePersona keeps safe names and neutralizes path separators", () => {
	assert.equal(sanitizePersona("elite"), "elite");
	assert.equal(sanitizePersona("_default"), "_default");
	assert.equal(sanitizePersona("a/b c"), "a-b-c");
	assert.equal(sanitizePersona("../escape"), "escape");
	assert.equal(sanitizePersona(""), "_default");
});

test("projectSlug is a deterministic slug + 24-hex hash", () => {
	const a = projectSlug(join("some", "path", "my-proj"));
	const b = projectSlug(join("some", "path", "my-proj"));
	assert.equal(a, b);
	assert.match(a, /^my-proj-[0-9a-f]{24}$/);
});

test("findProjectRoot walks up to a .git dir, else falls back to the start", () => {
	const root = join("C:", "work", "proj");
	const deep = join(root, "src", "core");
	assert.equal(findProjectRoot(deep, (d) => d === root), root);
	assert.equal(findProjectRoot(deep, () => false), deep);
});

test("mindPaths lays out the four stores under <agentDir>/pi-persona-mind", () => {
	const p = mindPaths("/agent", "elite", "slug-abc");
	assert.ok(p.ltm.endsWith(join("pi-persona-mind", "memory", "ltm", "elite.json")));
	assert.ok(p.shared.endsWith(join("pi-persona-mind", "memory", "ltm", "_shared.json")));
	assert.ok(p.stm.endsWith(join("pi-persona-mind", "memory", "stm", "slug-abc.json")));
	assert.ok(p.backlog.endsWith(join("pi-persona-mind", "backlog", "slug-abc.json")));
});

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "ppm-scope-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("resolveScope reads pi-persona's active persona and locates the project root", async () => {
	const agentDir = join(dir, "agent");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	await writeFile(join(agentDir, "persona", "state.json"), JSON.stringify({ lastPersona: "elite" }), "utf8");
	const proj = join(dir, "proj");
	await mkdir(join(proj, ".git"), { recursive: true });
	const cwd = join(proj, "src");
	await mkdir(cwd, { recursive: true });

	const scope = resolveScope(agentDir, cwd);
	assert.equal(scope.persona, "elite");
	assert.equal(scope.projectRoot, proj);
	assert.ok(scope.paths.ltm.includes("elite.json"));
});

test("resolveScope degrades to _default when pi-persona is absent", () => {
	const scope = resolveScope(join(dir, "no-agent"), dir);
	assert.equal(scope.persona, "_default");
});
