/**
 * The `memory` tool — the agent-facing surface for durable knowledge.
 *
 * remember: store a fact, long-term (durable persona identity) or short-term (decaying project
 * note). recall: keyword + recency search. forget: delete by id. All content is declarative and
 * scanned before it is persisted (the service enforces both). Thin glue: it translates tool
 * parameters into MindService calls and formats the result the model sees.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { renderExpandableResult, toolResultText } from "../ui/presentation.ts";

import {
	clampRecallMax,
	compactMemoryText,
	isMemoryId,
	MEMORY_KINDS,
	MAX_MEMORY_DERIVED_IDS,
	MAX_MEMORY_ID_CHARS,
	MAX_MEMORY_SOURCE_CHARS,
	MAX_MEMORY_TAGS,
	MAX_MEMORY_TAG_CHARS,
	MAX_MEMORY_TEXT_CHARS,
	MAX_RECALL_QUERY_CHARS,
} from "../core/memory.ts";
import type { MindService, RememberInput } from "../core/service.ts";
import type { SessionMemory } from "../session-memory.ts";
import type { MemoryOptimizer } from "../core/optimize-service.ts";
import { isOptimizeOperation, MAX_OPTIMIZE_TOTAL_SOURCES, runOptimizeAction } from "./memory-optimize.ts";
import { isOptimizeTarget, MAX_OPTIMIZE_OPERATIONS } from "../core/optimize.ts";
import { DEFAULT_STORE_MAX_ENTRIES } from "../core/store.ts";
import { runMindActivity } from "../extension/activity.ts";
import type { MindActivityRunner } from "../extension/activity.ts";

export type GetMind = (ctx: ExtensionContext) => MindService;

const MemoryParams = Type.Object({
	action: Type.Union([Type.Literal("remember"), Type.Literal("recall"), Type.Literal("read"), Type.Literal("forget"), Type.Literal("promote"), Type.Literal("optimize")], {
		description: "remember = store · recall = search · read = retrieve full text · forget = delete/tombstone by id · promote = graduate short-term · optimize = inspect, stage, or explicitly apply a consolidation",
	}),
	term: Type.Optional(
		Type.Union([Type.Literal("long"), Type.Literal("short"), Type.Literal("session")], {
			description: "remember: long = durable persona identity; short = expiring project note; session = active-branch note only, never copied into persona archives. Required for remember.",
		}),
	),
	kind: Type.Optional(
		Type.Union(
			MEMORY_KINDS.map((k) => Type.Literal(k)),
			{ description: "remember: the category of the fact. Required for remember." },
		),
	),
	text: Type.Optional(
		Type.String({
			maxLength: MAX_MEMORY_TEXT_CHARS,
			description:
				"remember: the fact, DECLARATIVE not imperative ('the user prefers verbose recon', never 'always be verbose'). Do not store secrets or anything re-derivable from the repo. Required for remember.",
		}),
	),
	tags: Type.Optional(Type.Array(Type.String({ maxLength: MAX_MEMORY_TAG_CHARS }), { maxItems: MAX_MEMORY_TAGS, description: "optional tags to aid later recall" })),
	ttlHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "remember(short): hours until it is deleted from the store (default 48)" })),
	supersedes: Type.Optional(Type.String({ maxLength: MAX_MEMORY_ID_CHARS, description: "remember: id of an existing entry this one replaces" })),
	source: Type.Optional(Type.String({ maxLength: MAX_MEMORY_SOURCE_CHARS, description: "remember: optional human-citable origin of this fact (e.g. 'the user said', 'child scout')" })),
	derivedFrom: Type.Optional(Type.Array(Type.String({ maxLength: MAX_MEMORY_ID_CHARS }), { maxItems: MAX_MEMORY_DERIVED_IDS, description: "remember: optional ids of memories distilled into this fact" })),
	query: Type.Optional(Type.String({ maxLength: MAX_RECALL_QUERY_CHARS, description: "recall: keywords (empty = most recent); optimize inspect: optional substring filter" })),
	scope: Type.Optional(
		Type.Union([Type.Literal("long"), Type.Literal("short"), Type.Literal("both"), Type.Literal("session"), Type.Literal("project"), Type.Literal("persona"), Type.Literal("shared")], { description: "remember/promote: project|persona|shared; long remember defaults persona, promote defaults project. recall/read/forget: project includes repository durable + working facts; long includes all durable tiers; both includes all active stores; session is branch-local." }),
	),
	max: Type.Optional(Type.Number({ description: "recall: maximum results, clamped to 1..50 (default 8); optimize inspect: entry page 1..100 (default 20)" })),
	offset: Type.Optional(Type.Number({ minimum: 0, maximum: DEFAULT_STORE_MAX_ENTRIES, multipleOf: 1, description: `optimize inspect: zero-based page offset from 0 to ${DEFAULT_STORE_MAX_ENTRIES} (default 0)` })),
	id: Type.Optional(Type.String({ maxLength: MAX_MEMORY_ID_CHARS, description: "read/forget/promote: exact entry id; session:<UUID> addresses an active-session note" })),
	mode: Type.Optional(Type.Union([Type.Literal("inspect"), Type.Literal("stage"), Type.Literal("apply"), Type.Literal("history"), Type.Literal("undo")], { description: "optimize: inspect candidates; stage an immutable proposal; apply a plan; history retrieves bounded durable before/after receipts; undo safely restores a receipt's unchanged affected facts (default inspect)" })),
	target: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("project-long"), Type.Literal("persona"), Type.Literal("shared")], { description: "optimize: project = working memory, project-long = durable repository knowledge, persona/shared = durable identity/common facts" })),
	fingerprint: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "optimize stage: exact fingerprint from the corresponding inspection" })),
	operations: Type.Optional(Type.Array(Type.Object({
		sourceIds: Type.Array(Type.String({ maxLength: MAX_MEMORY_ID_CHARS }), { minItems: 1, maxItems: 16 }),
		kind: Type.Union(MEMORY_KINDS.map((kind) => Type.Literal(kind))),
		text: Type.String({ minLength: 1, maxLength: MAX_MEMORY_TEXT_CHARS }),
		tags: Type.Optional(Type.Array(Type.String({ maxLength: MAX_MEMORY_TAG_CHARS }), { maxItems: MAX_MEMORY_TAGS, description: "optimize stage: omitted tags inherit the normalized union from selected sources; an explicit empty array clears them" })),
		source: Type.Optional(Type.String({ maxLength: MAX_MEMORY_SOURCE_CHARS })),
	}, { additionalProperties: false }), { maxItems: 8, description: "optimize stage: explicit replacements; source IDs must be disjoint and total no more than 64" })),
	planId: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "optimize apply: exact unexpired staged plan id" })),
	receiptId: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "optimize undo: exact retained durable receipt id; also supply target" })),
}, { additionalProperties: false });

type MemoryToolParams = Type.Static<typeof MemoryParams>;

/** How many colliding facts an ambiguity refusal names before it summarizes the rest. */
const MAX_AMBIGUITY_CANDIDATES_SHOWN = 5;

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

