/**
 * Scope resolution — where a mind's stores live, and which persona owns the view.
 *
 * Active ownership is supplied by the live companion protocol.
 *
 * Layout under `<agentDir>/persona-mind/`:
 *   memory/ltm/<persona>.json   long-term, per persona (identity)
 *   memory/ltm/_shared.json     long-term, shared across personas
 *   memory/project/<project>.json durable repository knowledge
 *   memory/stm/<project>.json   short-term, per project (decays)
 *   backlog/<project>.json      backlog, per project
 */

import { existsSync, realpathSync } from "node:fs";
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
	/** Durable repository knowledge, attributed to its recording persona. */
	projectLtm: string;
	/** Short-term memory for the current project. */
	stm: string;
	/** Backlog for the current project. */
	backlog: string;
}

/** Persona/shared facts span projects, so every memory writer uses one profile transaction lock. */
export function memoryMutationLockPath(paths: Pick<ScopePaths, "shared">): string {
	return `${paths.shared}.memory-transaction.lock`;
}

export interface Scope {
	persona: string;
	projectRoot: string;
	slug: string;
	paths: ScopePaths;
	/** True when the resolved project is the user's home directory (no real git workspace). */
	homeWorkspace?: true;
}

/** The internal scope names a real persona must never be allowed to occupy (they back the shared
 *  tier and the no-persona fallback; a collision would bleed private↔shared memory or merge scopes).
 *  Compared case-insensitively — a case-insensitive filesystem aliases `_SHARED.json` to `_shared.json`. */
const RESERVED_SCOPES: ReadonlySet<string> = new Set([DEFAULT_PERSONA, SHARED_SCOPE]);

/** Windows reserved device base names: `NUL.json`/`CON.json`/… resolve to the device (a silent
 *  write-to-void) in legacy Win32 path resolution, so a persona named after one must not be a filename. */
const WIN_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
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

/** Build store paths for a (persona, project-slug) pair. Inputs must be pre-sanitized. */
export function mindPaths(agentDir: string, persona: string, slug: string): ScopePaths {
	const base = join(agentDir, "persona-mind");
	return {
		ltm: join(base, "memory", "ltm", `${persona}.json`),
		shared: join(base, "memory", "ltm", `${SHARED_SCOPE}.json`),
		projectLtm: join(base, "memory", "project", `${slug}.json`),
		stm: join(base, "memory", "stm", `${slug}.json`),
		backlog: join(base, "backlog", `${slug}.json`),
	};
}


export interface ScopeResolutionOptions {
	/** Authoritative owner from the loaded companion; null explicitly means Persona is off. */
	persona: string | null;
	homedir?: string;
}

/** Resolve paths from an explicit live owner; never infer ownership from global settings. */
export function resolveScope(agentDir: string, cwd: string, opts: ScopeResolutionOptions): Scope {
	if (!opts || (opts.persona !== null && (typeof opts.persona !== "string" || !opts.persona.trim()))) throw new Error("live persona owner is unavailable");
	const rawPersona = opts.persona;
	const persona = rawPersona ? sanitizePersona(rawPersona) : DEFAULT_PERSONA;
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
