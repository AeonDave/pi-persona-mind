import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { activePersona, findProjectRoot, mindPaths, parsePersonaState, personaFromCliArgs, personaStateFile, preferredAgentDir, projectSlug, rawActivePersona, resetPersonaMarkerLatch, resolveScope, sanitizePersona } from "../src/core/scope.ts";

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

test("personaFromCliArgs mirrors Pi's string-flag forms without treating print payload as a flag", () => {
	assert.equal(personaFromCliArgs(["--persona", "quartz-supervisor"]), "quartz-supervisor");
	assert.equal(personaFromCliArgs(["--persona=first", "--persona", "second"]), "second");
	assert.equal(personaFromCliArgs(["--print", "ordinary prompt mentioning --persona"]), undefined);
	assert.equal(personaFromCliArgs(["-p", "--persona", "selected-after-empty-print"]), "selected-after-empty-print");
	assert.equal(personaFromCliArgs(["--persona", "   "]), undefined);
});

test("activePersona mirrors pi-persona's precedence: PI_PERSONA_DEFAULT > (persist ? marker : none)", async () => {
	const agentDir = join(dir, "active-agent");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	await writeFile(join(agentDir, "persona", "state.json"), JSON.stringify({ lastPersona: "ada" }), "utf8");

	// Marker only: persist defaults on, no pin → the marker persona.
	assert.equal(activePersona(agentDir, {}), "ada");
	assert.equal(rawActivePersona(agentDir, {}), "ada");
	// Env pin wins over the marker (pi-persona activates the pin, so the mind must scope to it).
	assert.equal(activePersona(agentDir, { PI_PERSONA_DEFAULT: "grace" }), "grace");
	assert.equal(rawActivePersona(agentDir, { PI_PERSONA_DEFAULT: "grace" }), "grace");
	// persist=off: pi-persona neither reads nor writes the marker, so the mind must not trust it either.
	assert.equal(activePersona(agentDir, { PI_PERSONA_PERSIST: "off" }), "_default");
	assert.equal(rawActivePersona(agentDir, { PI_PERSONA_PERSIST: "off" }), null);
	// persist=off but an env pin is set → the pin still wins.
	assert.equal(activePersona(agentDir, { PI_PERSONA_PERSIST: "off", PI_PERSONA_DEFAULT: "grace" }), "grace");
	assert.equal(rawActivePersona(agentDir, { PI_PERSONA_PERSIST: "off", PI_PERSONA_DEFAULT: "grace" }), "grace");
	// Pi's runtime `--persona` flag is the strongest selector. pi-persona deliberately does not
	// persist that one-shot choice, so the mind must not fall back to a stale marker/env pin.
	assert.equal(activePersona(agentDir, { PI_PERSONA_DEFAULT: "grace" }, "cli-choice"), "cli-choice");
	assert.equal(rawActivePersona(agentDir, { PI_PERSONA_DEFAULT: "grace" }, "cli-choice"), "cli-choice");
});

test("a mid-session persona switch outranks the session-start --persona seed and env pin", async () => {
	const agentDir = join(dir, "switch-agent");
	const statePath = join(agentDir, "persona", "state.json");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	await writeFile(statePath, JSON.stringify({ lastPersona: "ada" }), "utf8");

	// Session start: pi-persona activates the flag/pin and deliberately does NOT persist it, so the
	// marker still names whoever the LAST session left behind — a seed must outrank that stale name.
	assert.equal(activePersona(agentDir, {}, "grace"), "grace");
	assert.equal(activePersona(agentDir, { PI_PERSONA_DEFAULT: "grace" }), "grace");

	// `/persona hopper` (or the F8 cycle): pi-persona activates hopper AND rewrites the marker.
	await writeFile(statePath, JSON.stringify({ lastPersona: "hopper" }), "utf8");
	assert.equal(activePersona(agentDir, {}, "grace"), "hopper", "a live switch outranks the launch flag");
	assert.equal(activePersona(agentDir, { PI_PERSONA_DEFAULT: "grace" }), "hopper", "and outranks the env pin");
	assert.equal(rawActivePersona(agentDir, {}, "grace"), "hopper");

	// `/persona off` writes an empty marker; the seed must not resurrect the previous persona's memory.
	await writeFile(statePath, JSON.stringify({ lastPersona: null }), "utf8");
	assert.equal(activePersona(agentDir, {}, "grace"), "_default");
});

