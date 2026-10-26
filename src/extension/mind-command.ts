import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { inspectStoreFile, type StoreDiagnostic } from "../core/migrate.ts";
import type { Scope } from "../core/scope.ts";
import type { MindService } from "../core/service.ts";
import type { SessionMemory } from "../session-memory.ts";
import type { MemoryOptimizer } from "../core/optimize-service.ts";
import { formatOptimizeApplied, formatOptimizeFailure, formatOptimizeHistory, formatOptimizeInspection, formatOptimizePlan, formatOptimizeUndone } from "../tools/memory-optimize.ts";
import { isOptimizeTarget } from "../core/optimize.ts";
import { runMindActivity } from "./activity.ts";
import type { MindActivityRunner } from "./activity.ts";

export type MindOptimizeTarget = "project" | "project-long" | "persona" | "shared";

export type MindCommand =
	| { type: "snapshot" }
	| { type: "help" }
	| { type: "doctor" }
	| { type: "reset" }
	| { type: "migrate-persona" }
	| { type: "session" }
	| { type: "optimize-run"; target: Exclude<MindOptimizeTarget, "shared"> }
	| { type: "optimize-shared-refused" }
	| { type: "optimize-inspect"; target: MindOptimizeTarget }
	| { type: "optimize-show"; planId: string }
	| { type: "optimize-apply"; planId: string }
	| { type: "optimize-history"; target: MindOptimizeTarget }
	| { type: "optimize-undo"; receiptId: string; target: MindOptimizeTarget }
	| { type: "optimize-auto"; action: "status" | "on" | "off" }
	| { type: "invalid"; message: string };

const USAGE =
	"usage: /persona-mind [help|doctor|session|reset [workspace]|migrate-persona|optimize [project|project-long|persona]|optimize inspect [project|project-long|persona|shared]|optimize show <planId>|optimize apply <planId>|optimize history [target]|optimize undo <receiptId> [target]|optimize auto [status|on|off]]";

export interface MindCommandDeps {
	agentDir: string;
	resolveScope(ctx: ExtensionContext): Scope;
	rawPersona(ctx: ExtensionContext): string | null;
	getMind(ctx: ExtensionContext): MindService;
	getSessionMemory(): SessionMemory;
	getOptimizer(ctx: ExtensionContext): MemoryOptimizer;
	activity?(ctx: ExtensionContext): MindActivityRunner | undefined;
	autoOptimize?: { status(): string; setEnabled(enabled: boolean): void; startExplicit?(target: Exclude<MindOptimizeTarget, "shared">): boolean };
	isCurrent(ctx: ExtensionContext): boolean;
	ensureLegacyMigrated(ctx: ExtensionContext, includeAmbiguousPersonaAlias?: boolean, awaitCompletion?: boolean): Promise<void>;
	migrationStatus(): string;
	unavailableReason(ctx: ExtensionContext): string | undefined;
	surfaceWarning(ctx: ExtensionContext, message: string): void;
	pendingWarnings(): readonly string[];
	acknowledgeWarnings(ctx: ExtensionContext, warningCount: number): void;
	capturePolicy(): string;
	isDelegatedLeg: boolean;
	sessionActive(): boolean;
	afterWorkspaceReset(ctx: ExtensionContext): Promise<void>;
	appendResult(ctx: ExtensionContext, title: string, body: string): void;
}

