import { randomUUID } from "node:crypto";

export const MIND_ACTIVITY_EVENT = "pi-persona:activity:v1";

export type MindActivityPhase = "inspect" | "stage" | "apply";
export type MindActivityState = "running" | "staged" | "done" | "failed";
export type MindActivityTarget = "project" | "project-long" | "persona" | "shared";

export interface MindActivityEvent {
	version: 1;
	producerId: "pi-persona-mind";
	activityId: string;
	sessionId: string;
	phase: MindActivityPhase;
	state: MindActivityState;
	target: MindActivityTarget;
}

export interface MindActivityRunner {
	run<T>(phase: MindActivityPhase, target: MindActivityTarget, work: () => T | Promise<T>, isSuccess?: (result: T) => boolean): Promise<T>;
}

export interface MindActivityOptions {
	sessionId: string;
	enabled(): boolean;
	isCurrent(): boolean;
	emit(channel: string, payload: MindActivityEvent): void;
}

/**
 * Adapts a real local optimize operation to Persona's public activity protocol. The event deliberately
 * carries no memory contents, model/provider, token counts, file paths, or completion claims beyond
 * the operation's own explicit result.
 */
export function createMindActivityRunner(options: MindActivityOptions): MindActivityRunner {
	function publish(event: MindActivityEvent): void {
		try {
			if (!options.sessionId.trim() || !options.enabled() || !options.isCurrent()) return;
			options.emit(MIND_ACTIVITY_EVENT, event);
		} catch {
			// Activity is a best-effort UI projection. A companion listener cannot alter a memory operation.
		}
	}
	return {
		async run<T>(phase: MindActivityPhase, target: MindActivityTarget, work: () => T | Promise<T>, isSuccess?: (result: T) => boolean): Promise<T> {
			const base = { version: 1 as const, producerId: "pi-persona-mind" as const, activityId: randomUUID(), sessionId: options.sessionId, phase, target };
			publish({ ...base, state: "running" });
			try {
				const result = await work();
				let succeeded = false;
				try { succeeded = (isSuccess ?? defaultSuccess)(result); } catch { /* malformed caller predicate is failure-shaped */ }
				const state: MindActivityState = !succeeded ? "failed" : phase === "stage" ? "staged" : "done";
				publish({ ...base, state });
				return result;
			} catch (error) {
				publish({ ...base, state: "failed" });
				throw error;
			}
		},
	};
}

/** Run normally when no compatible Persona activity runner is available. Entry access is gated elsewhere. */
export function runMindActivity<T>(
	runner: MindActivityRunner | undefined,
	phase: MindActivityPhase,
	target: MindActivityTarget,
	work: () => T | Promise<T>,
	isSuccess?: (result: T) => boolean,
): Promise<T> {
	if (runner) return runner.run(phase, target, work, isSuccess);
	try { return Promise.resolve(work()); }
	catch (error) { return Promise.reject(error); }
}

function defaultSuccess<T>(value: T): boolean {
	const result: unknown = value;
	return !result || typeof result !== "object" || !("ok" in result) || result.ok === true;
}
