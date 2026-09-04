/**
 * Scope resolution — where a mind's stores live, and which persona owns the view.
 *
 * The ONE coupling to pi-persona: the active persona is read (best-effort, read-only) from
 * pi-persona's own marker at `<agentDir>/persona/state.json` (`{ lastPersona }`). When pi-persona
 * is absent or no persona is selected, everything degrades to a `_default` scope, so the extension
 * is fully usable on its own.
 *
 * Layout under `<agentDir>/persona-mind/`:
 *   memory/ltm/<persona>.json   long-term, per persona (identity)
 *   memory/ltm/_shared.json     long-term, shared across personas
 *   memory/stm/<project>.json   short-term, per project (decays)
 *   backlog/<project>.json      backlog, per project
 */

import { closeSync, existsSync, fstatSync, openSync, realpathSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";

export const DEFAULT_PERSONA = "_default";
export const SHARED_SCOPE = "_shared";

export interface ScopePaths {
	/** Long-term memory for the active persona. */
	ltm: string;
	/** Long-term memory shared across personas. */
	shared: string;
	/** Short-term memory for the current project. */
	stm: string;
	/** Backlog for the current project. */
	backlog: string;
}

export interface Scope {
	persona: string;
	projectRoot: string;
	slug: string;
	paths: ScopePaths;
	/** True when the resolved project is the user's home directory (no real git workspace). */
	homeWorkspace?: true;
}

/** A marker reading: whether pi-persona's state file could be understood at all, the persona it named,
 *  and an identity stamp for the bytes behind it. Three states, not two:
 *    - ABSENT      — pi-persona has persisted nothing. That IS understandable information ("no persona
 *                    is remembered"), so it is readable with a null persona and an empty stamp. It is
 *                    also the modal first-run condition, so mistaking it for "unreadable" would swallow
 *                    the first mid-session switch of every fresh install.
 *    - UNREADABLE  — oversized/torn/unstattable. No information at all; never evidence of a switch.
 *    - READABLE    — a parsed marker; `persona: null` is an explicit "no persona" (`/persona off`).
 *  The stamp exists because pi-persona rewrites the marker on EVERY user gesture, including a
 *  re-selection of the name it already held — a change the name alone cannot show. */
interface MarkerReading {
	readable: boolean;
	persona: string | null;
	/** mtime/size/inode identity of the marker file; "" when it is absent or unreadable. */
	stamp: string;
}

function readPersonaState(raw: string | undefined): MarkerReading {
	if (raw === undefined) return { readable: false, persona: null, stamp: "" };
	try {
		const parsed = JSON.parse(raw) as { lastPersona?: unknown };
		return { readable: true, persona: typeof parsed.lastPersona === "string" && parsed.lastPersona.trim() ? parsed.lastPersona : null, stamp: "" };
	} catch {
		return { readable: false, persona: null, stamp: "" };
	}
}

/** Read the marker from disk, keeping "absent" distinct from "unreadable" and carrying the stamp. */
function readMarker(path: string): MarkerReading {
	const read = tryRead(path);
	if (read.kind === "absent") return { readable: true, persona: null, stamp: "" };
	if (read.kind === "unreadable") return { readable: false, persona: null, stamp: "" };
	return { ...readPersonaState(read.raw), stamp: read.stamp };
}

/** Read pi-persona's `{ lastPersona }` marker; the selected persona NAME, or null when none is
 *  selected / the marker is missing or invalid (the caller maps null to the {@link DEFAULT_PERSONA}
 *  scope). Kept distinct from a persona literally *named* `_default`, which must not merge with it. */
export function parsePersonaState(raw: string | undefined): string | null {
	return readPersonaState(raw).persona;
}

/** The internal scope names a real persona must never be allowed to occupy (they back the shared
 *  tier and the no-persona fallback; a collision would bleed private↔shared memory or merge scopes).
 *  Compared case-insensitively — a case-insensitive filesystem aliases `_SHARED.json` to `_shared.json`. */
const RESERVED_SCOPES: ReadonlySet<string> = new Set([DEFAULT_PERSONA, SHARED_SCOPE]);

/** Windows reserved device base names: `NUL.json`/`CON.json`/… resolve to the device (a silent
 *  write-to-void) in legacy Win32 path resolution, so a persona named after one must not be a filename. */
const WIN_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_PERSONA_STATE_BYTES = 64 * 1024;
const MAX_CANONICAL_CACHE_ENTRIES = 256;
const canonicalProjectCache = new Map<string, string>();

function isReservedSegment(s: string): boolean {
	const deviceBase = s.split(".", 1)[0] ?? s;
	return RESERVED_SCOPES.has(s.toLowerCase()) || WIN_RESERVED.test(deviceBase);
}

/** A stable 12-hex content id for a persona name, used when it has no filesystem-safe characters. */
function personaHash(name: string): string {
	return createHash("sha256").update(name).digest("hex").slice(0, 12);
}

/** A filesystem-safe single path segment for a persona name (no separators, no traversal). Two hazards
 *  are guarded: a name with no safe characters (CJK/Cyrillic/emoji) would collapse to one sentinel and
 *  merge every such persona (and the no-persona scope) — it gets a stable content-derived segment; and a
 *  name that lands on an internal sentinel or a Windows device name is prefixed so it can never hijack
 *  that reserved store. */
export function sanitizePersona(name: string, platform: NodeJS.Platform | string = process.platform): string {
	const s = name
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 64);
	if (!s) return `persona-${personaHash(name)}`;
	const lossy = s !== name || (platform === "win32" && s !== s.toLowerCase());
	if (isReservedSegment(s)) return `persona-${s}-${personaHash(name)}`;
	return lossy ? `${s}-${personaHash(name)}` : s;
}

