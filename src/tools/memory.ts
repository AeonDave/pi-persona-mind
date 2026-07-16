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

import { MEMORY_KINDS } from "../core/memory.ts";
import type { MindService, RememberInput } from "../core/service.ts";

export type GetMind = (ctx: ExtensionContext) => MindService;

const MemoryParams = Type.Object({
	action: Type.Union([Type.Literal("remember"), Type.Literal("recall"), Type.Literal("forget")], {
		description: "remember = store a fact · recall = search · forget = delete by id",
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
			description:
				"remember: the fact, DECLARATIVE not imperative ('the user prefers verbose recon', never 'always be verbose'). Do not store secrets or anything re-derivable from the repo. Required for remember.",
		}),
	),
	tags: Type.Optional(Type.Array(Type.String(), { description: "optional tags to aid later recall" })),
	ttlHours: Type.Optional(Type.Number({ description: "remember(short): hours until it decays out of context (default 48)" })),
	supersedes: Type.Optional(Type.String({ description: "remember: id of an existing entry this one replaces" })),
	shared: Type.Optional(
		Type.Boolean({ description: "remember(long): store in the cross-persona shared tier — facts true for EVERY persona (e.g. the user's OS)" }),
	),
	query: Type.Optional(Type.String({ description: "recall: keywords (empty = most recent)" })),
	scope: Type.Optional(
		Type.Union([Type.Literal("long"), Type.Literal("short"), Type.Literal("both")], { description: "recall: which tier to search (default both)" }),
	),
	max: Type.Optional(Type.Number({ description: "recall: maximum results (default 8)" })),
	id: Type.Optional(Type.String({ description: "forget: the id of the entry to delete" })),
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
					return say("memory remember needs { term: long|short, kind, text }.");
				}
				const input: RememberInput = { term: params.term, kind: params.kind, text: params.text };
				if (params.tags) input.tags = params.tags;
				if (params.ttlHours !== undefined) input.ttlHours = params.ttlHours;
				if (params.supersedes) input.supersedes = params.supersedes;
				if (params.shared) input.toShared = params.shared;
				const r = await mind.remember(input);
				return r.ok
					? say(`Remembered ${r.entry.id} — ${params.term}-term ${params.kind}. It will re-appear in your context.`, { id: r.entry.id, ok: true })
					: say(`Not stored: ${r.reason}`, { ok: false, reason: r.reason });
			}

			if (params.action === "recall") {
				const hits = await mind.recall(params.query ?? "", params.scope ?? "both", params.max ?? 8);
				if (hits.length === 0) return say(params.query ? `No memory matches "${params.query}".` : "Your memory is empty.", { count: 0 });
				const lines = hits.map((e) => `- [${e.id}] (${e.kind}) ${e.text}`);
				return say(`${hits.length} recalled:\n${lines.join("\n")}`, { count: hits.length, ids: hits.map((e) => e.id) });
			}

			// forget
			if (!params.id) return say("memory forget needs { id } (see recall).");
			const { removed } = await mind.forget(params.id);
			return removed > 0
				? say(`Forgot ${params.id}.`, { ok: true, removed })
				: say(`No memory with id "${params.id}".`, { ok: false, removed: 0 });
		},
	});
}
