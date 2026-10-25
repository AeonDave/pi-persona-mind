/** Explicit full-fact retrieval, separate from clipped, budgeted discovery and injection. */
import { isExpired, isMemoryId, memoryContentKey, memoryIdMatches, type MemoryEntry } from "./memory.ts";
import { safeOptimizeMemory, type OptimizeFailure, type OptimizeTarget } from "./optimize.ts";
import type { JsonStore } from "./store.ts";

export type MemoryReadScope = "long" | "short" | "both" | "project" | "persona" | "shared";
export type MemoryReadResult = { ok: true; entries: { entry: MemoryEntry; target: OptimizeTarget }[]; total: number; withheld: number } | OptimizeFailure;

export function memoryTargets(scope: MemoryReadScope): OptimizeTarget[] {
	switch (scope) {
		case "long": return ["persona", "shared", "project-long"];
		case "short": return ["project"];
		case "project": return ["project-long", "project"];
		case "persona": return ["persona"];
		case "shared": return ["shared"];
		case "both": return ["persona", "shared", "project-long", "project"];
		default: throw new Error("unknown memory scope");
	}
}

export async function readMemory(stores: Record<OptimizeTarget, JsonStore<MemoryEntry>>, id: string, scope: MemoryReadScope, now: number): Promise<MemoryReadResult> {
	if (!isMemoryId(id)) return { ok: false, reason: "memory ID must be one safe token" };
	try {
		const targets = memoryTargets(scope);
		const snapshots = await Promise.all(targets.map(async (target) => ({ target, snapshot: await stores[target].inspectStrict() })));
		const matches = snapshots.flatMap(({ target, snapshot }) => snapshot.store.entries.filter((entry) => !isExpired(entry, now) && memoryIdMatches(entry, id)).map((entry) => ({ entry, target })));
		if (matches.length === 0) return { ok: false, reason: "memory not found in the requested active scope" };
		if (new Set(matches.map(({ entry }) => memoryContentKey(entry))).size > 1) return { ok: false, reason: "ambiguous memory ID addresses multiple distinct facts; no fact selected" };
		if (matches.some(({ entry }) => !safeOptimizeMemory(entry))) return { ok: false, reason: "memory contains unsafe stored content and was withheld" };
		return { ok: true, entries: matches.slice(0, 8), total: matches.length, withheld: Math.max(0, matches.length - 8) };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : "memory read storage failure" };
	}
}