test("the FIRST mid-session switch is seen even when no marker existed at session start", async () => {
	// The modal first-run condition: pi-persona has never persisted, so `<agentDir>/persona/state.json`
	// does not exist yet. An ABSENT marker is not "no information" — it is pi-persona's explicit "nothing
	// is remembered", so it must be the baseline. Treating it as unreadable would silently adopt the very
	// first `/persona` switch as the baseline and let the launch seed win for the rest of the session.
	const agentDir = join(dir, "switch-fresh-agent");
	const statePath = join(agentDir, "persona", "state.json");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	assert.equal(activePersona(agentDir, {}, "grace"), "grace", "with no marker the launch seed is active");
	await writeFile(statePath, `${JSON.stringify({ lastPersona: "hopper" }, null, 2)}\n`, "utf8");
	assert.equal(activePersona(agentDir, {}, "grace"), "hopper", "the first switch after an absent marker still outranks the seed");
	assert.equal(activePersona(agentDir, {}, "grace"), "hopper", "and stays latched");
});

test("/persona off is honored when the session started with no marker at all", async () => {
	const agentDir = join(dir, "switch-fresh-off-agent");
	const statePath = join(agentDir, "persona", "state.json");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	assert.equal(activePersona(agentDir, { PI_PERSONA_DEFAULT: "grace" }), "grace");
	// pi-persona's writeLastPersona(file, undefined) — an explicit "no persona", not an absent marker.
	await writeFile(statePath, `${JSON.stringify({ lastPersona: null }, null, 2)}\n`, "utf8");
	assert.equal(activePersona(agentDir, { PI_PERSONA_DEFAULT: "grace" }), "_default", "the env pin must not resurrect a persona the user just switched off");
});

test("a switch TO the name the marker already held is still a switch", async () => {
	// `pi --persona grace` on top of a marker that already says `ada`, then `/persona ada`. Comparing
	// only the NAME sees no change and keeps serving grace's memory; pi-persona rewrites the marker on
	// every user gesture, so the rewrite itself is the signal.
	const agentDir = join(dir, "switch-back-agent");
	const statePath = join(agentDir, "persona", "state.json");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	await writeFile(statePath, `${JSON.stringify({ lastPersona: "ada" }, null, 2)}\n`, "utf8");
	assert.equal(activePersona(agentDir, {}, "grace"), "grace", "the stale marker does not beat the launch seed");
	await new Promise((resolve) => setTimeout(resolve, 20));
	await writeFile(statePath, `${JSON.stringify({ lastPersona: "ada" }, null, 2)}\n`, "utf8");
	assert.equal(activePersona(agentDir, {}, "grace"), "ada", "an explicit re-selection outranks the launch flag");
});

test("persist=off leaves the seed authoritative — pi-persona writes no marker to follow", async () => {
	const agentDir = join(dir, "switch-persist-off-agent");
	const statePath = join(agentDir, "persona", "state.json");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	await writeFile(statePath, JSON.stringify({ lastPersona: "ada" }), "utf8");
	assert.equal(activePersona(agentDir, { PI_PERSONA_PERSIST: "off", PI_PERSONA_DEFAULT: "grace" }), "grace");
	await writeFile(statePath, JSON.stringify({ lastPersona: "hopper" }), "utf8");
	assert.equal(activePersona(agentDir, { PI_PERSONA_PERSIST: "off", PI_PERSONA_DEFAULT: "grace" }), "grace");
});