function say(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

export type GetOptimizer = (ctx: ExtensionContext) => MemoryOptimizer;
export type GetMindActivity = (ctx: ExtensionContext) => MindActivityRunner | undefined;

export function registerMemoryTool(pi: ExtensionAPI, getMind: GetMind, sessionMemory?: SessionMemory, getOptimizer?: GetOptimizer, getActivity?: GetMindActivity): void {
	pi.registerTool({
		name: "memory",
		label: "Memory",
		promptSnippet: "memory — persist, recall, inspect, and explicitly consolidate durable facts, project context, and active-session notes",
		promptGuidelines: [
			"Before the final answer, use `memory` once when this turn established a durable user preference, architectural decision/invariant, or verified lesson that is not simply re-derivable from the repository. A user who explicitly labels a fact durable/permanent is asking for capture even without the word 'remember'. Use `backlog` for unfinished intent. Skip routine transcript, guesses, and secrets.",
			"For consolidation, inspect first, read the full selected entries, compare them with the newest primary evidence, then stage explicit rewrites/merges that preserve exceptions and provenance. Review the exact before/after plan and character counts; apply the exact staged plan within the user's authorized memory-maintenance scope. Inspect is read-only and never calls a model or applies changes by itself.",
		],
		description: [
			"Your durable, persona-scoped memory. `remember` a fact so it survives context compaction and",
			"restarts — long-term for who this persona is to the user (preferences/conventions/lessons),",
			"long with scope=project for durable repository knowledge, short for project notes that auto-delete after ~48h, or session for active-branch notes only. Scope=shared explicitly shares durable facts across personas. Promotion preserves project scope by default. `recall` searches; `read` gets full text; `forget` retires by id with optional scope. For `optimize`, inspect candidates, read full entries, compare against current evidence, stage explicit reviewed replacements preserving exceptions and provenance, then apply only an authorized exact plan. Inspect is read-only; it does not call a model or write.",
			"Facts are re-injected into your context automatically each turn, so remember what you would",
			"want to know next session. Keep entries DECLARATIVE, never store secrets.",
		].join(" "),
		parameters: MemoryParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const invalid = validateMemoryParams(params);
				if (invalid) return say(invalid, { ok: false, reason: "invalid_parameters" });
				return await runMemoryAction(getMind(ctx), params, ctx, sessionMemory, getOptimizer, getActivity);
			} catch (err) {
				// One loud surface for every action. `remember`/`promote` already convert a store failure into
				// a result, but `recall`/`forget` let it throw — so a store written by a different build
				// (StoreVersionError) escapes as a tool crash for two actions and reads as a tidy reason for
				// the other two. The model reads this boundary, so it reports the same way either way.
				const message = err instanceof Error ? err.message : String(err);
				return say(`Memory is unavailable: ${message || "unknown persistence failure"}`, { ok: false, reason: "storage_error" });
			}
		},
		renderResult(result, { expanded }, theme) {
			const body = toolResultText(result);
			const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : undefined;
			// Recognize old receipts too, so reopening a session does not restore the noisy card.
			const savedTerm = details?.ok === true ? /^Remembered \S+ — (long|short)-term /.exec(body)?.[1] : undefined;
			const savedSession = details?.ok === true && details.action === "remember" && details.storage === "session";
			if (savedTerm || savedSession) {
				const summary = typeof details?.summary === "string"
					? details.summary
					: savedSession ? "Session note saved" : `${savedTerm === "long" ? "Long" : "Short"}-term saved`;
				return renderExpandableResult(summary, true, theme);
			}
			return renderExpandableResult(body, expanded, theme);
		},
	});
}

