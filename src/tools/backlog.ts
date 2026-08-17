/**
 * The `backlog` tool — the agent-facing surface for deferred intent.
 *
 * A backlog item is a lead or task the supervisor means to act on later. Unlike short-term memory
 * it does not decay: it is `done` or `dropped`, never silently lost. Open items are re-injected
 * each turn, and an item can carry a wake time. Thin glue over MindService.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { BacklogAddInput, BacklogListOptions, MindService } from "../core/service.ts";
import { clampBacklogMax, MAX_BACKLOG_ID_CHARS, MAX_BACKLOG_NOTE_CHARS, MAX_BACKLOG_TAGS, MAX_BACKLOG_TAG_CHARS, MAX_BACKLOG_TEXT_CHARS } from "../core/backlog.ts";
import { compactMemoryText } from "../core/memory.ts";

export type GetMind = (ctx: ExtensionContext) => MindService;

const BacklogParams = Type.Object({
	action: Type.Union(
		[Type.Literal("add"), Type.Literal("list"), Type.Literal("take"), Type.Literal("done"), Type.Literal("drop")],
		{ description: "add = queue a lead · list = show items · take = claim (in progress) · done / drop = close" },
	),
	text: Type.Optional(Type.String({ maxLength: MAX_BACKLOG_TEXT_CHARS, description: "add: the lead/task to defer. Required for add." })),
	tags: Type.Optional(Type.Array(Type.String({ maxLength: MAX_BACKLOG_TAG_CHARS }), { maxItems: MAX_BACKLOG_TAGS, description: "add: optional tags" })),
	dueInSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "add: wake me about this item after N seconds (a durable alarm re-armed across restarts)" })),
	id: Type.Optional(Type.String({ maxLength: MAX_BACKLOG_ID_CHARS, description: "take/done/drop: the item id (see list)" })),
	note: Type.Optional(Type.String({ maxLength: MAX_BACKLOG_NOTE_CHARS, description: "done/drop: why (optional)" })),
	state: Type.Optional(
		Type.Union([Type.Literal("open"), Type.Literal("taken"), Type.Literal("done"), Type.Literal("dropped")], {
			description: "list: filter to this state; omitted means unfinished open/taken work",
		}),
	),
	all: Type.Optional(Type.Boolean({ description: "list: include every persona's items (default: only this persona's)" })),
	max: Type.Optional(Type.Number({ description: "list: maximum results, clamped to 1..50 (default 20)" })),
});

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

function say(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

function durationLabel(milliseconds: number): string {
	const seconds = Math.max(1, Math.ceil(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.ceil(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.ceil(hours / 24);
	return `${days}d`;
}

/** Render both sides of a due date correctly; ageLabel is intentionally past-only. */
export function formatDueTime(epochMs: number, now = Date.now()): string {
	if (!Number.isFinite(epochMs)) return "unknown";
	const delta = epochMs - now;
	if (Math.abs(delta) < 1_000) return "now";
	return delta > 0 ? `in ${durationLabel(delta)}` : `${durationLabel(-delta)} overdue`;
}

export function registerBacklogTool(pi: ExtensionAPI, getMind: GetMind): void {
	pi.registerTool({
		name: "backlog",
		label: "Backlog",
		promptSnippet: "backlog — persist unfinished or blocked project intent across compaction and restarts",
		promptGuidelines: [
			"When work is deferred, blocked, or deliberately left incomplete, record one actionable `backlog add`; close it with `done` or `drop` when resolved. Do not queue routine next steps you will complete in the current turn.",
		],
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
				if (!params.text) return say("backlog add needs { text }.", { ok: false, reason: "missing text" });
				const input: BacklogAddInput = { text: params.text };
				if (params.tags) input.tags = params.tags;
				if (params.dueInSeconds !== undefined) input.dueInSeconds = params.dueInSeconds;
				const r = await mind.backlogAdd(input);
				return r.ok ? say(`Queued ${r.entry.id}: ${compactMemoryText(r.entry.text)}`, { id: r.entry.id, ok: true }) : say(`Not queued: ${r.reason}`, { ok: false, reason: r.reason });
			}

			if (params.action === "list") {
				const opts: BacklogListOptions = {};
				if (params.all) opts.all = true;
				if (params.state) opts.state = params.state;
				const max = clampBacklogMax(params.max);
				const page = await mind.backlogListPage({ ...opts, max });
				if (page.items.length === 0) return say(page.total > 0 ? "No backlog items match this filter." : "Backlog is empty.", { count: 0, total: page.total, withheld: page.withheld, max });
				const now = Date.now();
				const lines = page.items.map((e) => {
					const due = e.dueAtEpochMs !== undefined ? ` · due ${formatDueTime(e.dueAtEpochMs, now)}` : "";
					const note = e.note ? ` · note: ${compactMemoryText(e.note)}` : "";
					return `- [${e.id}] (${e.state}) ${compactMemoryText(e.text)}${due}${note}`;
				});
				const more = page.withheld > 0 ? `\n… +${page.withheld} more item(s) — raise max or narrow the filter.` : "";
				return say(`${page.items.length}${page.withheld > 0 ? ` of ${page.total}` : ""} item(s):\n${lines.join("\n")}${more}`, { count: page.items.length, total: page.total, withheld: page.withheld, max });
			}

			// take / done / drop
			if (!params.id) return say(`backlog ${params.action} needs { id } (see list).`, { ok: false, reason: "missing id" });
			const state = params.action === "take" ? "taken" : params.action === "done" ? "done" : "dropped";
			const r = await mind.backlogSet(params.id, state, params.note);
			return r.ok
				? say(`${params.id} → ${state}.`, { id: params.id, state, ok: true })
				: say(`Not updated: ${r.reason ?? `backlog item "${params.id}" does not exist or cannot transition to ${state}`}.`, { ok: false, reason: r.reason ?? "invalid state transition" });
		},
	});
}
