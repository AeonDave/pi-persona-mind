/**
 * pi-persona-mind — a durable, persona-aware mind for Pi supervisors.
 *
 * Wires the two agent-facing tools (memory, backlog), injects the deterministic <persona-mind>
 * block into the system prompt every turn (so memory survives compaction + restart), re-arms
 * durable backlog wake timers on session start, and offers a read-only `/mind` view. All heavy
 * lifting lives in the pure core; this factory is thin. The only coupling to pi-persona is a
 * best-effort read of its active-persona marker (see core/scope.ts); absent it, everything runs
 * under a `_default` scope.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveScope } from "./core/scope.ts";
import { MindService } from "./core/service.ts";
import { registerBacklogTool } from "./tools/backlog.ts";
import { registerMemoryTool } from "./tools/memory.ts";

const STATUS_KEY = "pi-persona-mind";

export interface ExtensionOptions {
	/** Override the agent dir (tests). Defaults to Pi's getAgentDir(). */
	agentDir?: string;
}

/** Build the extension. Exported (separately from the default factory) so tests can inject agentDir. */
export function createExtension(pi: ExtensionAPI, opts: ExtensionOptions = {}): void {
	const agentDir = opts.agentDir ?? getAgentDir();
	const getMind = (ctx: ExtensionContext): MindService => new MindService(resolveScope(agentDir, ctx.cwd));

	registerMemoryTool(pi, getMind);
	registerBacklogTool(pi, getMind);

	// Backlog wake timers (opt-in per item via dueInSeconds). In-memory, unref'd, re-armed from disk
	// on every session start so they survive a restart; cleared on shutdown.
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const clearTimers = (): void => {
		for (const t of timers.values()) clearTimeout(t);
		timers.clear();
	};
	const armWakes = async (ctx: ExtensionContext): Promise<void> => {
		clearTimers();
		const now = Date.now();
		let items: Awaited<ReturnType<MindService["backlogList"]>>;
		try {
			items = await getMind(ctx).backlogList({ all: true });
		} catch {
			return;
		}
		for (const item of items) {
			if ((item.state !== "open" && item.state !== "taken") || item.dueAtEpochMs === undefined) continue;
			const delay = item.dueAtEpochMs - now;
			if (delay <= 0 || timers.has(item.id)) continue;
			const t = setTimeout(() => {
				timers.delete(item.id);
				try {
					pi.sendUserMessage(
						`[pi-persona-mind] backlog due — ${item.text} (id ${item.id}). Use \`backlog take ${item.id}\` to act on it, or \`backlog drop ${item.id}\`.`,
					);
				} catch {
					/* delivery raced shutdown — the item is still in the backlog and re-arms next session */
				}
			}, delay);
			t.unref?.();
			timers.set(item.id, t);
		}
	};

	const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
		try {
			const s = await getMind(ctx).summary();
			const label = `mind ${s.ltm}L·${s.stm}S · backlog ${s.backlogOpen}`;
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme ? ctx.ui.theme.fg("dim", label) : label);
		} catch {
			/* status is cosmetic — never break a turn for it */
		}
	};

	// Inject the mind into every turn. before_agent_start re-fires after compaction, so this is also
	// how memory survives compaction: it re-injects from disk. Never throws into the turn.
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const block = await getMind(ctx).buildInjection();
			if (block) return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
		} catch {
			/* a mind failure must never break the supervisor's turn */
		}
		return;
	});

	pi.on("session_start", async (_event, ctx) => {
		await armWakes(ctx);
		await refreshStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		clearTimers();
	});

	// Read-only human view of what is currently in the mind (and injected each turn).
	pi.registerCommand("mind", {
		description: "Show this persona's mind — long-term memory, working context, and open backlog",
		handler: async (_args, ctx) => {
			const mind = getMind(ctx);
			const [summary, block] = await Promise.all([mind.summary(), mind.buildInjection()]);
			const header = `pi-persona-mind — ${summary.ltm} long-term · ${summary.stm} short-term · ${summary.backlogOpen} open backlog`;
			ctx.ui.notify(block ? `${header}\n\n${block}` : `${header}\n\n(empty)`, "info");
		},
	});
}

export default function piPersonaMind(pi: ExtensionAPI): void {
	createExtension(pi);
}
