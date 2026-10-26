/** Pi lifecycle adapter. The scheduler never wakes the supervisor or owns its conversation. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MindService } from "../core/service.ts";
import type { Scope } from "../core/scope.ts";
import type { AutoOptimizeTarget } from "../core/auto-optimize.ts";
import { AUTO_ATTEMPT_ENTRY, AutoOptimizeScheduler, type AutoAttempt } from "./auto-optimize.ts";
import { launchMindWorker } from "./mind-worker.ts";
import { MIND_RESULT_ENTRY_TYPE } from "../ui/mind-result-card.ts";

interface Dependencies {
	isDelegatedLeg: boolean;
	available(ctx: ExtensionContext): boolean;
	captureOwner(ctx: ExtensionContext): () => boolean;
	scope(ctx: ExtensionContext): Scope;
	persona(ctx: ExtensionContext): string | null;
	mind(ctx: ExtensionContext): MindService;
}

/** Maps successful memory writes to their owned optimizer tier; shared LTM is never automatic. */
export function autoOptimizeTarget(input: unknown): AutoOptimizeTarget | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const value = input as Record<string, unknown>;
	const scope = value.scope;
	if (scope !== undefined && scope !== "project" && scope !== "persona" && scope !== "shared") return undefined;
	if (value.action === "remember") {
		if (value.term === "short") return scope === undefined || scope === "project" ? "project" : undefined;
		if (value.term !== "long" || scope === "shared") return undefined;
		return scope === "project" ? "project-long" : "persona";
	}
	if (value.action === "promote") {
		if (scope === "shared") return undefined;
		return scope === "persona" ? "persona" : "project-long";
	}
	return undefined;
}

export interface AutoOptimizeSession {
	activate(ctx: ExtensionContext, resetPreference?: boolean): void;
	revoke(): void;
	memoryAdded(ctx: ExtensionContext, target: AutoOptimizeTarget): void;
	status(): string;
	setEnabled(enabled: boolean): void;
	targets(): readonly AutoOptimizeTarget[];
	startExplicit(target?: AutoOptimizeTarget): boolean;
}

export function installAutoOptimize(pi: ExtensionAPI, deps: Dependencies): AutoOptimizeSession {
	const scheduler = new AutoOptimizeScheduler();
	let boundKey: string | undefined;
	let boundContext: ExtensionContext | undefined;
	const tokenEvents = new Set<string>();
	const safeAvailable = (ctx: ExtensionContext): boolean => {
		try { return !deps.isDelegatedLeg && ctx.hasUI && ctx.mode !== "print" && deps.available(ctx); }
		catch { return false; }
	};
	const revoke = (): void => { boundKey = undefined; boundContext = undefined; tokenEvents.clear(); scheduler.stop(); };
	const activate = (ctx: ExtensionContext, resetPreference = false): void => {
		if (!safeAvailable(ctx)) { revoke(); return; }
		const scope = deps.scope(ctx);
		// Automatic project maintenance never creates home-directory stores.
		const key = JSON.stringify([ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile(), scope.persona, scope.paths]);
		if (!resetPreference && boundKey === key && boundContext?.sessionManager === ctx.sessionManager) return;
		boundKey = key; boundContext = ctx; tokenEvents.clear();
		const captured = deps.captureOwner(ctx);
		const current = () => boundKey === key && boundContext?.sessionManager === ctx.sessionManager && safeAvailable(ctx) && captured();
		const attempts: AutoAttempt[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== AUTO_ATTEMPT_ENTRY || !entry.data || typeof entry.data !== "object") continue;
			const data = entry.data as Record<string, unknown>;
			if (data.version === 1 && data.owner === key && typeof data.digest === "string" && /^[a-f0-9]{64}$/.test(data.digest) && typeof data.at === "number" && Number.isFinite(data.at) && data.at >= 0 && data.at <= Date.now() && (data.state === "started" || data.state === "settled")) {
				const target = data.target === "project" || data.target === "project-long" || data.target === "persona" ? data.target : undefined;
				attempts.push({ digest: data.digest, at: data.at, state: data.state, ...(target ? { target } : {}) });
				if (attempts.length > 64) attempts.shift();
			}
		}
		const owner = {
			key, persona: scope.persona, current,
			allowedTargets: scope.homeWorkspace ? ["persona"] as const : ["project", "project-long", "persona"] as const,
			idle: () => ctx.isIdle() && !ctx.hasPendingMessages(),
			optimizer: () => deps.mind(ctx).createOptimizer(),
			launch: (task: string) => launchMindWorker(pi, ctx.sessionManager.getSessionId(), deps.persona(ctx), task),
			recordAttempt: (attempt: AutoAttempt) => { if (!current()) throw new Error("automatic memory owner changed"); pi.appendEntry(AUTO_ATTEMPT_ENTRY, { version: 1, owner: key, ...attempt }); },
			report: (title: string, body: string) => {
				if (!current()) throw new Error("automatic memory owner changed");
				pi.appendEntry(MIND_RESULT_ENTRY_TYPE, { title, content: body });
				if (title !== "Mind automatic proposal") ctx.ui.notify(`Mind · ${body.split("\n", 1)[0]!.slice(0, 160)}`, "info");
			}, attempts,
		};
		if (resetPreference) scheduler.activate(owner, process.env.PI_PERSONA_MIND_OPTIMIZE !== "off");
		else scheduler.activate(owner);
	};
	const memoryAdded = (ctx: ExtensionContext, target: AutoOptimizeTarget): void => {
		if (!safeAvailable(ctx)) return;
		activate(ctx);
		if ((target === "persona") || !deps.scope(ctx).homeWorkspace) scheduler.memoryAdded(target);
	};
	pi.on("input", () => { scheduler.interrupt(); });
	pi.on("agent_start", () => { scheduler.interrupt(); });
	pi.on("model_select", () => { scheduler.interrupt(); });
	pi.on("ui_prompt_start", () => { scheduler.interrupt(); });
	pi.on("turn_end", (event, ctx) => {
		if (!safeAvailable(ctx) || event.message.role !== "assistant" || tokenEvents.has(event.messageEntryId)) return;
		activate(ctx);
		tokenEvents.add(event.messageEntryId);
		while (tokenEvents.size > 256) tokenEvents.delete(tokenEvents.values().next().value!);
		const usage = event.message.usage;
		scheduler.tokensUsed(Math.max(0, usage.input));
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "memory" || event.isError || !event.details || typeof event.details !== "object" || (event.details as { ok?: unknown }).ok !== true) return;
		const target = autoOptimizeTarget(event.input);
		if (target) memoryAdded(ctx, target);
	});
	pi.on("agent_settled", (event, ctx) => { if (!event.aborted && safeAvailable(ctx)) { activate(ctx); scheduler.settled(); } });
	pi.on("session_shutdown", async () => { revoke(); await scheduler.join(); });
	return { activate, revoke, memoryAdded,
		status: () => boundContext ? scheduler.status() : "inactive · automatic work requires an interactive Persona session",
		setEnabled: (enabled) => scheduler.setEnabled(enabled),
		targets: () => scheduler.targets(),
		startExplicit: (target) => scheduler.startExplicit(target),
	};
}
