/** Bounded presentation for explicit memory inspection and staged consolidation.
 * Omitted replacement tags inherit the normalized source-tag union; [] clears them deliberately.
 */
import { compactMemoryText, MEMORY_KINDS, MAX_MEMORY_ID_CHARS, MAX_MEMORY_SOURCE_CHARS, MAX_MEMORY_TAGS, MAX_MEMORY_TAG_CHARS, MAX_MEMORY_TEXT_CHARS } from "../core/memory.ts";
import type { MemoryEntry } from "../core/memory.ts";
import type { MemoryOptimizer } from "../core/optimize-service.ts";
import type { OptimizeHistory, OptimizeUndone } from "../core/optimize-history.ts";
import { isOptimizeTarget, MAX_OPTIMIZE_OPERATIONS, MAX_OPTIMIZE_SOURCES, type OptimizeApplied, type OptimizeFailure, type OptimizeInspection, type OptimizeOperation, type OptimizePlan, type OptimizeTarget } from "../core/optimize.ts";

export const MAX_OPTIMIZE_TOTAL_SOURCES = 64;

export interface OptimizeToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

const fail = (reason: string): OptimizeToolResult => ({ content: [{ type: "text", text: `Memory optimization unavailable: ${reason}` }], details: { ok: false, reason } });
const ok = (text: string, details: Record<string, unknown>): OptimizeToolResult => ({ content: [{ type: "text", text }], details });

function memoryRow(entry: MemoryEntry, target: OptimizeTarget): string {
	const clipped = compactMemoryText(entry.text, 240);
	const truncated = clipped.length < entry.text.replace(/\s+/g, " ").trim().length ? " (excerpt; read by id for full text)" : "";
	const provenance = [entry.source ? `source: ${compactMemoryText(entry.source, 120)}` : "", entry.derivedFrom?.length ? `derived from: ${entry.derivedFrom.join(", ")}` : ""].filter(Boolean).join(" · ");
	return `- [${entry.id}] (${target}/${entry.kind}) ${clipped}${truncated}${provenance ? `\n  ${provenance}` : ""}`;
}

export function formatOptimizeInspection(result: OptimizeInspection): OptimizeToolResult {
	const rows = result.entries.map((entry) => memoryRow(entry, result.target));
	const candidates = result.candidates.length
		? `\nAdvisory similar pairs (never an edit instruction):\n${result.candidates.map((candidate) => `- ${candidate.leftId} ↔ ${candidate.rightId} (${candidate.exact ? "exact" : `${Math.round(candidate.similarity * 100)}% lexical overlap`})`).join("\n")}`
		: "";
	const laterPages = Math.max(0, result.matched - result.offset - result.entries.length);
	const outsideMatchSet = Math.max(0, result.total - result.matched);
	const omitted = [
		laterPages > 0 ? `${laterPages} safe matching entry(s) remain on later pages.` : "",
		outsideMatchSet > 0 ? `${outsideMatchSet} active entry(s) are outside this safe match set (filtered by query or withheld as unsafe).` : "",
	].filter(Boolean).map((line) => `\n${line}`).join("");
	const next = result.nextOffset === undefined ? "" : `\nNext page: use memory optimize inspect with offset=${result.nextOffset}; reuse this fingerprint only while the store is unchanged.`;
	return ok(`Inspect ${result.target} memory · offset ${result.offset}: ${result.entries.length} safe match(es) of ${result.matched} · ${result.total} active total · fingerprint ${result.fingerprint}\n${rows.length ? rows.join("\n") : "(no safe active entries on this page)"}${candidates}${omitted}${next}\nNo changes were applied. Read full entries by id before staging an explicit reviewed operation. Reinspect if the fingerprint changes.`, {
		ok: true, mode: "inspect", target: result.target, fingerprint: result.fingerprint,
		total: result.total, count: result.entries.length, withheld: result.withheld,
		offset: result.offset, matched: result.matched, ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }),
		entries: result.entries.map((entry) => ({ id: entry.id, kind: entry.kind, target: result.target, text: compactMemoryText(entry.text, 240), source: entry.source, derivedFrom: entry.derivedFrom })),
		candidates: result.candidates,
	});
}

export function formatOptimizePlan(plan: OptimizePlan): OptimizeToolResult {
	const changes = plan.changes.map((change, index) => [
		`Change ${index + 1}:`,
		`  selected text: ${change.before.reduce((sum, entry) => sum + Array.from(entry.text).length, 0)} chars → ${Array.from(change.after.text).length} chars`,
		...change.before.map((entry) => `  - before [${entry.id}] (${entry.kind}) ${entry.text}`),
		`  + after [${change.after.id}] (${change.after.kind}) ${change.after.text}`,
		...(change.after.source ? [`    source: ${change.after.source}`] : []),
		...(change.after.derivedFrom?.length ? [`    derived from: ${change.after.derivedFrom.join(", ")}`] : []),
	].join("\n")).join("\n");
	return ok(`Staged plan ${plan.planId} (${plan.target}) · expires ${plan.expiresAt}\n${plan.beforeCount} entries → ${plan.afterCount}\n${changes}\nNothing has been applied. Review this exact plan, then call memory optimize with mode=apply and this planId.`, {
		ok: true, mode: "stage", planId: plan.planId, target: plan.target, expiresAt: plan.expiresAt,
		beforeCount: plan.beforeCount, afterCount: plan.afterCount,
		changes: plan.changes.map((change) => ({ before: change.before, after: change.after })),
	});
}

export function formatOptimizeApplied(result: OptimizeApplied): OptimizeToolResult {
	return ok(`Applied staged memory plan ${result.planId}: ${result.changed} change(s), ${result.beforeCount} entries → ${result.afterCount}.${result.receiptId ? ` Recovery receipt: ${result.receiptId} (${result.target}); undo requires matching affected facts.` : ""}${result.warning ? `\n${result.warning}` : ""}`, { ...result, mode: "apply" });
}

