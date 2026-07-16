/**
 * The `backlog` tool — the agent-facing surface for deferred intent.
 *
 * A backlog item is a lead or task the supervisor means to act on later. Unlike short-term memory
 * it does not decay: it is `done` or `dropped`, never silently lost. Open items are re-injected
 * each turn, and an item can carry a wake time. Thin glue over MindService.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { BacklogAddInput, MindService } from "../core/service.ts";
import { ageLabel } from "../core/memory.ts";

export type GetMind = (ctx: ExtensionContext) => MindService;

const BacklogParams = Type.Object({
	action: Type.Union(
		[Type.Literal("add"), Type.Literal("list"), Type.Literal("take"), Type.Literal("done"), Type.Literal("drop")],
		{ description: "add = queue a lead · list = show items · take = claim (in progress) · done / drop = close" },
	),
	text: Type.Optional(Type.String({ description: "add: the lead/task to defer. Required for add." })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "add: optional tags" })),
	dueInSeconds: Type.Optional(Type.Number({ description: "add: wake me about this item after N seconds (a durable alarm re-armed across restarts)" })),
	id: Type.Optional(Type.String({ description: "take/done/drop: the item id (see list)" })),
	note: Type.Optional(Type.String({ description: "done/drop: why (optional)" })),
	state: Type.Optional(
		Type.Union([Type.Literal("open"), Type.Literal("taken"), Type.Literal("done"), Type.Literal("dropped")], {
			description: "list: filter to this state (default: all states)",
		}),
	),
	all: Type.Optional(Type.Boolean({ description: "list: include every persona's items (default: only this persona's)" })),
});

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

function say(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

export function registerBacklogTool(pi: ExtensionAPI, getMind: GetMind): void {
	pi.registerTool({
		name: "backlog",
		label: "Backlog",
		description: [
			"Your deferred-intent backlog — leads and tasks to come back to, per project. `add` a lead so",
			"you never lose it to compaction, a restart, or a persona switch; optionally attach a wake time.",
			"`take` to claim one, `done`/`drop` to close it, `list` to review. Open items are re-injected",
			"into your context each turn. Park a blocked vector here instead of abandoning it.",
		].join(" "),
		parameters: BacklogParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mind = getMind(ctx);

			if (params.action === "add") {
				if (!params.text) return say("backlog add needs { text }.");
				const input: BacklogAddInput = { text: params.text };
				if (params.tags) input.tags = params.tags;
				if (params.dueInSeconds !== undefined) input.dueInSeconds = params.dueInSeconds;
				const r = await mind.backlogAdd(input);
				return r.ok ? say(`Queued ${r.entry.id}: ${r.entry.text}`, { id: r.entry.id, ok: true }) : say(`Not queued: ${r.reason}`, { ok: false, reason: r.reason });
			}

			if (params.action === "list") {
				const opts: { all?: boolean; state?: typeof params.state } = {};
				if (params.all) opts.all = true;
				if (params.state) opts.state = params.state;
				const items = await mind.backlogList(opts);
				if (items.length === 0) return say("Backlog is empty.", { count: 0 });
				const now = Date.now();
				const lines = items.map((e) => {
					const due = e.dueAtEpochMs !== undefined ? ` · due ${ageLabel(new Date(e.dueAtEpochMs).toISOString(), now)}` : "";
					return `- [${e.id}] (${e.state}) ${e.text}${due}`;
				});
				return say(`${items.length} item(s):\n${lines.join("\n")}`, { count: items.length });
			}

			// take / done / drop
			if (!params.id) return say(`backlog ${params.action} needs { id } (see list).`);
			const state = params.action === "take" ? "taken" : params.action === "done" ? "done" : "dropped";
			const r = await mind.backlogSet(params.id, state, params.note);
			return r.ok ? say(`${params.id} → ${state}.`, { id: params.id, state, ok: true }) : say(`No open item with id "${params.id}".`, { ok: false });
		},
	});
}
