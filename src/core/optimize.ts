/** Explicit memory consolidation rules. Similarity discovers candidates; it never authorizes edits. */
import {
	isExpired, isMemoryId, makeMemory, memoryContentKey, MEMORY_KINDS,
	MAX_MEMORY_DERIVED_IDS, MAX_MEMORY_SOURCE_CHARS, MAX_MEMORY_TAGS, MAX_MEMORY_TAG_CHARS, MAX_MEMORY_TEXT_CHARS,
	validateMemory, type MemoryEntry, type MemoryKind,
} from "./memory.ts";
import { scanContent } from "./scanner.ts";

export type OptimizeTarget = "project" | "project-long" | "persona" | "shared";
export interface OptimizeOperation { sourceIds: string[]; kind: MemoryKind; text: string; tags?: string[]; source?: string }
export interface OptimizeFailure { ok: false; reason: string }
export interface OptimizeCandidate { leftId: string; rightId: string; similarity: number; exact: boolean }
export interface OptimizeInspection {
	ok: true; target: OptimizeTarget; fingerprint: string; entries: MemoryEntry[];
	total: number; withheld: number; candidates: OptimizeCandidate[];
	offset: number; matched: number; nextOffset?: number;
}
export interface OptimizeChange { before: MemoryEntry[]; after: MemoryEntry }
export interface OptimizePlan {
	ok: true; planId: string; target: OptimizeTarget; fingerprint: string; expiresAt: string;
	changes: OptimizeChange[]; beforeCount: number; afterCount: number;
}
export interface OptimizeApplied { ok: true; planId: string; target: OptimizeTarget; changed: number; beforeCount: number; afterCount: number; receiptId?: string; warning?: string }
export interface OptimizePreviewInput { target?: OptimizeTarget; fingerprint: string; operations: OptimizeOperation[] }
export interface OptimizeInspectOptions { query?: string; max?: number; offset?: number }

export const MAX_OPTIMIZE_ENTRIES = 100;
export const MAX_OPTIMIZE_CANDIDATES = 12;
export const MAX_OPTIMIZE_OPERATIONS = 8;
export const MAX_OPTIMIZE_SOURCES = 16;
export const MAX_OPTIMIZE_PLANS = 4;
export const OPTIMIZE_PLAN_TTL_MS = 10 * 60_000;

export function isOptimizeTarget(value: unknown): value is OptimizeTarget {
	return value === "project" || value === "project-long" || value === "persona" || value === "shared";
}

/** All persisted model-visible fields are untrusted, including tags and human-citable origins. */
export function safeOptimizeMemory(entry: MemoryEntry): boolean {
	return [entry.text, ...entry.tags, entry.source ?? "", entry.persona ?? ""].every((text) => scanContent(text).ok);
}

function terms(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? []);
}

