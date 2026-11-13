import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryEntry } from "../core/memory.ts";
import { buildInspectorTimeline, findMemoryRecordingSource, findSessionNoteRecordingSource, INSPECTOR_PAGE_SIZE, MAX_INSPECTOR_BRANCH_ENTRIES } from "../core/memory-inspector.ts";
import type { SessionMemory } from "../session-memory.ts";
import type { MindService } from "../core/service.ts";

export type InspectorTab = "memories" | "context" | "timeline";
export type InspectorScope = "session" | "project" | "project-long" | "persona" | "shared";
export interface InspectorRequest { tab: InspectorTab; scope: InspectorScope; query: string; offset: number }
export interface InspectorItem { id: string; title: string; body: string; source?: { title: string; body: string } }
export interface InspectorPage { items: InspectorItem[]; total: number; offset: number; nextOffset?: number; notice: string }

const PAGE_SIZE = INSPECTOR_PAGE_SIZE;
const safeOffset = (offset: number): number => Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
const safeQuery = (query: string): string => typeof query === "string" ? query.slice(0, 512) : "";
function inspectionScope(mind: MindService): ReturnType<MindService["inspectionScope"]> | undefined {
	try { return mind.inspectionScope(); } catch { return undefined; }
}
function unavailable(notice: string): InspectorPage { return { items: [], total: 0, offset: 0, notice }; }
function sessionNoteItems(ctx: ExtensionContext, sessionMemory: SessionMemory, request: InspectorRequest): InspectorPage {
	const snapshot = sessionMemory.snapshot(ctx);
	if (!snapshot.ok) return unavailable(`Active-session notes unavailable: ${snapshot.reason ?? "snapshot failed"}.`);
	let branch: unknown[] = [];
	let noteHistory: unknown[] = [];
	try {
		branch = ctx.sessionManager.getBranch().slice(-MAX_INSPECTOR_BRANCH_ENTRIES);
		noteHistory = ctx.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-persona-mind-session-note").map((entry) => entry.type === "custom" ? entry.data : undefined);
	} catch { /* current snapshot remains useful; source is omitted without native evidence */ }
	const query = safeQuery(request.query).trim().toLowerCase();
	const entries = snapshot.notes.filter((note) => !query || `${note.kind} ${note.text} ${note.source ?? ""}`.toLowerCase().includes(query)).sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
	const offset = safeOffset(request.offset);
	const page = entries.slice(offset, offset + PAGE_SIZE);
	return { items: page.map((note) => {
		const source = findSessionNoteRecordingSource(note, branch, noteHistory);
		const body = [`text: ${note.text}`, `id: ${note.id}`, `kind: ${note.kind}`, `recorded: ${note.recordedAt}`, `origin session id: ${note.originSessionId}`, ...(note.source === undefined ? [] : [`literal source metadata (not opened): ${note.source}`]), ...(source ? [] : ["No resolvable recording in this active-branch window."])].join("\n");
		return { id: note.id, title: `${note.kind} · ${note.recordedAt} · ${note.text.replace(/\s+/g, " ").slice(0, 100)}`, body, ...(source ? { source } : {}) };
	}), total: entries.length, offset, ...(offset + page.length < entries.length ? { nextOffset: offset + page.length } : {}), notice: `Active-branch session notes only (${snapshot.storage} storage). Recording-source lookup covers the newest ${MAX_INSPECTOR_BRANCH_ENTRIES} native entries. ${entries.length} matching active notes.` };
}

export async function loadInspectorPage(ctx: ExtensionContext, mind: MindService, sessionMemory: SessionMemory, request: InspectorRequest): Promise<InspectorPage> {
	const offset = safeOffset(request.offset);
	const query = safeQuery(request.query);
	if (request.tab === "context") return unavailable("No context snapshot is available from the read-only inspector data layer.");
	if (request.tab === "timeline") {
		try {
			const branch = ctx.sessionManager.getBranch();
			const history = ctx.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-persona-mind-session-note").map((entry) => entry.type === "custom" ? entry.data : undefined);
			const page = buildInspectorTimeline(branch, history, { query, offset });
			return { items: page.items.map(({ id, title, body, source }) => ({ id, title, body, ...(source ? { source } : {}) })), total: page.total, offset: page.offset, ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }), notice: page.notice };
		} catch { return unavailable("Native active-branch timeline is unavailable."); }
	}
	if (request.scope === "session") return sessionNoteItems(ctx, sessionMemory, { ...request, query, offset });
	const activeScope = inspectionScope(mind);
	if (!activeScope) return unavailable("Mind inspection scope is unavailable; no memory store was read.");
	if ((request.scope === "project" || request.scope === "project-long") && activeScope.homeWorkspace) return unavailable("Project memory scopes are unavailable in the home workspace.");
	try {
		const target = request.scope;
		const inspection = await mind.createOptimizer().inspect(target, { query, offset, max: PAGE_SIZE });
		if (!inspection.ok) return unavailable(`Memory inspection unavailable: ${inspection.reason}`);
		let branch: unknown[] = [];
		try { branch = ctx.sessionManager.getBranch().slice(-MAX_INSPECTOR_BRANCH_ENTRIES); } catch { /* missing native branch means no recording-source link */ }
		const items = inspection.entries.map((entry: MemoryEntry) => {
			const source = activeScope ? findMemoryRecordingSource(entry, branch, target, activeScope) : undefined;
			const details = [`text: ${entry.text}`, `id: ${entry.id}`, `target: ${target}`, `kind: ${entry.kind}`, `recorded: ${entry.recordedAt}`, `last seen: ${entry.lastSeenAt}`, ...(entry.expiresAt ? [`expires: ${entry.expiresAt}`] : []), ...(entry.tags.length ? [`tags: ${entry.tags.join(", ")}`] : []), ...(entry.persona ? [`persona marker: ${entry.persona}`] : []), ...(entry.source ? [`literal source metadata (not opened): ${entry.source}`] : []), ...(entry.derivedFrom?.length ? [`derivedFrom literal IDs (not opened): ${entry.derivedFrom.join(", ")}`] : []), ...(entry.supersedes ? [`supersedes literal ID (not opened): ${entry.supersedes}`] : []), ...(source ? [] : ["No resolvable recording in this active-branch window."])];
			return { id: entry.id, title: entry.text, body: details.join("\n"), ...(source ? { source } : {}) };
		});
		return { items, total: inspection.matched, offset: inspection.offset, ...(inspection.nextOffset === undefined ? {} : { nextOffset: inspection.nextOffset }), notice: `${target} memory; read-only inspection. ${inspection.matched} matching safe entries in this store. Recording-source lookup covers the newest ${MAX_INSPECTOR_BRANCH_ENTRIES} active-branch entries. Source and derivedFrom values are literal provenance, not verified evidence or cross-store links.` };
	} catch { return unavailable("Memory inspection failed safely; no store recovery or mutation was attempted."); }
}
