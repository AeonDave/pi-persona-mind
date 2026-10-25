import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { findProjectRoot, mindPaths, preferredAgentDir, projectSlug, resolveScope, sanitizePersona } from "../src/core/scope.ts";
let dir: string;
before(async()=>{dir=await mkdtemp(join(tmpdir(),"ppm-scope-"));});
after(async()=>{await rm(dir,{recursive:true,force:true});});

test("scope requires an explicit live owner and never reads a remembered persona", async () => {
	const agentDir = join(dir, "live-owner");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	await writeFile(join(agentDir, "persona", "settings.json"), JSON.stringify({ version: 1, preferences: { persist: false, defaultPersona: "old-default" }, lastPersona: "another-session" }));
	assert.equal(resolveScope(agentDir, dir, { persona: "actual-owner" }).persona, "actual-owner");
	assert.equal(resolveScope(agentDir, dir, { persona: null }).persona, "_default");
	assert.notEqual(resolveScope(agentDir, dir, { persona: "_shared" }).paths.ltm, resolveScope(agentDir, dir, { persona: null }).paths.shared);
	assert.throws(() => resolveScope(agentDir, dir, undefined as never), /owner is unavailable/);
});

test("sanitizePersona keeps safe names, neutralizes separators, and reserves internal scope names", () => {
	assert.equal(sanitizePersona("elite"), "elite");
	assert.match(sanitizePersona("a/b c"), /^a-b-c-[0-9a-f]{12}$/);
	assert.match(sanitizePersona("../escape"), /^escape-[0-9a-f]{12}$/);
	// A REAL persona must never map onto an internal sentinel file: `_shared.json` is the cross-persona
	// shared tier and `_default.json` is the no-persona fallback — a persona landing on either would bleed
	// private↔shared memory or silently merge two scopes. Disambiguate with a prefix.
	assert.match(sanitizePersona("_shared"), /^persona-_shared-[0-9a-f]{12}$/);
	assert.match(sanitizePersona("_default"), /^persona-_default-[0-9a-f]{12}$/);
	// The reserve check is case-INSENSITIVE: on a case-insensitive FS `_SHARED.json` is the same physical
	// file as `_shared.json`, so a case-variant must be disambiguated off the sentinel too.
	assert.match(sanitizePersona("_SHARED"), /^persona-_SHARED-[0-9a-f]{12}$/);
	assert.match(sanitizePersona("_Default"), /^persona-_Default-[0-9a-f]{12}$/);
	// Windows reserved device names would resolve `NUL.json` to the device (silent void) on Win≤10.
	assert.match(sanitizePersona("NUL"), /^persona-NUL-[0-9a-f]{12}$/);
	assert.match(sanitizePersona("com1"), /^persona-com1-[0-9a-f]{12}$/);
});

test("sanitizePersona gives a non-Latin name a stable, unique segment (never collapses to _default)", () => {
	// Names with zero filesystem-safe chars used to sanitize to "" → DEFAULT_PERSONA, merging every
	// CJK/Cyrillic/emoji persona with each other AND with the no-persona fallback scope.
	const jp = sanitizePersona("日本語アシスタント");
	const ru = sanitizePersona("Анна");
	const emoji = sanitizePersona("🔥");
	for (const seg of [jp, ru, emoji]) {
		assert.notEqual(seg, "_default", "a real persona must never land on the no-persona sentinel");
		assert.match(seg, /^persona-[0-9a-f]{8,}$/, "a stable content-derived segment");
	}
	assert.notEqual(jp, ru);
	assert.notEqual(ru, emoji);
	assert.notEqual(jp, emoji);
	assert.equal(sanitizePersona("日本語アシスタント"), jp, "deterministic across calls");
});

test("sanitizePersona preserves ordinary safe names but hash-disambiguates lossy collisions", () => {
	assert.equal(sanitizePersona("dev-ops"), "dev-ops", "ordinary safe names keep their familiar filename");
	const lossy = sanitizePersona("dev ops");
	assert.match(lossy, /^dev-ops-[0-9a-f]{12}$/);
	assert.notEqual(lossy, sanitizePersona("dev-ops"), "a lossy spelling cannot alias the safe spelling");
	assert.equal(lossy, sanitizePersona("dev ops"), "the disambiguator is stable");

	const truncated = sanitizePersona("a".repeat(65));
	assert.match(truncated, /^a{64}-[0-9a-f]{12}$/);
});

test("sanitizePersona disambiguates Windows device basenames even when an extension follows", () => {
	const names = ["NUL", "NUL.json", "con.txt", "COM1.log", "LPT9.data"];
	const segments = names.map((name) => sanitizePersona(name));
	for (const segment of segments) {
		assert.match(segment, /^persona-/);
	}
	assert.notEqual(sanitizePersona("NUL.json"), sanitizePersona("NUL.txt"));
	assert.notEqual(sanitizePersona("con.txt"), sanitizePersona("CON.txt"));
});

