import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { activePersona, findProjectRoot, mindPaths, parsePersonaState, personaStateFile, preferredAgentDir, projectSlug, resolveScope, sanitizePersona } from "../src/core/scope.ts";

test("parsePersonaState reads a named lastPersona, else null (absent/invalid)", () => {
	assert.equal(parsePersonaState(JSON.stringify({ lastPersona: "elite" })), "elite");
	assert.equal(parsePersonaState(JSON.stringify({ lastPersona: null })), null);
	assert.equal(parsePersonaState(JSON.stringify({ lastPersona: "   " })), null);
	assert.equal(parsePersonaState(JSON.stringify({})), null);
	assert.equal(parsePersonaState("not json"), null);
	assert.equal(parsePersonaState(undefined), null);
});

test("sanitizePersona keeps safe names, neutralizes separators, and reserves internal scope names", () => {
	assert.equal(sanitizePersona("elite"), "elite");
	assert.equal(sanitizePersona("a/b c"), "a-b-c");
	assert.equal(sanitizePersona("../escape"), "escape");
	// A REAL persona must never map onto an internal sentinel file: `_shared.json` is the cross-persona
	// shared tier and `_default.json` is the no-persona fallback — a persona landing on either would bleed
	// private↔shared memory or silently merge two scopes. Disambiguate with a prefix.
	assert.equal(sanitizePersona("_shared"), "persona-_shared");
	assert.equal(sanitizePersona("_default"), "persona-_default");
	// The reserve check is case-INSENSITIVE: on a case-insensitive FS `_SHARED.json` is the same physical
	// file as `_shared.json`, so a case-variant must be disambiguated off the sentinel too.
	assert.equal(sanitizePersona("_SHARED"), "persona-_SHARED");
	assert.equal(sanitizePersona("_Default"), "persona-_Default");
	// Windows reserved device names would resolve `NUL.json` to the device (silent void) on Win≤10.
	assert.equal(sanitizePersona("NUL"), "persona-NUL");
	assert.equal(sanitizePersona("com1"), "persona-com1");
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

test("preferredAgentDir mirrors pi-persona's raw `PI_AGENT_DIR || getAgentDir()` (no trim, avoids desync)", () => {
	assert.equal(preferredAgentDir("/explicit", { PI_AGENT_DIR: "/env" }), "/explicit");
	assert.equal(preferredAgentDir(undefined, { PI_AGENT_DIR: "/env" }), "/env");
	// pi-persona uses the raw value with a truthiness check — so does the mind, to resolve to the same dir.
	assert.equal(preferredAgentDir(undefined, { PI_AGENT_DIR: "  /padded/dir  " }), "  /padded/dir  ");
	assert.equal(preferredAgentDir(undefined, { PI_AGENT_DIR: "" }), undefined);
	assert.equal(preferredAgentDir(undefined, {}), undefined);
});

test("activePersona mirrors pi-persona's precedence: PI_PERSONA_DEFAULT > (persist ? marker : none)", async () => {
	const agentDir = join(dir, "active-agent");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	await writeFile(join(agentDir, "persona", "state.json"), JSON.stringify({ lastPersona: "ada" }), "utf8");

	// Marker only: persist defaults on, no pin → the marker persona.
	assert.equal(activePersona(agentDir, {}), "ada");
	// Env pin wins over the marker (pi-persona activates the pin, so the mind must scope to it).
	assert.equal(activePersona(agentDir, { PI_PERSONA_DEFAULT: "grace" }), "grace");
	// persist=off: pi-persona neither reads nor writes the marker, so the mind must not trust it either.
	assert.equal(activePersona(agentDir, { PI_PERSONA_PERSIST: "off" }), "_default");
	// persist=off but an env pin is set → the pin still wins.
	assert.equal(activePersona(agentDir, { PI_PERSONA_PERSIST: "off", PI_PERSONA_DEFAULT: "grace" }), "grace");
});

test("personaStateFile honors pi-persona's PI_PERSONA_STATE_FILE, else <agentDir>/persona/state.json", () => {
	assert.equal(personaStateFile("/agent", { PI_PERSONA_STATE_FILE: "/custom/state.json" }), "/custom/state.json");
	assert.equal(personaStateFile("/agent", { PI_PERSONA_STATE_FILE: "   " }), join("/agent", "persona", "state.json"));
	assert.equal(personaStateFile("/agent", {}), join("/agent", "persona", "state.json"));
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

test("resolveScope reads the marker from PI_PERSONA_STATE_FILE, and a persona named _shared never aliases the shared tier", async () => {
	// The marker lives OUTSIDE <agentDir> — exactly the desync PI_PERSONA_STATE_FILE creates in pi-persona.
	const agentDir = join(dir, "env-agent");
	const stateDir = join(dir, "elsewhere");
	await mkdir(stateDir, { recursive: true });
	const stateFile = join(stateDir, "custom-state.json");
	await writeFile(stateFile, JSON.stringify({ lastPersona: "_shared" }), "utf8");
	const proj = join(dir, "env-proj");
	await mkdir(join(proj, ".git"), { recursive: true });

	const prev = process.env.PI_PERSONA_STATE_FILE;
	process.env.PI_PERSONA_STATE_FILE = stateFile;
	try {
		const scope = resolveScope(agentDir, proj);
		// Marker was found at the override path (not <agentDir>/persona/state.json, which does not exist).
		assert.equal(scope.persona, "persona-_shared", "a persona named _shared is disambiguated off the shared tier");
		assert.ok(scope.paths.ltm.endsWith(join("ltm", "persona-_shared.json")));
		assert.ok(scope.paths.shared.endsWith(join("ltm", "_shared.json")));
		assert.notEqual(scope.paths.ltm, scope.paths.shared, "private LTM must never be the shared tier file");
	} finally {
		if (prev === undefined) delete process.env.PI_PERSONA_STATE_FILE;
		else process.env.PI_PERSONA_STATE_FILE = prev;
	}
});
