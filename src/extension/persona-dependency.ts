/** Mind requires the loaded Persona extension's public, synchronous capability protocol. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PERSONA_COMPANION_CHANNEL = "pi-persona:companion:v1";
export const PERSONA_MEMORY_OWNER_CHANNEL = "pi-persona:memory-owner:v1";
export const PERSONA_MEMORY_OWNER_CHANGED = "pi-persona:memory-owner-changed:v1";
export const PERSONA_REQUIRED_REASON = "Mind is inactive: load a compatible pi-persona extension and /reload.";
export interface PersonaPresence {
	version: 1;
	provider: "pi-persona";
	role: "supervisor" | "leg" | "disabled";
	capabilities: { memory: 1 | false; activity: 1 | false };
}
export type PersonaDependency = { ok: true; presence: PersonaPresence } | { ok: false; reason: string };
export interface PersonaMemoryOwner { version: 1; provider: "pi-persona"; sessionId: string; ready: boolean; persona: string | null }
export function parsePersonaMemoryOwner(value: unknown, sessionId: string): PersonaMemoryOwner | undefined {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const row = value as Record<string, unknown>;
		if (Reflect.ownKeys(row).some((key) => !["version", "provider", "sessionId", "ready", "persona"].includes(String(key)))) return undefined;
		if (row.version !== 1 || row.provider !== "pi-persona" || row.sessionId !== sessionId || typeof row.ready !== "boolean" || (row.persona !== null && (typeof row.persona !== "string" || !row.persona.trim() || row.persona.length > 1024))) return undefined;
		return { version: 1, provider: "pi-persona", sessionId, ready: row.ready, persona: row.persona as string | null };
	} catch { return undefined; }
}

export function queryPersonaMemoryOwner(pi: Pick<ExtensionAPI, "events">, ctx: ExtensionContext): PersonaMemoryOwner | undefined {
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		const responses: unknown[] = [];
		let accepting = true;
		try { pi.events.emit(PERSONA_MEMORY_OWNER_CHANNEL, { version: 1, sessionId, respond: (owner: unknown) => { if (accepting) responses.push(owner); } }); }
		finally { accepting = false; }
		return responses.length === 1 ? parsePersonaMemoryOwner(responses[0], sessionId) : undefined;
	} catch { return undefined; }
}

function validPresence(value: unknown): value is PersonaPresence {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some((key) => !["version", "provider", "role", "capabilities"].includes(key))) return false;
	if (row.version !== 1 || row.provider !== "pi-persona" || typeof row.role !== "string" || !["supervisor", "leg", "disabled"].includes(row.role)) return false;
	if (!row.capabilities || typeof row.capabilities !== "object" || Array.isArray(row.capabilities)) return false;
	const caps = row.capabilities as Record<string, unknown>;
	if (Object.keys(caps).some((key) => key !== "memory" && key !== "activity")) return false;
	if ((caps.memory !== 1 && caps.memory !== false) || (caps.activity !== 1 && caps.activity !== false)) return false;
	return row.role === "supervisor" ? caps.memory === 1 && caps.activity === 1
		: row.role === "leg" ? caps.memory === 1 && caps.activity === false
		: caps.memory === false && caps.activity === false;
}

export function queryPersonaDependency(pi: Pick<ExtensionAPI, "events">): PersonaDependency {
	const responses: unknown[] = [];
	let accepting = true;
	try { pi.events.emit(PERSONA_COMPANION_CHANNEL, { version: 1, respond: (presence: unknown) => { if (accepting) responses.push(presence); } }); }
	catch { return { ok: false, reason: PERSONA_REQUIRED_REASON }; }
	finally { accepting = false; }
	try {
		if (responses.length !== 1 || !validPresence(responses[0]) || responses[0].capabilities.memory !== 1) return { ok: false, reason: PERSONA_REQUIRED_REASON };
		return { ok: true, presence: structuredClone(responses[0]) };
	} catch { return { ok: false, reason: PERSONA_REQUIRED_REASON }; }
}

/** Active tool selection is discovery only; this wrapper also guards direct programmatic execution. */
export function personaGuardedTools(pi: ExtensionAPI, unavailableReason: (ctx: ExtensionContext) => string | undefined): ExtensionAPI {
	const guarded = Object.create(pi) as ExtensionAPI;
	guarded.registerTool = (definition) => pi.registerTool({
		...definition,
		async execute(...args) {
			const reason = unavailableReason(args[4]);
			// Pi converts thrown tool errors to its native error result, also for executeTool().
			if (reason) throw new Error(reason);
			return definition.execute(...args);
		},
	});
	return guarded;
}
