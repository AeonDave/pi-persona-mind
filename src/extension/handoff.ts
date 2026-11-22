import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Scope } from "../core/scope.ts";
import type { HandoffInput } from "../core/handoff.ts";
import { HandoffStore, type HandoffResult } from "../core/handoff-store.ts";

/** Captures provenance; the supplied owner guard invalidates navigation, but allows ordinary appends. */
export async function runHandoff(ctx: ExtensionContext, scope: Scope, ownerCurrent: () => boolean, input: HandoffInput): Promise<HandoffResult> {
	try {
		const manager = ctx.sessionManager;
		const branchId = manager.getLeafId();
		const sessionId = manager.getSessionId();
		const isCurrent = () => { try { return ownerCurrent() && ctx.sessionManager === manager && manager.getSessionId() === sessionId; } catch { return false; } };
		if (!isCurrent()) return { ok: false, reason: "handoff session owner unavailable" };
		const result = await new HandoffStore(scope).execute({ persona: scope.persona, projectRoot: scope.projectRoot, sessionId, branchId, cwd: ctx.cwd, isCurrent }, input);
		if (!isCurrent()) {
			if (!result.ok) return result;
			return { ok: false, reason: result.operation === "read" || result.operation === "list"
				? "handoff owner changed; historical snapshot withheld"
				: `handoff ${result.operation} committed in the original scope before the owner changed; inspect it before retrying` };
		}
		return result;
	} catch { return { ok: false, reason: "handoff session owner unavailable" }; }
}