export function samePersistedMemory(a: MemoryEntry, b: MemoryEntry): boolean {
	const left = validateMemory(a);
	const right = validateMemory(b);
	return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

/** Bounded lexical advisory only: opposite claims can have almost identical words. */
export function optimizeCandidates(entries: readonly MemoryEntry[]): OptimizeCandidate[] {
	const bounded = entries.slice(0, MAX_OPTIMIZE_ENTRIES);
	const words = bounded.map((entry) => terms(`${entry.text} ${entry.tags.join(" ")}`));
	const candidates: OptimizeCandidate[] = [];
	for (let i = 0; i < bounded.length; i++) {
		const left = bounded[i]!;
		for (let j = i + 1; j < bounded.length; j++) {
			const right = bounded[j]!;
			if (left.kind !== right.kind || left.persona !== right.persona) continue;
			const a = words[i]!; const b = words[j]!;
			const common = [...a].filter((word) => b.has(word)).length;
			const union = a.size + b.size - common;
			const exact = memoryContentKey(left) === memoryContentKey(right);
			const similarity = exact ? 1 : union === 0 ? 0 : common / union;
			if (exact || similarity >= 0.45) candidates.push({ leftId: left.id, rightId: right.id, similarity, exact });
		}
	}
	return candidates.sort((a, b) => b.similarity - a.similarity || a.leftId.localeCompare(b.leftId) || a.rightId.localeCompare(b.rightId)).slice(0, MAX_OPTIMIZE_CANDIDATES);
}

/** Build a reviewed replacement set without mutation. Unselected entries are never upsert targets. */
export function planConsolidation(entries: readonly MemoryEntry[], operations: readonly OptimizeOperation[], target: OptimizeTarget, persona: string, now: number): { ok: true; changes: OptimizeChange[]; entries: MemoryEntry[] } | OptimizeFailure {
	if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPTIMIZE_OPERATIONS) {
		return { ok: false, reason: `provide 1..${MAX_OPTIMIZE_OPERATIONS} explicit consolidation operations` };
	}
	const selected = new Set<MemoryEntry>();
	const changes: OptimizeChange[] = [];
	for (const operation of operations) {
		if (!operation || !Array.isArray(operation.sourceIds) || operation.sourceIds.length < 1 || operation.sourceIds.length > MAX_OPTIMIZE_SOURCES || operation.sourceIds.some((id: unknown) => !isMemoryId(id))) {
			return { ok: false, reason: `each operation needs 1..${MAX_OPTIMIZE_SOURCES} exact safe source IDs` };
		}
		const before: MemoryEntry[] = [];
		for (const id of operation.sourceIds) {
			const matches = entries.filter((entry) => entry.id === id);
			if (matches.length !== 1) return { ok: false, reason: `source ${id} is missing or ambiguous; no entries changed` };
			const entry = matches[0]!;
			if (selected.has(entry)) return { ok: false, reason: "source IDs overlap within or between operations" };
			if (isExpired(entry, now)) return { ok: false, reason: `source ${id} expired; inspect again` };
			if ((target === "project" || target === "project-long") && entry.persona !== persona) return { ok: false, reason: `source ${id} belongs to a different or unowned persona` };
			if (!safeOptimizeMemory(entry)) return { ok: false, reason: `source ${id} contains unsafe stored content` };
			selected.add(entry); before.push(entry);
		}
		if (before.some((entry) => entry.persona !== before[0]!.persona)) return { ok: false, reason: "consolidation cannot mix persona ownership markers" };
		if (!(MEMORY_KINDS as readonly unknown[]).includes(operation.kind) || (target === "project" && operation.kind === "objective")) {
			return { ok: false, reason: "invalid memory kind for the selected tier (objectives are durable)" };
		}
		if (typeof operation.text !== "string" || !operation.text.trim() || operation.text.length > MAX_MEMORY_TEXT_CHARS) return { ok: false, reason: `replacement text must contain 1..${MAX_MEMORY_TEXT_CHARS} characters` };
		if (operation.tags !== undefined && (!Array.isArray(operation.tags) || operation.tags.length > MAX_MEMORY_TAGS || operation.tags.some((tag: unknown) => typeof tag !== "string" || tag.length > MAX_MEMORY_TAG_CHARS))) return { ok: false, reason: "replacement tags exceed memory bounds" };
		if (operation.source !== undefined && (typeof operation.source !== "string" || operation.source.length > MAX_MEMORY_SOURCE_CHARS)) return { ok: false, reason: "replacement source exceeds memory bounds" };
		const tags = operation.tags ?? before.flatMap((entry) => entry.tags);
		const after = makeMemory({ term: target === "project" ? "short" : "long", kind: operation.kind, text: operation.text, tags }, now);
		if (after.tags.length > MAX_MEMORY_TAGS || after.tags.some((tag) => tag.length > MAX_MEMORY_TAG_CHARS)) return { ok: false, reason: "combined replacement tags exceed memory bounds; provide explicit tags or split the operation" };
		const marker = before[0]!.persona;
		if (marker !== undefined) after.persona = marker;
		after.recordedAt = before.reduce((earliest, entry) => Date.parse(entry.recordedAt) < Date.parse(earliest) ? entry.recordedAt : earliest, before[0]!.recordedAt);
		if (target === "project") {
			if (before.some((entry) => entry.expiresAt === undefined)) return { ok: false, reason: "project source lacks expiry" };
			after.expiresAt = before.reduce((earliest, entry) => Date.parse(entry.expiresAt!) < Date.parse(earliest) ? entry.expiresAt! : earliest, before[0]!.expiresAt!);
		}
		const lineage = [...new Set(before.flatMap((entry) => [entry.id, ...(entry.derivedFrom ?? []), ...(entry.supersedes ? [entry.supersedes] : [])]))].filter((id) => id !== after.id);
		if (lineage.length > MAX_MEMORY_DERIVED_IDS) return { ok: false, reason: `consolidation provenance exceeds ${MAX_MEMORY_DERIVED_IDS} IDs; split the operation` };
		if (lineage.length > 0) after.derivedFrom = lineage;
		const origins = [...new Set([...before.flatMap((entry) => entry.source ? [entry.source] : []), ...(operation.source ? [operation.source] : [])])];
		if (origins.length > 0) after.source = origins.join("; ");
		if ((after.source?.length ?? 0) > MAX_MEMORY_SOURCE_CHARS) return { ok: false, reason: "combined source provenance exceeds memory bounds; split the operation" };
		const normalizedAfter = validateMemory(after);
		if (!normalizedAfter) return { ok: false, reason: "replacement metadata exceeds memory schema bounds" };
		if (!safeOptimizeMemory(normalizedAfter)) return { ok: false, reason: "replacement content, tags or source rejected by content scanner" };
		changes.push({ before, after: normalizedAfter });
	}
	const effectiveChanges = changes.filter((change) => change.before.length !== 1 || !samePersistedMemory(change.before[0]!, change.after));
	const effectivelySelected = new Set(effectiveChanges.flatMap((change) => change.before));
	const untouched = entries.filter((entry) => !effectivelySelected.has(entry));
	const replacements = effectiveChanges.map((change) => change.after);
	for (let i = 0; i < replacements.length; i++) {
		const replacement = replacements[i]!;
		if ([...untouched, ...replacements.slice(0, i)].some((entry) => entry.id === replacement.id || memoryContentKey(entry) === memoryContentKey(replacement))) return { ok: false, reason: "replacement collides with another fact; include its exact source or revise the proposal" };
	}
	return { ok: true, changes: effectiveChanges, entries: [...untouched, ...replacements] };
}
