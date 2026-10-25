/** Mind's own session preferences. Active persona ownership never comes from this file. */
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { captureMode } from "./capture.ts";

export interface MindSettings { mindCapture: "auto" | "prompt" | "off"; mindNudge: boolean }
const snapshots = new Map<string, MindSettings>();
const MAX_SETTINGS_BYTES = 1024 * 1024;

function savedPreferences(path: string): Partial<MindSettings> {
	let fd: number | undefined;
	try {
		const listed = statSync(path);
		if (!listed.isFile() || !Number.isSafeInteger(listed.size) || listed.size > MAX_SETTINGS_BYTES) return {};
		fd = openSync(path, "r");
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.size !== listed.size || opened.size > MAX_SETTINGS_BYTES) return {};
		const bytes = Buffer.allocUnsafe(opened.size);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (count === 0) return {};
			offset += count;
		}
		if (fstatSync(fd).size !== opened.size) return {};
		const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const row = parsed as Record<string, unknown>;
		if (row.version !== 1 || !row.preferences || typeof row.preferences !== "object" || Array.isArray(row.preferences)) return {};
		const prefs = row.preferences as Record<string, unknown>;
		if (prefs.mindCapture !== undefined && prefs.mindCapture !== "auto" && prefs.mindCapture !== "prompt" && prefs.mindCapture !== "off") return {};
		if (prefs.mindNudge !== undefined && typeof prefs.mindNudge !== "boolean") return {};
		return { ...(prefs.mindCapture === undefined ? {} : { mindCapture: prefs.mindCapture as MindSettings["mindCapture"] }), ...(prefs.mindNudge === undefined ? {} : { mindNudge: prefs.mindNudge as boolean }) };
	} catch { return {}; }
	finally { if (fd !== undefined) closeSync(fd); }
}

export function resolveMindSettings(agentDir: string, env: NodeJS.ProcessEnv, sessionId: string): MindSettings {
	const key = `${sessionId}\0${agentDir}`;
	const cached = snapshots.get(key);
	if (cached) return { ...cached };
	const saved = savedPreferences(join(agentDir, "persona", "settings.json"));
	const settings: MindSettings = {
		mindCapture: env.PI_PERSONA_MIND_CAPTURE !== undefined ? captureMode(env) : saved.mindCapture ?? "auto",
		mindNudge: env.PI_PERSONA_MIND_NUDGE !== undefined ? env.PI_PERSONA_MIND_NUDGE !== "off" : saved.mindNudge ?? true,
	};
	snapshots.set(key, settings);
	return { ...settings };
}

export function resetMindSettings(sessionId: string): void {
	for (const key of snapshots.keys()) if (key.startsWith(`${sessionId}\0`)) snapshots.delete(key);
}
