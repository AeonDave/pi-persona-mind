/**
 * pi-persona-mind — a durable, persona-aware mind for Pi supervisors.
 *
 * Wires the two agent-facing tools (memory, backlog), injects the deterministic <persona-mind>
 * block into the system prompt every turn (so memory survives compaction + restart), re-arms
 * durable backlog wake timers on session start AND delivers any that came due while offline, and
 * offers a read-only `/mind` view. All heavy lifting lives in the pure core; this factory is thin.
 * The only coupling to pi-persona is a best-effort read of its active-persona marker (see
 * core/scope.ts); absent it, everything runs under a `_default` scope.
 */

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { detectBlockedLeg } from "./core/blocked.ts";
import { detectCaptureCue } from "./core/capture.ts";
import { preferredAgentDir, resolveScope } from "./core/scope.ts";
import { MindService } from "./core/service.ts";
import { registerBacklogTool } from "./tools/backlog.ts";
import { registerMemoryTool } from "./tools/memory.ts";

const STATUS_KEY = "pi-persona-mind";
/** A stalled read must never freeze a turn: injection degrades to nothing past this deadline. */
const INJECT_DEADLINE_MS = 750;
/** A wake-owner lock older than this (with no liveness signal) is considered abandoned. */
const OWNER_STALE_MS = 120_000;

// Unique per extension instance (not just per process): two instances in one process must not both
// believe they own the wake lock. Date/random are fine in the real runtime (unlike workflow scripts).
let ownerInstanceSeq = 0;

export interface ExtensionOptions {
	/** Override the agent dir (tests). Defaults to Pi's getAgentDir(). */
	agentDir?: string;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function ownerIsStale(path: string, token: string): boolean {
	try {
		const content = readFileSync(path, "utf8");
		if (content === token) return false; // ours
		const colon = content.indexOf(":");
		const host = colon < 0 ? "" : content.slice(0, colon);
		const pid = colon < 0 ? NaN : Number.parseInt(content.slice(colon + 1), 10);
		if (host === hostname() && Number.isInteger(pid) && pid > 0 && !isAlive(pid)) return true; // dead local holder
		return Date.now() - statSync(path).mtimeMs > OWNER_STALE_MS;
	} catch {
		return true; // vanished between checks
	}
}

/** Non-blocking claim of the per-project wake-firer lock. Only the owner arms/fires wakes. */
function claimWakeOwner(path: string, token: string): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx");
			writeSync(fd, token);
			closeSync(fd);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
			try {
				if (readFileSync(path, "utf8") === token) return true; // re-claim ours
			} catch {
				/* fall through */
			}
			if (!ownerIsStale(path, token)) return false; // a live holder owns it
			try {
				unlinkSync(path);
			} catch {
				/* raced */
			}
		}
	}
	return false;
}

function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((res) => {
			const t = setTimeout(() => res(fallback), ms);
			t.unref?.();
		}),
	]);
}

