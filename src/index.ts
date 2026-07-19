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
import { EMPTY_MIND_MARKER } from "./core/inject.ts";
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

export function ownerIsStale(path: string, token: string): boolean {
	try {
		const content = readFileSync(path, "utf8");
		if (content === token) return false; // ours
		const colon = content.indexOf(":");
		const host = colon < 0 ? "" : content.slice(0, colon);
		const pid = colon < 0 ? NaN : Number.parseInt(content.slice(colon + 1), 10);
		if (host === hostname() && Number.isInteger(pid) && pid > 0) {
			// A LOCAL owner: stale iff its process is gone. Never time-steal a LIVE local owner — that is
			// the >120s double-fire (a second session opened later in the same project would steal the
			// still-alive owner's lock and both would then fire the same backlog wakes).
			return !isAlive(pid);
		}
		// Foreign host / unparseable token (network FS, legacy): fall back to the mtime rule.
		return Date.now() - statSync(path).mtimeMs > OWNER_STALE_MS;
	} catch (err) {
		// Vanished ⇒ claimable; a transient read error (AV lock, EPERM) must NOT steal a live owner.
		return (err as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/** Non-blocking claim of the per-project wake-firer lock. Only the owner arms/fires wakes. */
function claimWakeOwner(path: string, token: string): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx");
			writeSync(fd, token);
			closeSync(fd);
			// Confirm our token actually stuck: a racing stealer's unlink+recreate could have replaced
			// it between our create and now. If the lock isn't ours, we do NOT own the wakes — retry.
			try {
				if (readFileSync(path, "utf8") === token) return true;
			} catch {
				/* vanished — retry */
			}
			continue;
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

	// A DELEGATED worker leg? pi-persona (≥ 1.5.2) marks its sub-agent sessions with a DEDICATED marker,
	// PI_PERSONA_LEG=1 — the in-process fork-bomb guard sets it transiently around session creation, and
	// the child engine puts it in the spawn env (a child process also carries PI_PERSONA_CHILD=1). We key
	// on those, NOT on PI_PERSONA_DISABLE: that flag is ALSO pi-persona's user-facing kill switch, so a
	// user who disables pi-persona interactively is a supervisor running the mind standalone — not a leg,
	// and it must keep its memory tools. Sampled HERE at factory time (the in-process marker is popped
	// before the turn runs). A worker is not the persona: it inherits only the lean mind (north-star +
	// identity — see buildInjection) and must NOT manage the supervisor's memory or fire its wakes. Absent
	// the markers (the normal supervisor, or a user kill switch), everything runs full — behavior unchanged.
	const isDelegatedLeg = process.env.PI_PERSONA_LEG === "1" || process.env.PI_PERSONA_CHILD === "1";

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
				// Re-check state at fire time: nothing cancels this timer when the item is done/dropped,
				// so reload and only nag if the item is still unfinished — never act on dead intent.
				void (async () => {
					try {
						const live = (await mind.backlogList({ all: true })).find((e) => e.id === item.id);
						if (!live || (live.state !== "open" && live.state !== "taken")) return;
						pi.sendUserMessage(`[pi-persona-mind] backlog due — ${live.text} (id ${live.id}). Use \`backlog take ${live.id}\` to act on it, or \`backlog drop ${live.id}\`.`);
					} catch {
						/* raced shutdown / read error */
					}
				})();
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

	// Cue snippets already surfaced as a PROMPT hint this session: a strong persist-intent cue is
	// hinted at most once, so it stays a one-time gentle nudge rather than a per-turn nag.
	const cueHinted = new Set<string>();
	// The empty-mind discoverability line is an ANNOUNCEMENT — shown once per session, not a banner that
	// persists every turn while the mind stays empty (that would be the nag we avoid).
	let emptyAnnounced = false;

	// Inject the mind into every turn. before_agent_start re-fires after compaction, so this is also
	// how memory survives compaction: it re-injects from disk. Fail-open: a stalled read (slow disk,
	// lock contention) degrades to no injection rather than hanging the turn.
	pi.on("before_agent_start", async (event, ctx) => {
		// Deterministic, model-free capture nudge: if the user's message signals a durable
		// preference/instruction, surface a gentle hint (no LLM, no auto-write, never obligatory).
		// Supervisor-only: a worker has no memory tools to act on it, and its "prompt" is a task packet.
		let cueHint = "";
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
					// A STRONG, explicit persist-intent cue ("from now on", "remember that") ALSO gets a soft
					// one-line hint in the PROMPT — the model can't read the status line — once per snippet,
					// worded as optional. A casual "always"/"I prefer" stays status-only, so this never nags.
					if (cue.strong && !cueHinted.has(cue.snippet)) {
						cueHinted.add(cue.snippet);
						cueHint = `⟢ pi-persona-mind — that reads like a durable ${cue.kind} ("${cue.snippet}"). If it should outlive this session, \`memory remember\` (term=long) — optional, your call.`;
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
		// The empty-mind hint announces the faculty ONCE per session, then goes quiet even if the mind
		// stays empty — a state indicator, not a per-turn nag. (Real memory content never carries the
		// marker, so this only ever suppresses the announcement itself.)
		if (block.includes(EMPTY_MIND_MARKER)) {
			if (emptyAnnounced) block = "";
			else emptyAnnounced = true;
		}
		const injected = [block, cueHint].filter(Boolean).join("\n\n");
		if (injected) return { systemPrompt: `${event.systemPrompt}\n\n${injected}` };
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