/**
 * Where pi-persona keeps its active-persona marker. Honors pi-persona's OWN override
 * (`PI_PERSONA_STATE_FILE`) so the two extensions never disagree about the marker's location and
 * the mind silently scopes to the wrong persona; absent it, the conventional
 * `<agentDir>/persona/state.json`. Env is injectable for tests.
 */
export function personaStateFile(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_PERSONA_STATE_FILE?.trim();
	return override ? override : join(agentDir, "persona", "state.json");
}

/**
 * The agent dir the mind should use, mirroring pi-persona's own `PI_AGENT_DIR || getAgentDir()`
 * precedence so both extensions co-locate their data: an explicit override (tests) wins, else
 * `PI_AGENT_DIR`, else `undefined` — signalling the caller to fall back to Pi's `getAgentDir()`
 * (kept lazy so tests that inject a dir never invoke the SDK). Env is injectable for tests.
 */
export function preferredAgentDir(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (explicit !== undefined) return explicit;
	// Raw value with a truthiness check, exactly as pi-persona does (`PI_AGENT_DIR || getAgentDir()`);
	// trimming here would make the two extensions resolve different dirs for a padded value.
	const override = env.PI_AGENT_DIR;
	return override ? override : undefined;
}

/**
 * Read Pi's `--persona` string flag from raw CLI arguments without registering a duplicate flag in
 * this extension (Pi rejects duplicate declarations when pi-persona is loaded too). `-p/--print`
 * consumes its next argument, so a prompt literally equal to `--persona` is never misclassified.
 * Repeated flags follow Pi's map semantics: the last well-formed value wins.
 */
export function personaFromCliArgs(args: readonly string[]): string | undefined {
	let selected: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-p" || arg === "--print") {
			const next = args[i + 1];
			// Match Pi's parser: a normal value (or the special `---`-prefixed form) is the print
			// payload; another flag remains available to the argument loop.
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) i++;
			continue;
		}
		if (arg?.startsWith("--persona=")) {
			const value = arg.slice("--persona=".length).trim();
			if (value) selected = value;
			continue;
		}
		if (arg !== "--persona") continue;
		const value = args[i + 1];
		if (value !== undefined && !value.startsWith("-")) {
			const trimmed = value.trim();
			if (trimmed) selected = trimmed;
			i++;
		}
	}
	return selected;
}

/**
 * The persona the mind should scope to, mirroring pi-persona's own restore precedence
 * (`flag ?? defaultPersona ?? (persist ? readLastPersona() : undefined)`): the live `--persona` flag
 * wins, else the `PI_PERSONA_DEFAULT` env pin, else the on-disk marker when persistence is on
 * (`PI_PERSONA_PERSIST` ≠ "off"), else the default scope — EXCEPT that flag and pin are only
 * session-start seeds, so a marker pi-persona rewrote mid-session (`/persona <name>`, the F8 cycle,
 * `/persona off`) outranks them from that turn on. Mirroring both stages keeps the mind from injecting
 * or writing a different persona's memory than the one pi-persona actually activated.
 */
export function activePersona(agentDir: string, env: NodeJS.ProcessEnv = process.env, cliPersona?: string): string {
	const named = rawActivePersona(agentDir, env, cliPersona);
	return named ? sanitizePersona(named) : DEFAULT_PERSONA;
}