test("preferredAgentDir mirrors pi-persona's raw `PI_AGENT_DIR || getAgentDir()` (no trim, avoids desync)", () => {
	assert.equal(preferredAgentDir("/explicit", { PI_AGENT_DIR: "/env" }), "/explicit");
	assert.equal(preferredAgentDir(undefined, { PI_AGENT_DIR: "/env" }), "/env");
	// pi-persona uses the raw value with a truthiness check — so does the mind, to resolve to the same dir.
	assert.equal(preferredAgentDir(undefined, { PI_AGENT_DIR: "  /padded/dir  " }), "  /padded/dir  ");
	assert.equal(preferredAgentDir(undefined, { PI_AGENT_DIR: "" }), undefined);
	assert.equal(preferredAgentDir(undefined, {}), undefined);
});

test("projectSlug is a deterministic slug + 24-hex hash", () => {
	const a = projectSlug(join("some", "path", "my-proj"));
	const b = projectSlug(join("some", "path", "my-proj"));
	assert.equal(a, b);
	assert.match(a, /^my-proj-[0-9a-f]{24}$/);
});

test("projectSlug caches successful default canonicalization but leaves injected seams uncached", async () => {
	const project = join(dir, "canonical-cache-project");
	await mkdir(project, { recursive: true });
	const original = realpathSync.native;
	let calls = 0;
	realpathSync.native = ((path: string) => {
		calls++;
		return original(path);
	}) as typeof realpathSync.native;
	try {
		const first = projectSlug(project);
		const second = projectSlug(project);
		assert.equal(first, second);
		assert.equal(calls, 1, "the successful default canonical path is reused");
	} finally {
		realpathSync.native = original;
	}

	let seamCalls = 0;
	const seam = (path: string): string => {
		seamCalls++;
		return path;
	};
	projectSlug(project, { realpath: seam });
	projectSlug(project, { realpath: seam });
	assert.equal(seamCalls, 2, "injected realpath seams remain observable");
});

test("projectSlug canonicalizes realpath aliases and Windows case through testable seams", () => {
	const first = projectSlug("C:\\work\\alias\\project", {
		realpath: () => "C:\\Work\\Project",
		platform: "win32",
	});
	const second = projectSlug("c:\\WORK\\PROJECT", {
		realpath: () => "c:\\work\\project",
		platform: "win32",
	});
	assert.equal(first, second, "junction/case aliases map to one project identity");
});

test("findProjectRoot walks up to a .git dir, else falls back to the start", () => {
	const root = join("C:", "work", "proj");
	const deep = join(root, "src", "core");
	assert.equal(findProjectRoot(deep, (d) => d === root), root);
	assert.equal(findProjectRoot(deep, () => false), deep);
});

test("findProjectRoot never treats the home directory as a git project root", () => {
	const home = join("C:", "Users", "novad");
	const nested = join(home, "Downloads", "scratch");
	assert.equal(
		findProjectRoot(nested, (d) => d === home, { homedir: home }),
		nested,
		"a git-initialized home must not collapse every descendant into one STM/backlog",
	);
	assert.equal(findProjectRoot(home, (d) => d === home, { homedir: home }), home);
});

test("resolveScope marks the home directory itself as an isolated workspace", async () => {
	const home = join(dir, "fake-home");
	await mkdir(home, { recursive: true });
	const scope = resolveScope(join(dir, "home-agent"), home, { persona: null, homedir: home });
	assert.equal(scope.homeWorkspace, true);
	const proj = join(dir, "real-proj");
	await mkdir(join(proj, ".git"), { recursive: true });
	const real = resolveScope(join(dir, "home-agent"), proj, { persona: null, homedir: home });
	assert.equal(real.homeWorkspace, undefined);
});

test("mindPaths lays out the five stores under <agentDir>/persona-mind", () => {
	const p = mindPaths("/agent", "elite", "slug-abc");
	// Whole-path equality, not a suffix: `pi-persona-mind/...` also ends with `persona-mind/...`,
	// so a suffix check could not tell the current root from the root it superseded.
	const base = join("/agent", "persona-mind");
	assert.equal(p.ltm, join(base, "memory", "ltm", "elite.json"));
	assert.equal(p.shared, join(base, "memory", "ltm", "_shared.json"));
	assert.equal(p.projectLtm, join(base, "memory", "project", "slug-abc.json"));
	assert.equal(p.stm, join(base, "memory", "stm", "slug-abc.json"));
	assert.equal(p.backlog, join(base, "backlog", "slug-abc.json"));
});