const KEYS: Record<string, ReadonlySet<string>> = {
	remember: new Set(["action", "term", "kind", "text", "tags", "ttlHours", "supersedes", "scope", "source", "derivedFrom"]),
	recall: new Set(["action", "query", "scope", "max"]),
	read: new Set(["action", "id", "scope"]),
	forget: new Set(["action", "id", "scope"]),
	promote: new Set(["action", "id", "scope"]),
	optimize: new Set(["action", "mode", "target", "query", "max", "offset", "fingerprint", "operations", "planId", "receiptId"]),
};

/** The host validates TypeBox schemas, but execute is also callable directly by SDK clients. */
function validateMemoryParams(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "memory expects one object of action parameters.";
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return "memory action parameters must be a plain object.";
	const params = value as Record<string, unknown>;
	if (typeof params.action !== "string" || !Object.hasOwn(KEYS, params.action)) return "Unknown memory action.";
	if (Reflect.ownKeys(params).some((key) => typeof key !== "string" || !KEYS[params.action as string]!.has(key))) return `memory ${params.action} received a field that does not belong to that action.`;
	const has = (key: string) => Object.hasOwn(params, key);
	const str = (key: string, min: number, max: number) => typeof params[key] === "string" && (params[key] as string).length >= min && (params[key] as string).length <= max;
	if (params.action === "remember") {
		if (params.term !== "long" && params.term !== "short" && params.term !== "session") return "memory remember needs term=long|short|session.";
		if (typeof params.kind !== "string" || !(MEMORY_KINDS as readonly string[]).includes(params.kind)) return "memory remember needs a valid kind.";
		if (!str("text", 1, MAX_MEMORY_TEXT_CHARS)) return `memory remember text must contain 1..${MAX_MEMORY_TEXT_CHARS} characters.`;
		if (params.term === "session" && ["tags", "ttlHours", "supersedes", "scope", "derivedFrom"].some(has)) return "session notes accept only kind, text, and optional source.";
		if (params.scope !== undefined && !["project", "persona", "shared"].includes(String(params.scope))) return "remember scope must be project, persona, or shared.";
		if (params.term === "short" && params.scope !== undefined && params.scope !== "project") return "short-term notes belong to project scope.";
		if (params.tags !== undefined && (!Array.isArray(params.tags) || params.tags.length > MAX_MEMORY_TAGS || !Array.from(params.tags).every((tag) => typeof tag === "string" && tag.length <= MAX_MEMORY_TAG_CHARS))) return "memory tags exceed their bounds.";
		if (params.derivedFrom !== undefined && (!Array.isArray(params.derivedFrom) || params.derivedFrom.length > MAX_MEMORY_DERIVED_IDS || !Array.from(params.derivedFrom).every((id) => isMemoryId(id)))) return "memory derivedFrom ids are invalid or exceed their bound.";
		if (params.source !== undefined && (typeof params.source !== "string" || params.source.length > MAX_MEMORY_SOURCE_CHARS)) return "memory source exceeds its bound.";
		if (params.supersedes !== undefined && !isMemoryId(params.supersedes)) return "memory supersedes must be a safe entry id.";
		if (params.ttlHours !== undefined && (typeof params.ttlHours !== "number" || !Number.isFinite(params.ttlHours) || params.ttlHours <= 0)) return "memory ttlHours must be a positive finite number.";
		return;
	}
	if (params.action === "recall") {
		if (params.query !== undefined && !str("query", 0, MAX_RECALL_QUERY_CHARS)) return `memory recall query exceeds ${MAX_RECALL_QUERY_CHARS} characters.`;
		if (params.scope !== undefined && !["long", "short", "both", "session", "project", "persona", "shared"].includes(String(params.scope))) return "unknown recall scope.";
		if (params.max !== undefined && (typeof params.max !== "number" || !Number.isFinite(params.max))) return "memory max must be a finite number.";
		return;
	}
	if (params.action === "read" || params.action === "forget" || params.action === "promote") {
		if (!isMemoryId(params.id)) return `memory ${params.action} needs a safe exact id.`;
		if (params.scope !== undefined && !(params.action === "promote" ? ["project", "persona", "shared"] : ["long", "short", "both", "session", "project", "persona", "shared"]).includes(String(params.scope))) return "invalid scope for memory action.";
		return;
	}
	const mode = params.mode ?? "inspect";
	if (!["inspect", "stage", "apply", "history", "undo"].includes(String(mode))) return "memory optimize mode must be inspect, stage, apply, history, or undo.";
	if (params.target !== undefined && !isOptimizeTarget(params.target)) return "memory optimize target must be project, project-long, persona, or shared.";
	if (params.query !== undefined && !str("query", 0, MAX_RECALL_QUERY_CHARS)) return `memory optimize query exceeds ${MAX_RECALL_QUERY_CHARS} characters.`;
	if (params.max !== undefined && (typeof params.max !== "number" || !Number.isSafeInteger(params.max) || params.max < 1 || params.max > 100)) return "memory optimize max must be an integer from 1 to 100.";
	if (params.offset !== undefined && (typeof params.offset !== "number" || !Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset > DEFAULT_STORE_MAX_ENTRIES)) return `memory optimize offset must be an integer from 0 to ${DEFAULT_STORE_MAX_ENTRIES}.`;
	if (mode === "history") {
		if (["query", "offset", "fingerprint", "operations", "planId", "receiptId"].some(has)) return "memory optimize history only accepts target and max.";
		return;
	}
	if (mode === "undo") {
		if (["query", "max", "offset", "fingerprint", "operations", "planId"].some(has)) return "memory optimize undo only accepts receiptId and target.";
		if (!str("receiptId", 1, 160) || params.target === undefined) return "memory optimize undo needs receiptId and an explicit target.";
		return;
	}
	if (mode === "inspect") {
		if (["fingerprint", "operations", "planId", "receiptId"].some(has)) return "memory optimize inspect only accepts target, query, max, and offset.";
		return;
	}
	if (mode === "stage") {
		if (["query", "max", "offset", "planId", "receiptId"].some(has)) return "memory optimize stage only accepts target, fingerprint, and operations.";
		if (!str("fingerprint", 1, 256) || !Array.isArray(params.operations) || params.operations.length < 1 || params.operations.length > MAX_OPTIMIZE_OPERATIONS || !Array.from(params.operations).every(isOptimizeOperation)) return `memory optimize stage needs a fingerprint and 1..${MAX_OPTIMIZE_OPERATIONS} bounded operations.`;
		const sourceCount = params.operations.reduce((sum: number, operation: { sourceIds: string[] }) => sum + operation.sourceIds.length, 0);
		if (sourceCount > MAX_OPTIMIZE_TOTAL_SOURCES || params.operations.length > MAX_OPTIMIZE_OPERATIONS) return `memory optimize stage allows at most ${MAX_OPTIMIZE_OPERATIONS} operations and ${MAX_OPTIMIZE_TOTAL_SOURCES} total source IDs.`;
		return;
	}
	if (["target", "query", "max", "offset", "fingerprint", "operations", "receiptId"].some(has)) return "memory optimize apply only accepts planId.";
	if (!str("planId", 1, 160)) return "memory optimize apply needs the id of a staged plan.";
}