/**
 * The marker as this process FIRST observed it, per marker path, plus whether it has changed since.
 * `--persona` and `PI_PERSONA_DEFAULT` are session-start SEEDS: pi-persona activates them without
 * persisting anything, so a marker that changes afterwards can only be a live `/persona` switch (or
 * `/persona off`), which pi-persona DOES persist. The change is latched, so switching back to the
 * name the marker originally held is still recognised as a switch rather than read as the seed.
 *
 * Process-global until {@link resetPersonaMarkerLatch} — "a switch happened" is a fact about the
 * current Pi session. Call the reset from `session_start`/`session_shutdown` so a reused process
 * does not inherit the previous session's latch.
 */
const personaMarkers = new Map<string, { baseline: string | null; stamp: string; switched: boolean }>();

/** Drop every session-scoped marker latch. A new Pi session must start from the launch seed. */
export function resetPersonaMarkerLatch(): void {
	personaMarkers.clear();
}

/** Has pi-persona rewritten its marker since this process started? Only a READABLE (or ABSENT) marker
 *  counts — an oversized or torn one is no evidence of a switch and must never demote the seed. Both
 *  the named persona AND the file identity are compared: pi-persona persists only on a user gesture
 *  (`/persona <name>`, the F8 cycle, `/persona off`), so ANY rewrite it made is a live selection, even
 *  when it re-selects the name the marker already held. */
function markerSwitched(path: string, marker: MarkerReading): boolean {
	const seen = personaMarkers.get(path);
	if (seen === undefined) {
		if (marker.readable) personaMarkers.set(path, { baseline: marker.persona, stamp: marker.stamp, switched: false });
		return false;
	}
	if (seen.switched) return true;
	if (!marker.readable) return false;
	if (seen.baseline === marker.persona && seen.stamp === marker.stamp) return false;
	seen.switched = true;
	return true;
}

/**
 * Return the unsanitized persona selected by pi-persona's precedence rules, or — once pi-persona has
 * rewritten its marker mid-session — the persona it switched TO. Initialization also uses this to
 * reconcile old filenames before the current collision-proof segment is applied.
 */
export function rawActivePersona(agentDir: string, env: NodeJS.ProcessEnv = process.env, cliPersona?: string): string | null {
	const live = cliPersona?.trim();
	const pin = env.PI_PERSONA_DEFAULT?.trim();
	const persist = env.PI_PERSONA_PERSIST?.trim().toLowerCase() !== "off";
	const seed = live ? live : pin ? pin : null;
	// persist=off: pi-persona neither reads nor writes the marker, so there is no live signal to follow.
	if (!persist) return seed;
	const path = personaStateFile(agentDir, env);
	const marker = readMarker(path);
	return seed === null || markerSwitched(path, marker) ? marker.persona : seed;
}

export interface ProjectSlugOptions {
	/** Injectable for tests and alternate filesystem providers; defaults to realpathSync.native. */
	realpath?: (path: string) => string;
	/** Injectable platform seam; defaults to the current Node platform. */
	platform?: NodeJS.Platform | string;
}

/** Canonical project identity: resolved, realpathed, and case-folded on Windows. */
export function canonicalProjectIdentity(projectRoot: string, opts: ProjectSlugOptions = {}): string {
	const platform = opts.platform ?? process.platform;
	const resolved = platform === "win32" ? win32.resolve(projectRoot) : resolve(projectRoot);
	// The default realpath provider is stable for a live project root and is the only path we cache.
	// Injectable providers stay uncached so tests and alternate filesystems observe every call.
	const cacheKey = opts.realpath === undefined ? `${platform}\0${platform === "win32" ? resolved.toLowerCase() : resolved}` : undefined;
	if (cacheKey !== undefined) {
		const cached = canonicalProjectCache.get(cacheKey);
		if (cached !== undefined) return cached;
	}
	let canonical: string;
	let cacheable = false;
	try {
		canonical = (opts.realpath ?? ((path: string) => realpathSync.native(path)))(resolved);
		cacheable = true;
	} catch {
		canonical = resolved;
	}
	if (platform === "win32") canonical = canonical.toLowerCase();
	if (cacheKey !== undefined && cacheable) {
		if (canonicalProjectCache.size >= MAX_CANONICAL_CACHE_ENTRIES) {
			const oldest = canonicalProjectCache.keys().next().value;
			if (oldest !== undefined) canonicalProjectCache.delete(oldest);
		}
		canonicalProjectCache.set(cacheKey, canonical);
	}
	return canonical;
}

