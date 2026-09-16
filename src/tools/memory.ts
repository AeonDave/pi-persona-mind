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

export type GetMind = (ctx: ExtensionContext) => MindService;

const MemoryParams = Type.Object({
	action: Type.Union([Type.Literal("remember"), Type.Literal("recall"), Type.Literal("forget"), Type.Literal("promote")], {
		description: "remember = store a fact · recall = search · forget = delete by id · promote = graduate a short-term memory to durable long-term",
	}),
	term: Type.Optional(
		Type.Union([Type.Literal("long"), Type.Literal("short")], {
			description:
				"remember: long = durable identity for this persona (preferences/conventions/lessons); short = a project note that auto-deletes after ~48h. Required for remember.",
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
	shared: Type.Optional(
		Type.Boolean({ description: "remember(long): store in the cross-persona shared tier — facts true for EVERY persona (e.g. the user's OS)" }),
	),
	source: Type.Optional(Type.String({ maxLength: MAX_MEMORY_SOURCE_CHARS, description: "remember: optional human-citable origin of this fact (e.g. 'the user said', 'child scout')" })),
	derivedFrom: Type.Optional(Type.Array(Type.String({ maxLength: MAX_MEMORY_ID_CHARS }), { maxItems: MAX_MEMORY_DERIVED_IDS, description: "remember: optional ids of memories distilled into this fact" })),
	query: Type.Optional(Type.String({ maxLength: MAX_RECALL_QUERY_CHARS, description: "recall: keywords (empty = most recent)" })),
	scope: Type.Optional(
		Type.Union([Type.Literal("long"), Type.Literal("short"), Type.Literal("both")], { description: "recall: which tier to search (default both)" }),
	),
	max: Type.Optional(Type.Number({ description: "recall: maximum results, clamped to 1..50 (default 8)" })),
	id: Type.Optional(Type.String({ maxLength: MAX_MEMORY_ID_CHARS, description: "forget/promote: the id of the entry" })),
});

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

export function registerMemoryTool(pi: ExtensionAPI, getMind: GetMind): void {
	pi.registerTool({
		name: "memory",
		label: "Memory",
		promptSnippet: "memory — persist or recall durable preferences, decisions, invariants, lessons, and short-lived project context",
		promptGuidelines: [
			"Before the final answer, use `memory` once when this turn established a durable user preference, architectural decision/invariant, or verified lesson that is not simply re-derivable from the repository. A user who explicitly labels a fact durable/permanent is asking for capture even without the word 'remember'. Use `backlog` for unfinished intent. Skip routine transcript, guesses, and secrets.",
		],
		description: [
			"Your durable, persona-scoped memory. `remember` a fact so it survives context compaction and",
			"restarts — long-term for who this persona is to the user (preferences/conventions/lessons),",
			"short-term for project notes that auto-delete after ~48h. `recall` to search; `forget` by id.",
			"Facts are re-injected into your context automatically each turn, so remember what you would",
			"want to know next session. Keep entries DECLARATIVE, never store secrets.",
		].join(" "),
		parameters: MemoryParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				return await runMemoryAction(getMind(ctx), params);
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
			if (savedTerm) {
				const summary = typeof details?.summary === "string"
					? details.summary
					: `${savedTerm === "long" ? "Long" : "Short"}-term saved`;
				return renderExpandableResult(summary, true, theme);
			}
			return renderExpandableResult(body, expanded, theme);
		},
	});
}

async function runMemoryAction(mind: MindService, params: MemoryToolParams): Promise<ToolResult> {
	if (params.action === "remember") {
		if (!params.term || !params.kind || !params.text) {
			return say("memory remember needs { term: long|short, kind, text }.", { ok: false, reason: "missing required fields" });
		}
		const input: RememberInput = { term: params.term, kind: params.kind, text: params.text };
		if (params.tags) input.tags = params.tags;
		if (params.ttlHours !== undefined) input.ttlHours = params.ttlHours;
		if (params.supersedes) input.supersedes = params.supersedes;
		if (params.shared) input.toShared = params.shared;
		if (params.source) input.source = params.source;
		if (params.derivedFrom) input.derivedFrom = params.derivedFrom;
		const r = await mind.remember(input);
		return r.ok
			? say(`Remembered ${r.entry.id} — ${r.entry.expiresAt ? "short" : "long"}-term ${params.kind}. It will re-appear in your context.`, {
				id: r.entry.id,
				ok: true,
				summary: `${r.entry.expiresAt ? "Short" : "Long"}-term saved — ${compactMemoryText(r.entry.text, 80)}`,
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
		const { hits, total, withheldUnsafe } = await mind.recall(query, params.scope ?? "both", max);
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

	if (params.action === "promote") {
		if (!params.id) return say("memory promote needs { id } (a short-term memory to make durable).", { ok: false, reason: "missing id" });
		const r = await mind.promote(params.id);
		if (!r.ok) return say(r.reason ? `Not promoted: ${r.reason}` : `No live short-term memory with id "${params.id}".`, { ok: false, ...(r.reason ? { reason: r.reason } : {}) });
		// The graduation stands, but the lineage handle it carried over may be one of the shared v1 ids the
		// store refuses to act on — say so, or a bare "Promoted" reads as "and the old fact is retired".
		const skipped = r.ambiguousSupersedes
			? ` Its supersedes id ${r.ambiguousSupersedes} is shared by several stored memories, so nothing was retired — recall them and retire the one you meant by its own id.`
			: "";
		return say(`Promoted ${params.id} to long-term — it will no longer decay.${skipped}`, {
			ok: true,
			id: params.id,
			...(r.ambiguousSupersedes ? { ambiguousSupersedes: r.ambiguousSupersedes } : {}),
		});
	}

	// forget
	if (!params.id) return say("memory forget needs { id } (see recall).", { ok: false, reason: "missing id" });
	const { removed, reason, candidates } = await mind.forget(params.id);
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