export function registerMindCommands(pi: ExtensionAPI, deps: MindCommandDeps): void {
	const handler = async (args: string, ctx: ExtensionContext): Promise<void> => {
		const command = parseMindCommand(args);
		if (command.type !== "help") {
			const unavailable = deps.unavailableReason(ctx);
			if (unavailable) {
				ctx.ui.notify(unavailable, "warning");
				return;
			}
		}
		if (command.type === "invalid") {
			ctx.ui.notify(command.message, "warning");
			return;
		}
		if (command.type === "help") {
			const body = [
				"/persona-mind — persona memory and active-session notes",
				"/persona-mind doctor — inspect store health and migration warnings",
				"/persona-mind session — list notes on this active session branch",
				"/persona-mind reset [workspace] — clear this project's short-term memory and backlog",
				"/persona-mind migrate-persona — explicitly import an ambiguous historical persona alias",
				"/persona-mind optimize [project|project-long|persona] — request one bounded visible Persona-hosted LLM review; project is expiring working memory, project-long is durable repository knowledge",
				"/persona-mind optimize inspect [project|project-long|persona|shared] — read-only inspection; shared changes require a manually reviewed workflow.",
				"/persona-mind optimize show <planId> — inspect exact staged text; /persona-mind optimize apply <planId> commits that plan only",
				"/persona-mind optimize history [target] — inspect bounded durable before/after receipts; /persona-mind optimize undo <receiptId> [target] restores unchanged affected facts (target defaults to project)",
				"/persona-mind optimize auto [status|on|off] — inspect or switch automatic review for this session; off cancels pending work",
				"/mind is an alias. Explicit review bypasses automatic gates but not worker/busy/owner safeguards; it reports bounded coverage and applies only validated CAS plans. Automatic review remains idle-gated.",
			].join("\n");
			publish(ctx, deps, "pi-persona-mind help", body, "Command reference is in the expandable card.");
			return;
		}
		if (command.type === "optimize-shared-refused") {
			ctx.ui.notify("Shared memory is excluded from LLM optimization. Use `/mind optimize inspect shared` and a manually reviewed workflow.", "warning");
			return;
		}
		if (command.type === "optimize-run") {
			if (deps.isDelegatedLeg || !deps.autoOptimize?.startExplicit) {
				ctx.ui.notify("Visible Persona-hosted memory review is unavailable in this session.", "warning");
				return;
			}
			if (!captureSessionOwner(deps, ctx)()) {
				ctx.ui.notify("Memory session owner changed; optimization was not started.", "warning");
				return;
			}
			if (!deps.autoOptimize.startExplicit(command.target)) ctx.ui.notify("Mind is busy, already has a review worker active, or its memory owner is unavailable; no review was accepted.", "warning");
			else ctx.ui.notify(`Mind ${command.target} review requested; bounded inspection and worker admission are preparing in the background.`, "info");
			return;
		}
		if (command.type === "optimize-auto") {
			if (!captureSessionOwner(deps, ctx)()) {
				ctx.ui.notify("Memory session owner changed; automatic optimization was not changed.", "warning");
				return;
			}
			if (deps.isDelegatedLeg || !deps.autoOptimize) {
				ctx.ui.notify("Automatic memory optimization is unavailable in this session.", "warning");
				return;
			}
			if (command.action !== "status") deps.autoOptimize.setEnabled(command.action === "on");
			publish(ctx, deps, "Automatic memory optimization", deps.autoOptimize.status(), "Automatic memory optimization status is in the expandable card.");
			return;
		}
		if (command.type === "migrate-persona") {
			const ownerCurrent = captureSessionOwner(deps, ctx);
			const scopeAtStart = deps.resolveScope(ctx);
			if (!ownerCurrent()) return;
			const rawPersona = deps.rawPersona(ctx);
			await deps.ensureLegacyMigrated(ctx, true, true);
			if (!ownerCurrent() || !sameScope(scopeAtStart, deps.resolveScope(ctx))) return;
			deps.surfaceWarning(ctx, rawPersona === null
				? "AMBIGUOUS persona migration requested, but no active persona is selected; only project aliases were reconciled."
				: `AMBIGUOUS persona migration imported the historical alias for '${rawPersona}'. Review the result; source files were left untouched.`);
			return;
		}

		if (command.type === "optimize-history" || command.type === "optimize-undo") {
			const active = captureOptimizer(deps, ctx);
			if (!active || !optimizerIsCurrent(deps, ctx, active.optimizer, active.ownerCurrent)) {
				ctx.ui.notify("Memory owner changed; optimization history is unavailable in the active scope.", "warning");
				return;
			}
			const formatted = command.type === "optimize-history"
				? await runMindActivity(deps.activity?.(ctx), "inspect", command.target, async () => {
					const result = await active.optimizer.history(command.target);
					return result.ok ? formatOptimizeHistory(result) : formatOptimizeFailure(result);
				}, (result) => result.details.ok === true)
				: await runMindActivity(deps.activity?.(ctx), "apply", command.target, async () => {
					const result = await active.optimizer.undo(command.receiptId, command.target);
					return result.ok ? formatOptimizeUndone(result) : formatOptimizeFailure(result);
				}, (result) => result.details.ok === true);
			if (!optimizerIsCurrent(deps, ctx, active.optimizer, active.ownerCurrent)) {
				ctx.ui.notify(command.type === "optimize-undo" ? "Memory owner changed while undo was running. Inspect the target memory before retrying; undo may already have completed." : "Memory owner changed while history was read; no stale result was displayed.", "warning");
				return;
			}
			publish(ctx, deps, command.type === "optimize-history" ? "Memory optimization history" : "Memory consolidation undo", formatted.content[0]?.text ?? "No result.");
			return;
		}
		if (command.type === "optimize-apply") {
			const active = captureOptimizer(deps, ctx);
			if (!active || !optimizerIsCurrent(deps, ctx, active.optimizer, active.ownerCurrent)) {
				ctx.ui.notify("Memory owner changed; this staged plan is no longer available in the active scope.", "warning");
				return;
			}
			const plan = active.optimizer.getPlan(command.planId);
			const result = plan.ok
				? await runMindActivity(deps.activity?.(ctx), "apply", plan.target, () => active.optimizer.apply(command.planId), (outcome) => outcome.ok)
				: await active.optimizer.apply(command.planId);
			if (!optimizerIsCurrent(deps, ctx, active.optimizer, active.ownerCurrent)) {
				ctx.ui.notify("The memory owner changed while apply was running. Inspect the target memory before retrying; the staged apply may already have completed.", "warning");
				return;
			}
			const formatted = result.ok ? formatOptimizeApplied(result) : formatOptimizeFailure(result);
			publish(ctx, deps, "Memory optimization result", formatted.content[0]?.text ?? "No result.", "Memory optimization result is in the expandable card.");
			return;
		}
		if (command.type === "optimize-show") {
			const active = captureOptimizer(deps, ctx);
			if (!active || !optimizerIsCurrent(deps, ctx, active.optimizer, active.ownerCurrent)) {
				ctx.ui.notify("Memory owner changed; this staged plan is unavailable in the active scope.", "warning");
				return;
			}
			const result = active.optimizer.getPlan(command.planId);
			const formatted = result.ok ? formatOptimizePlan(result) : formatOptimizeFailure(result);
			publish(ctx, deps, "Staged memory optimization plan", formatted.content[0]?.text ?? "No result.", "Staged memory plan is in the expandable card.");
			return;
		}
		if (command.type === "optimize-inspect") {
			await deps.ensureLegacyMigrated(ctx);
			const active = captureOptimizer(deps, ctx);
			if (!active || !optimizerIsCurrent(deps, ctx, active.optimizer, active.ownerCurrent)) {
				ctx.ui.notify("Memory owner changed before inspection; no result was displayed.", "warning");
				return;
			}
			const result = await runMindActivity(deps.activity?.(ctx), "inspect", command.target, () => active.optimizer.inspect(command.target), (outcome) => outcome.ok);
			if (!optimizerIsCurrent(deps, ctx, active.optimizer, active.ownerCurrent)) {
				ctx.ui.notify("Memory scope changed while inspection was running; no stale result was displayed.", "warning");
				return;
			}
			const formatted = result.ok ? formatOptimizeInspection(result) : formatOptimizeFailure(result);
			publish(ctx, deps, `Memory optimization · ${command.target}`, formatted.content[0]?.text ?? "No result.", `Memory inspection for ${command.target} is in the expandable card.`);
			return;
		}

		const ownerCurrent = captureSessionOwner(deps, ctx);
		const scopeAtStart = deps.resolveScope(ctx);
		if (!ownerCurrent()) return;
		if (command.type === "doctor") await deps.ensureLegacyMigrated(ctx);
		else await deps.ensureLegacyMigrated(ctx);
		if (!ownerCurrent() || !sameScope(scopeAtStart, deps.resolveScope(ctx))) return;
		const scope = scopeAtStart;
		if (command.type === "doctor") {
			const diagnostics: Array<[string, StoreDiagnostic]> = await Promise.all([
				inspectStoreFile(scope.paths.ltm, "ltm").then((d): [string, StoreDiagnostic] => ["long-term", d]),
				inspectStoreFile(scope.paths.shared, "ltm").then((d): [string, StoreDiagnostic] => ["shared", d]),
				inspectStoreFile(scope.paths.projectLtm, "ltm").then((d): [string, StoreDiagnostic] => ["project durable", d]),
				inspectStoreFile(scope.paths.stm, "stm").then((d): [string, StoreDiagnostic] => ["short-term", d]),
				inspectStoreFile(scope.paths.backlog, "backlog").then((d): [string, StoreDiagnostic] => ["backlog", d]),
			]);
			if (!ownerCurrent() || !sameScope(scope, deps.resolveScope(ctx))) return;
			const pathLine = ([label, diagnostic]: [string, StoreDiagnostic]): string => {
				const suffix = diagnostic.status === "missing" ? "not created" : diagnostic.status === "ok" ? `ok (${diagnostic.validEntries} entries)` : `${diagnostic.status} (${diagnostic.message ?? `${diagnostic.invalidEntries} invalid entries`})`;
				return `${label}: ${diagnostic.path} (${suffix})`;
			};
			const diagnosticWarnings = diagnostics.filter(([, diagnostic]) => diagnostic.status !== "missing" && diagnostic.status !== "ok").map(([label, diagnostic]) => `${label}: ${diagnostic.status} — ${diagnostic.message ?? "invalid store"}`);
			const allWarnings = [...deps.pendingWarnings(), ...diagnosticWarnings];
			const lines = [
				"pi-persona-mind doctor",
				`persona: ${scope.persona}`,
				`cwd: ${ctx.cwd}`,
				`project root: ${scope.projectRoot}${scope.homeWorkspace ? " (home — STM/backlog not injected, wakes off)" : ""}`,
				`project slug: ${scope.slug}`,
				`capture: ${deps.capturePolicy()} (PI_PERSONA_MIND_CAPTURE)`,
				`automatic optimization: ${deps.autoOptimize?.status() ?? "unavailable in this session"}`,
				`migration: ${deps.migrationStatus()}`,
				...diagnostics.map(pathLine),
				`legacy root: ${join(deps.agentDir, "pi-persona-mind")} (${existsSync(join(deps.agentDir, "pi-persona-mind")) ? "detected; imported non-destructively" : "absent"})`,
				`warnings: ${allWarnings.length === 0 ? "none" : allWarnings.join(" | ")}`,
			];
			deps.acknowledgeWarnings(ctx, allWarnings.length);
			publish(ctx, deps, "Memory doctor", lines.join("\n"), allWarnings.length === 0 ? "Memory doctor: healthy; see the expandable card." : `Memory doctor found ${allWarnings.length} warning(s); see the expandable card.`, allWarnings.length === 0 ? "info" : "warning");
			return;
		}
		if (command.type === "reset") {
			if (deps.isDelegatedLeg) {
				ctx.ui.notify("a delegated worker cannot reset the supervisor's workspace mind", "warning");
				return;
			}
			const mind = deps.getMind(ctx);
			const result = await mind.resetWorkspace();
			if (!ownerCurrent() || !sameScope(scope, deps.resolveScope(ctx))) return;
			if (!result.ok) {
				ctx.ui.notify(`mind reset failed: ${result.reason}`, "error");
				return;
			}
			if (deps.sessionActive()) {
				await deps.afterWorkspaceReset(ctx);
				if (!ownerCurrent() || !sameScope(scope, deps.resolveScope(ctx))) return;
			}
			const receipt = `Cleared this workspace (${scope.projectRoot}): ${result.stmRemoved} short-term · ${result.backlogRemoved} backlog. Long-term identity (${result.ltmKept}) left intact.`;
			publish(ctx, deps, "Workspace memory reset", receipt, receipt);
			return;
		}
		if (command.type === "session") {
			const result = deps.getSessionMemory().snapshot(ctx);
			if (!result.ok) {
				ctx.ui.notify(`Session notes unavailable: ${result.reason ?? "active session owner is missing"}`, "warning");
				return;
			}
			const rows = result.notes.slice(-20).reverse().map((note) => `- [${note.id}] (${note.kind}) ${note.text.replace(/\s+/g, " ").slice(0, 160)}${note.text.length > 160 ? "…" : ""}`);
			const omitted = result.notes.length > rows.length ? `\n… ${result.notes.length - rows.length} older note(s) omitted; use memory read with an id for full text.` : "";
			const body = `Active-session notes (${result.notes.length}, storage: ${result.storage})${rows.length ? `\n${rows.join("\n")}` : "\n(none)"}${omitted}`;
			publish(ctx, deps, "Active-session notes", body, `Active-session notes: ${result.notes.length}; details are in the expandable card.`);
			return;
		}
		const mind = deps.getMind(ctx);
		const [summary, block] = await Promise.all([mind.summary(), mind.buildInjection()]);
		if (!ownerCurrent() || !sameScope(scope, deps.resolveScope(ctx))) return;
		const counts = `${summary.ltm} persona/shared · ${summary.projectLtm} project durable · ${summary.stm} working · ${summary.backlogOpen} open backlog`;
		const header = `pi-persona-mind (${scope.persona}) — ${counts}`;
		publish(ctx, deps, "Persona mind snapshot", block ? `${header}\n\n${block}` : `${header}\n\n(empty)`, counts);
	};
	const description = "Persona memory, active-session notes, diagnostics, and reviewed optimization";
	pi.registerCommand("persona-mind", { description, handler });
	pi.registerCommand("mind", { description: `${description} (alias)`, handler });
}