/** A stable per-project store name: sanitized basename + a 24-hex hash of the canonical path. */
export function projectSlug(projectRoot: string, opts: ProjectSlugOptions = {}): string {
	const canonical = canonicalProjectIdentity(projectRoot, opts);
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
	const baseName = (opts.platform ?? process.platform) === "win32" ? win32.basename(canonical) : basename(canonical);
	const base =
		(baseName || "project")
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "project";
	return `${base}-${hash}`;
}

export interface ProjectRootOptions {
	/** Never treat this directory as a git project root (typically the user's home). */
	homedir?: string;
	/** Equality used to compare walked directories against `homedir`. Defaults to string equality. */
	samePath?: (a: string, b: string) => boolean;
}

/** Walk up from `startDir` to the nearest directory that satisfies `hasGit`; else return `startDir`.
 *  A git-initialized home directory is skipped so every folder under `~` does not share one backlog. */
export function findProjectRoot(startDir: string, hasGit: (dir: string) => boolean, opts: ProjectRootOptions = {}): string {
	const home = opts.homedir;
	const same = opts.samePath ?? ((a, b) => a === b);
	let cur = startDir;
	for (;;) {
		if (hasGit(cur) && !(home !== undefined && same(cur, home))) return cur;
		const parent = dirname(cur);
		if (parent === cur) return startDir;
		cur = parent;
	}
}

/** Build the four store paths for a (persona, project-slug) pair. Inputs must be pre-sanitized. */
export function mindPaths(agentDir: string, persona: string, slug: string): ScopePaths {
	const base = join(agentDir, "persona-mind");
	return {
		ltm: join(base, "memory", "ltm", `${persona}.json`),
		shared: join(base, "memory", "ltm", `${SHARED_SCOPE}.json`),
		stm: join(base, "memory", "stm", `${slug}.json`),
		backlog: join(base, "backlog", `${slug}.json`),
	};
}


type MarkerRead = { kind: "absent" } | { kind: "unreadable" } | { kind: "present"; raw: string; stamp: string };

const ABSENT: MarkerRead = { kind: "absent" };
const UNREADABLE: MarkerRead = { kind: "unreadable" };

/**
 * Read a marker only after a bounded stat, with a second stat guarding replacement/growth. A missing
 * file is reported as ABSENT rather than folded into "unreadable": the two mean opposite things to
 * {@link markerSwitched} — absence is pi-persona's own "nothing persisted yet", while an unreadable
 * marker is no evidence at all. The stamp is the file identity a later read is compared against.
 */
function tryRead(path: string): MarkerRead {
	let fd: number | undefined;
	try {
		let listed;
		try {
			listed = statSync(path);
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "ENOENT" ? ABSENT : UNREADABLE;
		}
		if (!listed.isFile() || !Number.isSafeInteger(listed.size) || listed.size > MAX_PERSONA_STATE_BYTES) return UNREADABLE;
		fd = openSync(path, "r");
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.size !== listed.size || opened.size > MAX_PERSONA_STATE_BYTES) return UNREADABLE;
		const bytes = Buffer.allocUnsafe(opened.size);
		let offset = 0;
		while (offset < bytes.length) {
			const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (read === 0) return UNREADABLE;
			offset += read;
		}
		const final = fstatSync(fd);
		if (!final.isFile() || final.size !== opened.size) return UNREADABLE;
		return { kind: "present", raw: bytes.toString("utf8"), stamp: `${final.mtimeMs}:${final.size}:${final.ino}:${final.dev}` };
	} catch {
		return UNREADABLE;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export interface ScopeResolutionOptions {
	/** Live pi-persona `--persona` value. It outranks env and the persisted marker. */
	cliPersona?: string;
	/** Injectable process environment for tests/embedders. */
	env?: NodeJS.ProcessEnv;
	/** Injectable home directory; defaults to os.homedir(). */
	homedir?: string;
}

/** Resolve the full scope for a turn: active persona, project root, and the store paths. */
export function resolveScope(agentDir: string, cwd: string, opts: ScopeResolutionOptions = {}): Scope {
	const persona = activePersona(agentDir, opts.env ?? process.env, opts.cliPersona);
	const home = opts.homedir ?? homedir();
	const start = resolve(cwd);
	const projectRoot = findProjectRoot(start, (d) => existsSync(join(d, ".git")), {
		homedir: home,
		samePath: (a, b) => canonicalProjectIdentity(a) === canonicalProjectIdentity(b),
	});
	const slug = projectSlug(projectRoot);
	const paths = mindPaths(agentDir, persona, slug);
	const homeWorkspace = canonicalProjectIdentity(projectRoot) === canonicalProjectIdentity(home);
	return homeWorkspace ? { persona, projectRoot, slug, paths, homeWorkspace: true } : { persona, projectRoot, slug, paths };
}
