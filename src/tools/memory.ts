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
				"remember: long = durable identity for this persona (preferences/conventions/lessons); short = a project note that decays (defaults expiry 48h). Required for remember.",
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
	ttlHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "remember(short): hours until it decays out of context (default 48)" })),
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
			"short-term for project notes that go stale (they decay). `recall` to search; `forget` by id.",
			"Facts are re-injected into your context automatically each turn, so remember what you would",
			"want to know next session. Keep entries DECLARATIVE, never store secrets.",
		].join(" "),
		parameters: MemoryParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mind = getMind(ctx);

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
					? say(`Remembered ${r.entry.id} — ${r.entry.expiresAt ? "short" : "long"}-term ${params.kind}. It will re-appear in your context.`, { id: r.entry.id, ok: true })
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
				const lines = hits.map((e) => `- [${e.id}] (${e.kind}) ${compactMemoryText(e.text)}`);
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
				return r.ok
					? say(`Promoted ${params.id} to long-term — it will no longer decay.`, { ok: true, id: params.id })
					: say(r.reason ? `Not promoted: ${r.reason}` : `No live short-term memory with id "${params.id}".`, { ok: false, ...(r.reason ? { reason: r.reason } : {}) });
			}

			// forget
			if (!params.id) return say("memory forget needs { id } (see recall).", { ok: false, reason: "missing id" });
			const { removed, reason } = await mind.forget(params.id);
			return removed > 0
				? say(`Forgot ${params.id}.`, { ok: true, removed })
				: reason === "ambiguous_id"
					? say(`Memory id "${params.id}" is ambiguous after legacy migration; recall the entries and forget one by its current id. Nothing was deleted.`, { ok: false, removed: 0, reason })
					: say(`No memory with id "${params.id}".`, { ok: false, removed: 0, reason: "not_found" });
		},
	});
}
