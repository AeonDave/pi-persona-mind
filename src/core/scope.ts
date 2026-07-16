/**
 * Scope resolution — where a mind's stores live, and which persona owns the view.
 *
 * The ONE coupling to pi-persona: the active persona is read (best-effort, read-only) from
 * pi-persona's own marker at `<agentDir>/persona/state.json` (`{ lastPersona }`). When pi-persona
 * is absent or no persona is selected, everything degrades to a `_default` scope, so the extension
 * is fully usable on its own.
 *
 * Layout under `<agentDir>/pi-persona-mind/`:
 *   memory/ltm/<persona>.json   long-term, per persona (identity)
 *   memory/ltm/_shared.json     long-term, shared across personas
 *   memory/stm/<project>.json   short-term, per project (decays)
 *   backlog/<project>.json      backlog, per project
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

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
}

/** Read pi-persona's `{ lastPersona }` marker; the selected persona NAME, or null when none is
 *  selected / the marker is missing or invalid (the caller maps null to the {@link DEFAULT_PERSONA}
 *  scope). Kept distinct from a persona literally *named* `_default`, which must not merge with it. */
export function parsePersonaState(raw: string | undefined): string | null {
	if (raw === undefined) return null;
	try {
		const parsed = JSON.parse(raw) as { lastPersona?: unknown };
		return typeof parsed.lastPersona === "string" && parsed.lastPersona.trim() ? parsed.lastPersona : null;
	} catch {
		return null;
	}
}

/** The internal scope names a real persona must never be allowed to occupy (they back the shared
 *  tier and the no-persona fallback; a collision would bleed private↔shared memory or merge scopes). */
const RESERVED_SCOPES: ReadonlySet<string> = new Set([DEFAULT_PERSONA, SHARED_SCOPE]);

/** A filesystem-safe single path segment for a persona name (no separators, no traversal). A name
 *  that sanitizes onto an internal sentinel is prefixed so it can never hijack that reserved store. */
export function sanitizePersona(name: string): string {
	const s = name
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 64);
	if (!s) return DEFAULT_PERSONA;
	return RESERVED_SCOPES.has(s) ? `persona-${s}` : s;
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
	const override = env.PI_AGENT_DIR?.trim();
	return override ? override : undefined;
}

/** A stable per-project store name: sanitized basename + a 24-hex hash of the canonical path. */
export function projectSlug(projectRoot: string): string {
	const canonical = resolve(projectRoot);
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
	const base =
		(basename(canonical) || "project")
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "project";
	return `${base}-${hash}`;
}

/** Walk up from `startDir` to the nearest directory that satisfies `hasGit`; else return `startDir`. */
export function findProjectRoot(startDir: string, hasGit: (dir: string) => boolean): string {
	let cur = startDir;
	for (;;) {
		if (hasGit(cur)) return cur;
		const parent = dirname(cur);
		if (parent === cur) return startDir;
		cur = parent;
	}
}

/** Build the four store paths for a (persona, project-slug) pair. Inputs must be pre-sanitized. */
export function mindPaths(agentDir: string, persona: string, slug: string): ScopePaths {
	const base = join(agentDir, "pi-persona-mind");
	return {
		ltm: join(base, "memory", "ltm", `${persona}.json`),
		shared: join(base, "memory", "ltm", `${SHARED_SCOPE}.json`),
		stm: join(base, "memory", "stm", `${slug}.json`),
		backlog: join(base, "backlog", `${slug}.json`),
	};
}

function tryRead(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Resolve the full scope for a turn: active persona, project root, and the store paths. */
export function resolveScope(agentDir: string, cwd: string): Scope {
	const named = parsePersonaState(tryRead(personaStateFile(agentDir)));
	const persona = named === null ? DEFAULT_PERSONA : sanitizePersona(named);
	const projectRoot = findProjectRoot(resolve(cwd), (d) => existsSync(join(d, ".git")));
	const slug = projectSlug(projectRoot);
	return { persona, projectRoot, slug, paths: mindPaths(agentDir, persona, slug) };
}