function publish(ctx: ExtensionContext, deps: MindCommandDeps, title: string, body: string, notice = `${title} is in the expandable card.`, level: "info" | "warning" = "info"): void {
	try {
		deps.appendResult(ctx, title, body);
		ctx.ui.notify(notice, level);
	} catch {
		ctx.ui.notify(`${title}: ${body.split("\n", 1)[0]?.slice(0, 180) ?? "result unavailable"}`, "warning");
	}
}

function captureOptimizer(deps: MindCommandDeps, ctx: ExtensionContext): { optimizer: MemoryOptimizer; ownerCurrent: () => boolean } | undefined {
	try {
		if (!deps.isCurrent(ctx)) return undefined;
		const ownerCurrent = deps.getSessionMemory().captureOwner(ctx);
		if (!ownerCurrent()) return undefined;
		return { optimizer: deps.getOptimizer(ctx), ownerCurrent };
	} catch { return undefined; }
}

function optimizerIsCurrent(deps: MindCommandDeps, ctx: ExtensionContext, captured: MemoryOptimizer, ownerCurrent: () => boolean): boolean {
	try { return ownerCurrent() && deps.isCurrent(ctx) && deps.getOptimizer(ctx) === captured; }
	catch { return false; }
}

function captureSessionOwner(deps: MindCommandDeps, ctx: ExtensionContext): () => boolean {
	try {
		const ownerCurrent = deps.getSessionMemory().captureOwner(ctx);
		return () => { try { return ownerCurrent() && deps.isCurrent(ctx); } catch { return false; } };
	} catch { return () => false; }
}

