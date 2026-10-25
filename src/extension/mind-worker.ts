/** Closed local bridge: Persona owns the real tracked worker and its model/permissions. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type MindWorkerResult = {
	status: "done"; ok: true; output: string; error?: string; resultRef?: string; model?: string; thinking?: string;
} | {
	status: "failed" | "stopped"; ok: false; output: string; error?: string; resultRef?: string; model?: string; thinking?: string;
};
export type MindWorkerAdmission = { ok: false; reason: string } | {
	ok: true; runId: string; model: string; thinking: string;
	completion: Promise<MindWorkerResult>; cancel(): void;
};

export function launchMindWorker(pi: Pick<ExtensionAPI, "events">, sessionId: string, persona: string | null, task: string): MindWorkerAdmission {
	const replies: unknown[] = [];
	let accepting = true;
	let failed = false;
	try { pi.events.emit("pi-persona:mind-worker:v1", { version: 1, sessionId, persona, task, respond: (value: unknown) => { if (accepting) replies.push(value); else cancelReply(value); } }); }
	catch { failed = true; }
	finally { accepting = false; }
	const reply = replies[0] as Partial<Extract<MindWorkerAdmission, { ok: true }>> | undefined;
	if (!failed && replies.length === 1 && reply?.ok === true && typeof reply.runId === "string" && typeof reply.model === "string" && typeof reply.thinking === "string" && typeof reply.cancel === "function" && reply.completion instanceof Promise) return reply as Extract<MindWorkerAdmission, { ok: true }>;
	// Ambiguous admission cannot leave an unowned worker running.
	for (const value of replies) cancelReply(value);
	if (failed) return { ok: false, reason: "Persona worker admission failed" };
	const refusal = replies[0] as { reason?: unknown } | undefined;
	return { ok: false, reason: typeof refusal?.reason === "string" ? refusal.reason : "Compatible Persona worker service unavailable" };
}

function cancelReply(value: unknown): void {
	try { const item = value as { cancel?: unknown }; if (typeof item?.cancel === "function") item.cancel(); } catch { /* bounded cleanup */ }
}