test("a marker that became unreadable is not mistaken for a persona switch", async () => {
	const agentDir = join(dir, "switch-unreadable-agent");
	const statePath = join(agentDir, "persona", "state.json");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	await writeFile(statePath, JSON.stringify({ lastPersona: "ada" }), "utf8");
	assert.equal(activePersona(agentDir, {}, "grace"), "grace");
	await writeFile(statePath, JSON.stringify({ lastPersona: "ada", padding: "x".repeat(128 * 1024) }), "utf8");
	assert.equal(activePersona(agentDir, {}, "grace"), "grace", "absence of evidence is not evidence of a switch");
	await writeFile(statePath, "not json", "utf8");
	assert.equal(activePersona(agentDir, {}, "grace"), "grace");
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
	const scope = resolveScope(join(dir, "home-agent"), home, { homedir: home });
	assert.equal(scope.homeWorkspace, true);
	const proj = join(dir, "real-proj");
	await mkdir(join(proj, ".git"), { recursive: true });
	const real = resolveScope(join(dir, "home-agent"), proj, { homedir: home });
	assert.equal(real.homeWorkspace, undefined);
});

test("resetPersonaMarkerLatch starts a fresh session's seed without inheriting the prior switch", async () => {
	const agentDir = join(dir, "latch-reset-agent");
	const statePath = join(agentDir, "persona", "state.json");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	await writeFile(statePath, JSON.stringify({ lastPersona: "ada" }), "utf8");
	assert.equal(activePersona(agentDir, {}, "grace"), "grace");
	await writeFile(statePath, JSON.stringify({ lastPersona: "hopper" }), "utf8");
	assert.equal(activePersona(agentDir, {}, "grace"), "hopper");
	resetPersonaMarkerLatch();
	assert.equal(activePersona(agentDir, {}, "grace"), "grace", "a new Pi session must not inherit the previous session's switch latch");
});

test("mindPaths lays out the four stores under <agentDir>/persona-mind", () => {
	const p = mindPaths("/agent", "elite", "slug-abc");
	// Whole-path equality, not a suffix: `pi-persona-mind/...` also ends with `persona-mind/...`,
	// so a suffix check could not tell the current root from the root it superseded.
	const base = join("/agent", "persona-mind");
	assert.equal(p.ltm, join(base, "memory", "ltm", "elite.json"));
	assert.equal(p.shared, join(base, "memory", "ltm", "_shared.json"));
	assert.equal(p.stm, join(base, "memory", "stm", "slug-abc.json"));
	assert.equal(p.backlog, join(base, "backlog", "slug-abc.json"));
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

test("resolveScope accepts the live CLI persona independently of the persisted marker", async () => {
	const agentDir = join(dir, "cli-persona-agent");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	await writeFile(join(agentDir, "persona", "state.json"), JSON.stringify({ lastPersona: "stale-marker" }), "utf8");
	const scope = resolveScope(agentDir, dir, { cliPersona: "quartz supervisor" });
	assert.match(scope.persona, /^quartz-supervisor-[0-9a-f]{12}$/);
	assert.ok(scope.paths.ltm.endsWith(`${scope.persona}.json`));
	assert.ok(!scope.paths.ltm.endsWith("stale-marker.json"));
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
		assert.match(scope.persona, /^persona-_shared-[0-9a-f]{12}$/, "a persona named _shared is disambiguated off the shared tier");
		assert.ok(scope.paths.ltm.endsWith(join("ltm", `${scope.persona}.json`)));
		assert.ok(scope.paths.shared.endsWith(join("ltm", "_shared.json")));
		assert.notEqual(scope.paths.ltm, scope.paths.shared, "private LTM must never be the shared tier file");
	} finally {
		if (prev === undefined) delete process.env.PI_PERSONA_STATE_FILE;
		else process.env.PI_PERSONA_STATE_FILE = prev;
	}
});

test("resolveScope ignores an oversized persona marker without reading it unbounded", async () => {
	const agentDir = join(dir, "oversized-marker-agent");
	await mkdir(join(agentDir, "persona"), { recursive: true });
	await writeFile(
		join(agentDir, "persona", "state.json"),
		JSON.stringify({ lastPersona: "elite", padding: "x".repeat(128 * 1024) }),
		"utf8",
	);
	const projectRoot = join(dir, "oversized-marker-project");
	await mkdir(join(projectRoot, ".git"), { recursive: true });

	const scope = resolveScope(agentDir, projectRoot);
	assert.equal(scope.persona, "_default");
});