async function runMemoryAction(mind: MindService, params: MemoryToolParams, ctx: ExtensionContext, sessionMemory?: SessionMemory, getOptimizer?: GetOptimizer, getActivity?: GetMindActivity): Promise<ToolResult> {
	if (params.action === "remember") {
		if (!params.term || !params.kind || !params.text) {
			return say("memory remember needs { term: long|short|session, kind, text }.", { ok: false, reason: "missing required fields" });
		}
		if (params.term === "session") {
			if (!sessionMemory) return say("Active-session memory is unavailable.", { ok: false, reason: "session_memory_unavailable" });
			const result = sessionMemory.remember(ctx, { kind: params.kind, text: params.text, ...(params.source === undefined ? {} : { source: params.source }) });
			return result.ok
				? say(`Remembered session note ${result.entry.id}. It belongs to this active session only.`, { ok: true, action: "remember", storage: result.storage, id: result.entry.id, summary: `Session note saved — ${compactMemoryText(result.entry.text, 80)}` })
				: say(`Not stored: ${result.reason}`, { ok: false, reason: result.reason });
		}
		const input: RememberInput = { term: params.term, kind: params.kind, text: params.text };
		if (params.tags) input.tags = params.tags;
		if (params.ttlHours !== undefined) input.ttlHours = params.ttlHours;
		if (params.supersedes) input.supersedes = params.supersedes;
		if (params.scope === "project" || params.scope === "persona" || params.scope === "shared") input.scope = params.scope;
		if (params.source) input.source = params.source;
		if (params.derivedFrom) input.derivedFrom = params.derivedFrom;
		const r = await mind.remember(input);
		return r.ok
			? say(`Remembered ${r.entry.id} — ${r.entry.expiresAt ? "short" : "long"}-term ${params.kind}. It will re-appear in your context.`, {
				id: r.entry.id,
				ok: true,
				scope: params.scope ?? (r.entry.expiresAt ? "project" : "persona"),
				summary: `${params.scope ?? (r.entry.expiresAt ? "project" : "persona")} · ${r.entry.expiresAt ? "working" : "durable"} saved — ${compactMemoryText(r.entry.text, 80)}`,
			})
			: say(`Not stored: ${r.reason}`, { ok: false, reason: r.reason });
	}

	if (params.action === "recall") {
		const query = params.query ?? "";
		if (query.length > MAX_RECALL_QUERY_CHARS) {
			return say(`memory recall query exceeds the ${MAX_RECALL_QUERY_CHARS}-character limit.`, {
				ok: false,
				reason: "query_too_long",
			});
		}
		const max = clampRecallMax(params.max);
		if (params.scope === "session") {
			if (!sessionMemory) return say("Active-session memory is unavailable.", { ok: false, reason: "session_memory_unavailable" });
			const result = sessionMemory.recall(ctx, { query, max });
			if (!result.ok) return say(`Session memory unavailable: ${result.reason ?? "read failed"}`, { ok: false, reason: result.reason ?? "session_read_failed" });
			if (result.hits.length === 0) return say(query ? "No active-session notes match the supplied query." : "There are no active-session notes.", { ok: true, storage: result.storage, count: 0, total: result.total, withheld: result.withheld, max: result.max, ids: [] });
			const lines = result.hits.map((note) => `- [${note.id}] (${note.kind}) ${compactMemoryText(note.text, 120)}`);
			return say(`${result.hits.length} session note(s)${result.withheld ? ` of ${result.total}` : ""}:\n${lines.join("\n")}${result.withheld ? `\n… +${result.withheld} more; narrow the query or raise max.` : ""}`, { ok: true, storage: result.storage, count: result.hits.length, total: result.total, withheld: result.withheld, max: result.max, ids: result.hits.map((note) => note.id) });
		}
		const nativeScope = params.scope ?? "both";
		const { hits, total, withheldUnsafe } = await mind.recall(query, nativeScope, max);
		if (hits.length === 0) return say(query ? "No memory matches the supplied query." : "Your memory is empty.", { count: 0, ok: true });
		const withheld = total - hits.length;
		const more = [
			withheld > 0 ? `… +${withheld} more match(es) — narrow the query or raise max.` : "",
			withheldUnsafe > 0 ? `⚠ ${withheldUnsafe} stored entr${withheldUnsafe === 1 ? "y was" : "ies were"} withheld as unsafe.` : "",
		]
			.filter(Boolean)
			.join("\n");
		const lines = hits.map((e) => `- [${e.id}] (${e.kind}) ${compactMemoryText(e.text, 80)}`);
		return say(`${hits.length} recalled${withheld > 0 ? ` of ${total}` : ""}:\n${lines.join("\n")}${more ? `\n${more}` : ""}`, {
			count: hits.length,
			total,
			max,
			withheld,
			withheldUnsafe,
			ids: hits.map((e) => e.id),
		});
	}

	if (params.action === "read") {
		if (!params.id) return say("memory read needs { id } (see recall).", { ok: false, reason: "missing id" });
		if (params.id.startsWith("session:")) {
			if (params.scope !== undefined && params.scope !== "session") return say("A session note id can only be read with scope=session.", { ok: false, reason: "scope_mismatch" });
			if (!sessionMemory) return say("Active-session memory is unavailable.", { ok: false, reason: "session_memory_unavailable" });
			const result = sessionMemory.read(ctx, params.id);
			if (!result.ok) return say(`Session note not found: ${result.reason}`, { ok: false, reason: result.reason });
			return say(`${result.entry.id} (${result.entry.kind}) · active session\nrecorded: ${result.entry.recordedAt}\norigin session: ${result.entry.originSessionId} (provenance only; not auto-resolved or imported)${result.entry.source ? `\nsource: ${result.entry.source}` : ""}\n\n${result.entry.text}`, { ok: true, storage: result.storage, entry: result.entry });
		}
		if (params.scope === "session") return say("scope=session requires a session:<UUID> note id.", { ok: false, reason: "scope_mismatch" });
		const nativeScope = params.scope ?? "both";
		const result = await mind.readMemory(params.id, nativeScope);
		if (!result.ok) return say(`Memory read refused: ${result.reason}`, { ok: false, reason: result.reason });
		const lines = result.entries.map(({ entry, target }) => `${entry.id} (${target}/${entry.kind})\nrecorded: ${entry.recordedAt} · last seen: ${entry.lastSeenAt}${entry.expiresAt ? ` · expires: ${entry.expiresAt}` : ""}${entry.source ? `\nsource: ${entry.source}` : ""}${entry.derivedFrom?.length ? `\nderived from: ${entry.derivedFrom.join(", ")}` : ""}${entry.tags.length ? `\ntags: ${entry.tags.join(", ")}` : ""}\n\n${entry.text}`);
		const suffix = result.withheld ? `\n\n${result.withheld} identical-scope copy/copies omitted.` : "";
		return say(`${lines.join("\n\n---\n\n")}${suffix}`, { ok: true, total: result.total, withheld: result.withheld, entries: result.entries });
	}

	if (params.action === "optimize") {
		if (!getOptimizer) return say("Memory optimization is unavailable.", { ok: false, reason: "optimizer_unavailable" });
		const ownerCurrent = sessionMemory?.captureOwner(ctx);
		if (ownerCurrent && !ownerCurrent()) return say("The active session owner is unavailable; no optimization ran.", { ok: false, reason: "owner_unavailable" });
		const optimizer = getOptimizer(ctx);
		const input = {
			mode: params.mode ?? "inspect",
			...(params.target === undefined ? {} : { target: params.target }),
			...(params.query === undefined ? {} : { query: params.query }),
			...(params.max === undefined ? {} : { max: params.max }),
			...(params.offset === undefined ? {} : { offset: params.offset }),
			...(params.fingerprint === undefined ? {} : { fingerprint: params.fingerprint }),
			...(params.operations === undefined ? {} : { operations: params.operations }),
			...(params.planId === undefined ? {} : { planId: params.planId }),
			...(params.receiptId === undefined ? {} : { receiptId: params.receiptId }),
		} as const;
		const phase = input.mode === "history" ? "inspect" : input.mode === "undo" ? "apply" : input.mode;
		let target = input.target ?? "project";
		let hasTarget = true;
		if (input.mode === "apply") {
			const plan = input.planId ? optimizer.getPlan(input.planId) : undefined;
			if (plan?.ok) target = plan.target;
			else hasTarget = false;
		}
		const operation = () => runOptimizeAction(optimizer, input);
		const result = hasTarget
			? await runMindActivity(getActivity?.(ctx), phase, target, operation, (outcome) => outcome.details.ok === true)
			: await operation();
		let current = false;
		try { current = (!ownerCurrent || ownerCurrent()) && (!sessionMemory || sessionMemory.isCurrent(ctx)) && getOptimizer(ctx) === optimizer; }
		catch { current = false; }
		if (!current) {
			if (params.mode === "undo" && result.details.ok === true) return say("Memory undo completed before the active owner changed. Inspect the target memory before further edits.", { ok: true, outcome: "undone_before_owner_change", receiptId: result.details.receiptId });
			if (params.mode === "undo") return say("The active owner changed while undo was running. Inspect the target memory before retrying; the mutation outcome may be unknown.", { ok: false, outcome: "unknown", reason: "owner_changed" });
			if (params.mode === "apply" && result.details.ok === true) return say("The staged memory plan was applied before the active owner changed. Inspect the target memory before any further edits.", { ok: true, outcome: "applied_before_owner_change", planId: result.details.planId });
			if (params.mode === "apply") return say("The active owner changed while apply was running. Inspect the target memory before retrying; the mutation outcome may be unknown.", { ok: false, outcome: "unknown", reason: "owner_changed" });
			return say("The active memory owner changed while this read-only or staging operation was running; no stale result or plan was returned.", { ok: false, reason: "owner_changed" });
		}
		return result;
	}

	if (params.action === "promote") {
		if (!params.id) return say("memory promote needs { id } (a short-term memory to make durable).", { ok: false, reason: "missing id" });
		const target = params.scope === "persona" || params.scope === "shared" ? params.scope : "project";
		const r = await mind.promote(params.id, target);
		if (!r.ok) return say(r.reason ? `Not promoted: ${r.reason}` : `No live short-term memory with id "${params.id}".`, { ok: false, ...(r.reason ? { reason: r.reason } : {}) });
		// The graduation stands, but the lineage handle it carried over may be one of the shared v1 ids the
		// store refuses to act on — say so, or a bare "Promoted" reads as "and the old fact is retired".
		const skipped = r.ambiguousSupersedes
			? ` Its supersedes id ${r.ambiguousSupersedes} is shared by several stored memories, so nothing was retired — recall them and retire the one you meant by its own id.`
			: "";
		return say(`Promoted ${params.id} to durable ${target} memory — it will no longer decay.${skipped}`, {
			ok: true,
			id: params.id,
			...(r.ambiguousSupersedes ? { ambiguousSupersedes: r.ambiguousSupersedes } : {}),
		});
	}

	// forget
	if (!params.id) return say("memory forget needs { id } (see recall).", { ok: false, reason: "missing id" });
	if (params.id.startsWith("session:")) {
		if (!sessionMemory) return say("Active-session memory is unavailable.", { ok: false, reason: "session_memory_unavailable" });
		const result = sessionMemory.forget(ctx, params.id);
		return result.ok
			? say(`Forgot active-session note ${params.id}. The transcript history remains; the note is tombstoned on this branch.`, { ok: true, storage: result.storage, removed: result.removed })
			: say(`Session note not forgotten: ${result.reason}`, { ok: false, reason: result.reason });
	}
	if (params.scope === "session") return say("scope=session requires a session note id.", { ok: false });
	const { removed, reason, candidates } = await mind.forget(params.id, params.scope ?? "both");
	if (removed > 0) return say(`Forgot ${params.id}.`, { ok: true, removed });
	if (reason !== "ambiguous_id") return say(`No memory with id "${params.id}".`, { ok: false, removed: 0, reason: "not_found" });
	// A refusal the caller cannot act on leaves a store nobody can ever repair, so name each colliding
	// fact by an id of its own. The one still holding the shared handle becomes addressable once the
	// others are gone — the collision shrinks by one with every delete.
	const shown = (candidates ?? []).slice(0, MAX_AMBIGUITY_CANDIDATES_SHOWN);
	const rest = (candidates?.length ?? 0) - shown.length;
	const lines = shown.map((c) => `- [${c.id}] (${c.kind}) ${compactMemoryText(c.text, 120)}${c.resolves ? "" : " — still the shared handle; forget the others first"}`);
	return say(
		[
			`Memory id "${params.id}" is a legacy handle shared by ${candidates?.length ?? 0} distinct memories, so nothing was deleted.`,
			"Forget the one you meant by its own current id:",
			...lines,
			rest > 0 ? `… +${rest} more share that handle.` : "",
		]
			.filter(Boolean)
			.join("\n"),
		{ ok: false, removed: 0, reason, candidates: shown.map((c) => ({ id: c.id, kind: c.kind, resolves: c.resolves })) },
	);
}