/** Build the extension. Exported (separately from the default factory) so tests can inject agentDir. */
export function createExtension(pi: ExtensionAPI, opts: ExtensionOptions = {}): void {
	// Mirror pi-persona's own PI_AGENT_DIR precedence so both extensions co-locate their data (and the
	// mind never reads a stale/missing marker under the wrong root). getAgentDir() stays lazy — only
	// called when neither an explicit override (tests) nor PI_AGENT_DIR is set.
	const agentDir = preferredAgentDir(opts.agentDir) ?? getAgentDir();
	const nudgeEnabled = process.env.PI_PERSONA_MIND_NUDGE !== "off";
	const ownerToken = `${hostname()}:${process.pid}:${++ownerInstanceSeq}`;
	const getMind = (ctx: ExtensionContext): MindService => new MindService(resolveScope(agentDir, ctx.cwd));

	// A DELEGATED worker leg? pi-persona disables ITSELF in sub-agent sessions (fork-bomb guard) via
	// PI_PERSONA_DISABLE (in-process, set transiently around session creation) / PI_PERSONA_CHILD
	// (child process, set for its whole lifetime). Sampled HERE at factory time because the in-process
	// flag is popped before the turn runs. A worker is not the persona: it inherits only the lean mind
	// (north-star + identity — see buildInjection), and must NOT manage the supervisor's memory or fire
	// its wakes. Absent the flags (the normal supervisor), everything runs full — behavior is unchanged.
	const isDelegatedLeg = process.env.PI_PERSONA_DISABLE === "1" || process.env.PI_PERSONA_CHILD === "1";

	// Withhold the write tools from a worker: a leg reading/writing the supervisor persona's LTM/STM/
	// backlog is exactly the bleed we prevent. It still INHERITS the lean block below (read-only, curated).
	if (!isDelegatedLeg) {
		registerMemoryTool(pi, getMind);
		registerBacklogTool(pi, getMind);
	}

	// Backlog wake timers — only the elected owner session arms/fires them, so concurrent sessions
	// never double-deliver. In-memory, unref'd, re-armed from disk on session start; cleared on shutdown.
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	let ownerPath: string | undefined;
	const clearTimers = (): void => {
		for (const t of timers.values()) clearTimeout(t);
		timers.clear();
	};
	const armWakes = async (ctx: ExtensionContext): Promise<void> => {
		clearTimers();
		const scope = resolveScope(agentDir, ctx.cwd);
		ownerPath = `${scope.paths.backlog}.wakeowner`;
		if (!claimWakeOwner(ownerPath, ownerToken)) {
			ownerPath = undefined; // another live session owns the wakes; we still inject, just don't fire
			return;
		}
		const mind = new MindService(scope);
		const now = Date.now();
		let all: Awaited<ReturnType<MindService["backlogList"]>>;
		let due: Awaited<ReturnType<MindService["dueBacklog"]>>;
		try {
			[all, due] = await Promise.all([mind.backlogList({ all: true }), mind.dueBacklog()]);
		} catch {
			return;
		}
		// (rank 3) Deliver items that came due while offline as ONE combined reminder, instead of dropping them.
		if (due.length > 0) {
			try {
				const list = due.map((e) => `• ${e.text} (id ${e.id})`).join("\n");
				pi.sendUserMessage(`[pi-persona-mind] ${due.length} backlog item(s) came due while you were away:\n${list}\nUse \`backlog take <id>\` or \`backlog drop <id>\`.`);
			} catch {
				/* raced shutdown */
			}
		}
		// Schedule the future ones.
		for (const item of all) {
			if ((item.state !== "open" && item.state !== "taken") || item.dueAtEpochMs === undefined) continue;
			const delay = item.dueAtEpochMs - now;
			if (delay <= 0 || timers.has(item.id)) continue;
			const t = setTimeout(() => {
				timers.delete(item.id);
				try {
					pi.sendUserMessage(`[pi-persona-mind] backlog due — ${item.text} (id ${item.id}). Use \`backlog take ${item.id}\` to act on it, or \`backlog drop ${item.id}\`.`);
				} catch {
					/* raced shutdown */
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

	// A delegated leg came back BLOCKED — surface it as a backlog candidate (deterministic, nudge-only,
	// never auto-writes). Reached on BOTH delivery paths: the sync delegate/council tool_result, and the
	// v1.5.0 background-default path where the report arrives as a follow-up user message (before_agent_start).
	const nudgeBlocked = (ctx: ExtensionContext, snippet: string): void => {
		try {
			const hint = `⚠️ a delegated leg reported ${snippet} — \`backlog add\` so the thread isn't lost`;
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme ? ctx.ui.theme.fg("accent", hint) : hint);
		} catch {
			/* cosmetic */
		}
	};

	// Inject the mind into every turn. before_agent_start re-fires after compaction, so this is also
	// how memory survives compaction: it re-injects from disk. Fail-open: a stalled read (slow disk,
	// lock contention) degrades to no injection rather than hanging the turn.
	pi.on("before_agent_start", async (event, ctx) => {
		// (rank 7) Deterministic, model-free capture nudge: if the user's message signals a durable
		// preference/instruction, surface a gentle hint on the status line (no LLM, no auto-write).
		// Supervisor-only: a worker has no memory tools to act on it, and its "prompt" is a task packet.
		if (nudgeEnabled && !isDelegatedLeg) {
			// A delegated leg that came back BLOCKED arrives HERE on the v1.5.0 async/background-default
			// path: pi-persona delivers the completion report as a fresh follow-up user message, so it
			// shows up as event.prompt (not a delegate tool_result). A blocked leg is deferred intent —
			// nudge a backlog capture so the thread isn't lost. This takes precedence over the capture cue.
			const blocked = detectBlockedLeg(event.prompt);
			if (blocked) {
				nudgeBlocked(ctx, blocked.snippet);
			} else {
				const cue = detectCaptureCue(event.prompt);
				if (cue) {
					try {
						ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme ? ctx.ui.theme.fg("accent", `💡 worth remembering? memory remember (${cue.kind})`) : `💡 worth remembering? (${cue.kind})`);
					} catch {
						/* cosmetic */
					}
				}
			}
		}
		let block = "";
		try {
			// A worker inherits the LEAN mind (north-star + identity only); the supervisor gets it all.
			block = await withDeadline(getMind(ctx).buildInjection({ lean: isDelegatedLeg }), INJECT_DEADLINE_MS, "");
		} catch {
			/* a mind failure must never break the supervisor's turn */
		}
		if (block) return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
		return;
	});

	// The SYNC delegation path: a `delegate`/`council` tool_result whose report carries a BLOCKED/UNKNOWN
	// marker (the async/background default lands in before_agent_start above). No result mutation — just a
	// status-line nudge — so it composes cleanly alongside pi-persona's own tool_result hook.
	const REPORT_TOOLS = new Set(["delegate", "council"]);
	pi.on("tool_result", (event, ctx) => {
		if (!nudgeEnabled || isDelegatedLeg) return undefined;
		if (!REPORT_TOOLS.has(event.toolName)) return undefined;
		const text = event.content.reduce((s, c) => (c.type === "text" ? s + c.text : s), "");
		const blocked = detectBlockedLeg(text);
		if (blocked) nudgeBlocked(ctx, blocked.snippet);
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		// A worker never arms/fires the supervisor's backlog wakes (nor shows a status line).
		if (isDelegatedLeg) return;
		await armWakes(ctx);
		await refreshStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		clearTimers();
		if (ownerPath) {
			try {
				if (readFileSync(ownerPath, "utf8") === ownerToken) unlinkSync(ownerPath);
			} catch {
				/* already released */
			}
			ownerPath = undefined;
		}
	});

	// Read-only human view of what is currently in the mind (and injected each turn).
	pi.registerCommand("mind", {
		description: "Show this persona's mind — objective, long-term memory, working context, and open backlog",
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