function sameScope(left: Scope, right: Scope): boolean {
	return left.persona === right.persona && left.projectRoot === right.projectRoot && left.slug === right.slug &&
		left.paths.ltm === right.paths.ltm && left.paths.shared === right.paths.shared && left.paths.projectLtm === right.paths.projectLtm && left.paths.stm === right.paths.stm && left.paths.backlog === right.paths.backlog;
}

/** Parse the shared /persona-mind and /mind command grammar without performing any action. */
export function parseMindCommand(args: string): MindCommand {
	if (typeof args !== "string") return { type: "invalid", message: USAGE };
	const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { type: "snapshot" };
	if (parts.length === 1 && parts[0] === "help") return { type: "help" };
	if (parts.length === 1 && parts[0] === "doctor") return { type: "doctor" };
	if (parts.length === 1 && parts[0] === "session") return { type: "session" };
	if (parts.length === 1 && parts[0] === "reset") return { type: "reset" };
	if (parts.length === 2 && parts[0] === "reset" && parts[1] === "workspace") return { type: "reset" };
	if (parts[0] === "reset") return { type: "invalid", message: "reset only clears THIS PROJECT's short-term memory and backlog. Long-term persona identity is not workspace-scoped — forget individual facts with `memory forget <id>`." };
	if (parts.length === 1 && parts[0] === "migrate-persona") return { type: "migrate-persona" };
	if (parts[0] === "optimize") {
		if (parts[1] === "history" && (parts.length === 2 || parts.length === 3 && isOptimizeTarget(parts[2]))) return { type: "optimize-history", target: parts[2] as MindOptimizeTarget ?? "project" };
		if (parts[1] === "undo" && (parts.length === 3 || parts.length === 4 && isOptimizeTarget(parts[3])) && isPlanId(args.trim().split(/\s+/)[2])) return { type: "optimize-undo", receiptId: args.trim().split(/\s+/)[2]!, target: parts[3] as MindOptimizeTarget ?? "project" };
		if (parts[1] === "auto") {
			if (parts.length === 2) return { type: "optimize-auto", action: "status" };
			if (parts.length === 3 && (parts[2] === "status" || parts[2] === "on" || parts[2] === "off")) return { type: "optimize-auto", action: parts[2] };
			return { type: "invalid", message: USAGE };
		}
		if (parts[1] === "inspect" && parts.length === 2) return { type: "optimize-inspect", target: "project" };
		if (parts[1] === "inspect" && parts.length === 3 && isOptimizeTarget(parts[2])) return { type: "optimize-inspect", target: parts[2] };
		if (parts.length === 1) return { type: "optimize-run", target: "project" };
		if (parts.length === 2 && parts[1] === "shared") return { type: "optimize-shared-refused" };
		if (parts.length === 2 && (parts[1] === "project" || parts[1] === "project-long" || parts[1] === "persona")) {
			return { type: "optimize-run", target: parts[1] };
		}
		if (parts.length === 3 && (parts[1] === "show" || parts[1] === "apply") && isPlanId(args.trim().split(/\s+/)[2])) {
			const planId = args.trim().split(/\s+/)[2]!;
			return parts[1] === "show" ? { type: "optimize-show", planId } : { type: "optimize-apply", planId };
		}
	}
	return { type: "invalid", message: USAGE };
}

function isPlanId(value: string | undefined): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}
