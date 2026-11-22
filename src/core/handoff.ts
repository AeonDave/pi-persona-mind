import { scanContent } from "./scanner.ts";

export const MAX_HANDOFF_RECORD_BYTES = 16_384;
export const MAX_HANDOFF_ENTRIES = 32;
export const MAX_HANDOFF_STORE_BYTES = 128 * 1024;
export const MAX_HANDOFF_GOAL_PREVIEW_CHARS = 160;

export interface HandoffOrigin { sessionId: string; branchId: string | null; cwd: string }
export interface HandoffContext extends HandoffOrigin { persona: string; projectRoot: string; isCurrent?: () => boolean }
export interface HandoffContent { goal: string; completed: string[]; pending: string[]; nextStep: string; references: string[] }
export interface HandoffEntry extends HandoffContent {
	id: string; revision: number; persona: string; projectRoot: string; origin: HandoffOrigin;
	createdAt: string; updatedAt: string; status: "open" | "completed"; resolution?: string;
}
export type HandoffInput =
	| ({ operation: "save" } & HandoffContent)
	| { operation: "list" }
	| { operation: "read"; id: string }
	| { operation: "complete"; id: string; revision: number; resolution: string }
	| { operation: "forget"; id: string; revision: number };

function safeString(value: unknown, max = 4096): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max && scanContent(value).ok;
}
function safeArray(value: unknown): value is string[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 32 || Reflect.ownKeys(value).length !== value.length + 1) return false;
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor) || !safeString(descriptor.value, 2048)) return false;
	}
	return true;
}
function dataRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))
		&& Reflect.ownKeys(value).every((key) => typeof key === "string" && "value" in Object.getOwnPropertyDescriptor(value, key)!);
}
function exactFields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	return required.every((key) => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every((key) => typeof key === "string" && (required.includes(key) || optional.includes(key)));
}
const CONTENT_FIELDS = ["goal", "completed", "pending", "nextStep", "references"] as const;
function content(value: HandoffContent): HandoffContent {
	return { goal: value.goal, completed: [...value.completed], pending: [...value.pending], nextStep: value.nextStep, references: [...value.references] };
}
export function validHandoffContent(value: unknown): value is HandoffContent {
	return dataRecord(value) && CONTENT_FIELDS.every((key) => Object.hasOwn(value, key))
		&& safeString(value.goal) && safeArray(value.completed) && safeArray(value.pending) && safeString(value.nextStep) && safeArray(value.references)
		&& Buffer.byteLength(JSON.stringify(content(value as unknown as HandoffContent)), "utf8") <= MAX_HANDOFF_RECORD_BYTES;
}
export function validContext(value: HandoffContext): boolean {
	return [value.persona, value.projectRoot, value.sessionId, value.cwd].every((s) => safeString(s, 1024)) && (value.branchId === null || safeString(value.branchId, 1024));
}
export function validateHandoff(raw: unknown): HandoffEntry | null {
	if (!dataRecord(raw) || !exactFields(raw, ["id", "revision", "persona", "projectRoot", "origin", "createdAt", "updatedAt", "status", ...CONTENT_FIELDS], ["resolution"])) return null;
	if (!dataRecord(raw.origin) || !exactFields(raw.origin, ["sessionId", "branchId", "cwd"])) return null;
	const origin = raw.origin;
	if (![raw.persona, raw.projectRoot, origin.sessionId, origin.cwd].every((value) => safeString(value, 1024)) || origin.branchId !== null && !safeString(origin.branchId, 1024)) return null;
	if (typeof raw.id !== "string" || !/^[a-f0-9]{32}$/.test(raw.id) || typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || !validHandoffContent(raw)) return null;
	// Writers use ISO timestamps. Exact strings reject coercible arrays/numbers and ignored suffixes.
	const validDate = (value: unknown): value is string => safeString(value, 24) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
	if (!validDate(raw.createdAt) || !validDate(raw.updatedAt)) return null;
	const status = raw.status;
	if (status !== "open" && status !== "completed") return null;
	if (status === "open" ? Object.hasOwn(raw, "resolution") : !safeString(raw.resolution)) return null;
	const entry: HandoffEntry = { id: raw.id, revision: raw.revision, persona: raw.persona as string, projectRoot: raw.projectRoot as string,
		origin: { sessionId: origin.sessionId as string, branchId: origin.branchId as string | null, cwd: origin.cwd as string },
		createdAt: raw.createdAt, updatedAt: raw.updatedAt, status, ...content(raw),
		...(status === "completed" ? { resolution: raw.resolution as string } : {}) };
	return Buffer.byteLength(JSON.stringify(entry), "utf8") <= MAX_HANDOFF_RECORD_BYTES ? entry : null;
}
export function validResolution(value: unknown): value is string { return safeString(value); }
