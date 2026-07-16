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

/** Read pi-persona's `{ lastPersona }` marker; anything missing/invalid ⇒ the default scope. */
export function parsePersonaState(raw: string | undefined): string {
	if (raw === undefined) return DEFAULT_PERSONA;
	try {
		const parsed = JSON.parse(raw) as { lastPersona?: unknown };
		return typeof parsed.lastPersona === "string" && parsed.lastPersona.trim() ? parsed.lastPersona : DEFAULT_PERSONA;
	} catch {
		return DEFAULT_PERSONA;
	}
}

/** A filesystem-safe single path segment for a persona name (no separators, no traversal). */
export function sanitizePersona(name: string): string {
	const s = name
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 64);
	return s || DEFAULT_PERSONA;
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
	const persona = sanitizePersona(parsePersonaState(tryRead(join(agentDir, "persona", "state.json"))));
	const projectRoot = findProjectRoot(resolve(cwd), (d) => existsSync(join(d, ".git")));
	const slug = projectSlug(projectRoot);
	return { persona, projectRoot, slug, paths: mindPaths(agentDir, persona, slug) };
}