export function formatOptimizeHistory(result: OptimizeHistory): OptimizeToolResult {
	const rows = result.receipts.map((receipt) => [
		`Receipt ${receipt.receiptId} · ${receipt.createdAt} · ${receipt.state}${receipt.state === "prepared" ? " (interrupted intent; replacement may or may not have committed)" : ""}`,
		...receipt.changes.flatMap((change) => [
			...change.before.map((entry) => `  before: ${JSON.stringify(entry)}`),
			`  after: ${JSON.stringify(change.after)}`,
		]),
	].join("\n"));
	return ok(`Memory optimization history (${result.target}): ${result.receipts.length} shown of ${result.retained} retained; ${result.omitted} omitted from this page; ${result.withheldUnsafe ?? 0} withheld as unsafe. Retention is bounded to ${result.limit} receipts / ${result.maxBytes} bytes per store; older settled receipts can be evicted. Prepared receipts are preserved and may require manual recovery if they fill capacity.\n${rows.join("\n") || "(no retained receipts)"}\nUndo requires unchanged affected facts, no restored-source collisions, the same owner, and unexpired sources.`, {
		ok: true, mode: "history", target: result.target, retained: result.retained, omitted: result.omitted, withheldUnsafe: result.withheldUnsafe ?? 0,
		receipts: result.receipts.map(({ storePath: _storePath, ...receipt }) => receipt),
	});
}

export function formatOptimizeUndone(result: OptimizeUndone): OptimizeToolResult {
	return ok(`Undid memory consolidation ${result.receiptId} (${result.target}): restored ${result.restored} original fact(s); unrelated facts preserved.${result.warning ? `\n${result.warning}` : ""}`, { ...result, mode: "undo" });
}

export function formatOptimizeFailure(result: OptimizeFailure): OptimizeToolResult { return fail(result.reason); }

export function isOptimizeOperation(value: unknown): value is OptimizeOperation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const operation = value as Record<string, unknown>;
	const allowed = new Set(["sourceIds", "kind", "text", "tags", "source"]);
	if (Object.keys(operation).some((key) => !allowed.has(key))) return false;
	if (!Array.isArray(operation.sourceIds) || operation.sourceIds.length < 1 || operation.sourceIds.length > MAX_OPTIMIZE_SOURCES || !Array.from(operation.sourceIds).every((id) => typeof id === "string" && id.length <= MAX_MEMORY_ID_CHARS && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id))) return false;
	if (typeof operation.kind !== "string" || !(MEMORY_KINDS as readonly string[]).includes(operation.kind) || typeof operation.text !== "string" || !operation.text.trim() || operation.text.length > MAX_MEMORY_TEXT_CHARS) return false;
	if (operation.tags !== undefined && (!Array.isArray(operation.tags) || operation.tags.length > MAX_MEMORY_TAGS || !Array.from(operation.tags).every((tag) => typeof tag === "string" && tag.length <= MAX_MEMORY_TAG_CHARS))) return false;
	if (operation.source !== undefined && (typeof operation.source !== "string" || operation.source.length > MAX_MEMORY_SOURCE_CHARS)) return false;
	return true;
}

/** Run after the top-level action validator has excluded fields from other modes. */
export async function runOptimizeAction(
	optimizer: MemoryOptimizer,
	input: { mode?: "inspect" | "stage" | "apply" | "history" | "undo"; target?: OptimizeTarget; query?: string; max?: number; offset?: number; fingerprint?: string; operations?: OptimizeOperation[]; planId?: string; receiptId?: string },
): Promise<OptimizeToolResult> {
	const mode = input.mode ?? "inspect";
	if (mode === "history") {
		const result = await optimizer.history(input.target ?? "project", input.max);
		return result.ok ? formatOptimizeHistory(result) : formatOptimizeFailure(result);
	}
	if (mode === "undo") {
		if (!input.receiptId || !input.target) return fail("undo needs receiptId and an explicit target");
		const result = await optimizer.undo(input.receiptId, input.target);
		return result.ok ? formatOptimizeUndone(result) : formatOptimizeFailure(result);
	}
	if (mode === "inspect") {
		const result = await optimizer.inspect(input.target ?? "project", { ...(input.query === undefined ? {} : { query: input.query }), ...(input.max === undefined ? {} : { max: input.max }), ...(input.offset === undefined ? {} : { offset: input.offset }) });
		return result.ok ? formatOptimizeInspection(result) : formatOptimizeFailure(result);
	}
	if (mode === "stage") {
		const sourceCount = input.operations?.reduce((sum, operation) => sum + operation.sourceIds.length, 0) ?? 0;
		if (!input.fingerprint || !input.operations || input.operations.length < 1 || input.operations.length > MAX_OPTIMIZE_OPERATIONS || sourceCount > MAX_OPTIMIZE_TOTAL_SOURCES) return fail(`stage needs a fingerprint and 1..${MAX_OPTIMIZE_OPERATIONS} operations with at most ${MAX_OPTIMIZE_TOTAL_SOURCES} total source IDs`);
		const result = await optimizer.preview({ target: input.target ?? "project", fingerprint: input.fingerprint, operations: input.operations });
		return result.ok ? formatOptimizePlan(result) : formatOptimizeFailure(result);
	}
	if (mode === "apply") {
		if (!input.planId) return fail("apply needs the planId from a staged plan");
		const result = await optimizer.apply(input.planId);
		return result.ok ? formatOptimizeApplied(result) : formatOptimizeFailure(result);
	}
	return fail("unknown optimization mode");
}
