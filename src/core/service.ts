/**
 * MindService — the integration heart: it binds the durable stores (store.ts) to the resolved
 * scope (scope.ts) and the pure faculties (memory.ts / backlog.ts / inject.ts), and exposes the
 * high-level operations the Pi tools and hooks call. It has NO Pi imports, so it is fully
 * unit-testable over real temp files without a running agent.
 *
 * Four JSON stores back one scope: long-term memory for the active persona, long-term memory shared
 * across personas, short-term (decaying) memory for the project, and the project backlog.
 */

import type { BacklogEntry, BacklogState } from "./backlog.ts";
import { makeBacklog, openItems, transition, validateBacklog, viewFor } from "./backlog.ts";
import type { MindBudget } from "./inject.ts";
import { renderMind } from "./inject.ts";
import type { MemoryEntry, MemoryInput, MemoryKind, MemoryTerm } from "./memory.ts";
import { makeMemory, promoteToLong, pruneExpired, recall, upsertMemory, validateMemory } from "./memory.ts";
import { scanContent } from "./scanner.ts";
import type { Scope } from "./scope.ts";
import { JsonStore, type JsonStoreOptions } from "./store.ts";

const STORE_VERSION = 1;

export interface MindServiceOptions {
	now?: () => number;
	onWarn?: (message: string) => void;
	budget?: MindBudget;
}

export interface RememberInput {
	term: MemoryTerm;
	kind: MemoryKind;
	text: string;
	tags?: string[];
	ttlHours?: number;
	supersedes?: string;
	/** Long-term only: write to the cross-persona shared tier instead of the active persona's. */
	toShared?: boolean;
	source?: string;
	derivedFrom?: string[];
}

export interface BacklogAddInput {
	text: string;
	tags?: string[];
	dueInSeconds?: number;
}

export type Recallable = "long" | "short" | "both";

export type RememberResult = { ok: true; entry: MemoryEntry } | { ok: false; reason: string };
export type BacklogAddResult = { ok: true; entry: BacklogEntry } | { ok: false; reason: string };
export type BacklogSetResult = { ok: true; entry: BacklogEntry } | { ok: false };

export class MindService {
	private readonly now: () => number;
	private readonly budget: MindBudget | undefined;
	private readonly ltm: JsonStore<MemoryEntry>;
	private readonly shared: JsonStore<MemoryEntry>;
	private readonly stm: JsonStore<MemoryEntry>;
	private readonly backlog: JsonStore<BacklogEntry>;

	constructor(
		private readonly scope: Scope,
		opts: MindServiceOptions = {},
	) {
		this.now = opts.now ?? Date.now;
		this.budget = opts.budget;
		const memOpts: JsonStoreOptions<MemoryEntry> = { version: STORE_VERSION, validateEntry: validateMemory, now: this.now };
		const backlogOpts: JsonStoreOptions<BacklogEntry> = { version: STORE_VERSION, validateEntry: validateBacklog, now: this.now };
		if (opts.onWarn) {
			memOpts.onWarn = opts.onWarn;
			backlogOpts.onWarn = opts.onWarn;
		}
		this.ltm = new JsonStore<MemoryEntry>(scope.paths.ltm, memOpts);
		this.shared = new JsonStore<MemoryEntry>(scope.paths.shared, memOpts);
		this.stm = new JsonStore<MemoryEntry>(scope.paths.stm, memOpts);
		this.backlog = new JsonStore<BacklogEntry>(scope.paths.backlog, backlogOpts);
	}

	// ── memory ────────────────────────────────────────────────────────────────

	/** Store a memory (long or short term). Scanned + non-empty-checked before it is persisted. */
	async remember(input: RememberInput): Promise<RememberResult> {
		const text = input.text.trim();
		if (!text) return { ok: false, reason: "memory text is empty" };
		const scan = scanContent(text);
		if (!scan.ok) return { ok: false, reason: scan.reason ?? "rejected by content scanner" };

		// An objective is the persona's durable north-star — always long-term, never a decaying note.
		const term: MemoryTerm = input.kind === "objective" ? "long" : input.term;
		const makeInput: MemoryInput = { term, kind: input.kind, text };
		if (input.tags) makeInput.tags = input.tags;
		if (input.ttlHours !== undefined) makeInput.ttlHours = input.ttlHours;
		if (input.supersedes) makeInput.supersedes = input.supersedes;
		if (input.source) makeInput.source = input.source;
		if (input.derivedFrom && input.derivedFrom.length > 0) makeInput.derivedFrom = input.derivedFrom;
		if (term === "short") makeInput.persona = this.scope.persona;

		const entry = makeMemory(makeInput, this.now());
		const store = term === "short" ? this.stm : input.toShared ? this.shared : this.ltm;
		await store.update((es) => upsertMemory(es, entry));
		return { ok: true, entry };
	}

	/** Graduate a short-term entry into the persona's long-term store (model-free consolidation). */
	async promote(id: string): Promise<{ ok: true; entry: MemoryEntry } | { ok: false }> {
		const stm = await this.stm.load();
		const found = stm.entries.find((e) => e.id === id);
		if (!found) return { ok: false };
		const promoted = promoteToLong(found, this.now());
		// Write the durable tier FIRST, then remove from short-term: a crash between the two leaves a
		// harmless duplicate (collapsed by id on recall/inject) rather than losing the entry entirely.
		await this.ltm.update((es) => upsertMemory(es, promoted));
		await this.stm.update((es) => es.filter((e) => e.id !== id));
		return { ok: true, entry: promoted };
	}

	/** Merge shared ⊕ persona long-term memory (the persona's entry wins on an id conflict). */
	private async longMemories(): Promise<MemoryEntry[]> {
		const [shared, persona] = await Promise.all([this.shared.load(), this.ltm.load()]);
		const byId = new Map<string, MemoryEntry>();
		for (const e of shared.entries) byId.set(e.id, e);
		for (const e of persona.entries) byId.set(e.id, e);
		return [...byId.values()];
	}

	/** Keyword + recency recall across the requested tier(s). Returns the top `max` plus the TOTAL
	 *  number of matches, so the caller can tell the model what it withheld. Short-term is pruned first. */
	async recall(query: string, term: Recallable, max: number): Promise<{ hits: MemoryEntry[]; total: number }> {
		const pool: MemoryEntry[] = [];
		if (term === "long" || term === "both") pool.push(...(await this.longMemories()));
		if (term === "short" || term === "both") pool.push(...pruneExpired((await this.stm.load()).entries, this.now()));
		// A fact can live in both tiers under the same content id (e.g. after a promote crash, or an
		// explicit re-record) — collapse by id (keep the most-recently-seen) so it is neither returned
		// twice nor double-counted in `total`.
		const byId = new Map<string, MemoryEntry>();
		for (const e of pool) {
			const prev = byId.get(e.id);
			if (!prev || Date.parse(e.lastSeenAt) > Date.parse(prev.lastSeenAt)) byId.set(e.id, e);
		}
		const all = recall([...byId.values()], query, this.now(), { max: Number.MAX_SAFE_INTEGER });
		return { hits: all.slice(0, max), total: all.length };
	}

	/** Remove a memory by id from every memory tier it appears in. Returns how many were removed. */
	async forget(id: string): Promise<{ removed: number }> {
		let removed = 0;
		for (const store of [this.ltm, this.shared, this.stm]) {
			const cur = await store.load();
			if (!cur.entries.some((e) => e.id === id)) continue;
			const after = await store.update((es) => es.filter((e) => e.id !== id));
			removed += cur.entries.length - after.entries.length;
		}
		return { removed };
	}

	// ── backlog ───────────────────────────────────────────────────────────────

	/** Add a deferred intent (open). Scanned + non-empty-checked. */
	async backlogAdd(input: BacklogAddInput): Promise<BacklogAddResult> {
		const text = input.text.trim();
		if (!text) return { ok: false, reason: "backlog text is empty" };
		const scan = scanContent(text);
		if (!scan.ok) return { ok: false, reason: scan.reason ?? "rejected by content scanner" };
		const makeInput = { text, persona: this.scope.persona } as Parameters<typeof makeBacklog>[0];
		if (input.tags) makeInput.tags = input.tags;
		if (input.dueInSeconds !== undefined) makeInput.dueInSeconds = input.dueInSeconds;
		const entry = makeBacklog(makeInput, this.now());
		await this.backlog.update((es) => [...es.filter((e) => e.id !== entry.id), entry]);
		return { ok: true, entry };
	}

	/** The persona's backlog view by default; `all` shows every persona's; `state` filters. */
	async backlogList(opts: { all?: boolean; state?: BacklogState } = {}): Promise<BacklogEntry[]> {
		const entries = viewFor((await this.backlog.load()).entries, this.scope.persona, opts.all ?? false);
		return opts.state ? entries.filter((e) => e.state === opts.state) : entries;
	}

	/** Transition one backlog item; ok=false when the id is unknown. */
	async backlogSet(id: string, state: BacklogState, note?: string): Promise<BacklogSetResult> {
		const cur = await this.backlog.load();
		if (!cur.entries.some((e) => e.id === id)) return { ok: false };
		const store = await this.backlog.update((es) => transition(es, id, state, note).entries);
		const entry = store.entries.find((e) => e.id === id);
		return entry ? { ok: true, entry } : { ok: false };
	}

	/** Open backlog items whose wake time has passed (for the session-start re-arm and timer fire). */
	async dueBacklog(): Promise<BacklogEntry[]> {
		const now = this.now();
		return openItems((await this.backlog.load()).entries).filter((e) => e.dueAtEpochMs !== undefined && e.dueAtEpochMs <= now);
	}

	// ── injection ───────────────────────────────────────────────────────────────

	/** Cheap counts for the status line and `/mind` header (expired STM and closed backlog excluded). */
	async summary(): Promise<{ ltm: number; stm: number; backlogOpen: number }> {
		const now = this.now();
		const [ltm, stm, backlog] = await Promise.all([this.longMemories(), this.stm.load(), this.backlog.load()]);
		return { ltm: ltm.length, stm: pruneExpired(stm.entries, now).length, backlogOpen: openItems(backlog.entries).length };
	}

	/**
	 * Assemble the deterministic `<persona-mind>` block. Full mode = long-term ⊕ working-context ⊕
	 * open backlog. `lean` mode (a DELEGATED worker leg) = the north-star + durable identity (long-term)
	 * ONLY, dropping the supervisor's working-context (STM) and backlog: a one-shot worker is not the
	 * persona, so it inherits who the persona IS but not the supervisor's project state or deferred
	 * intent. (The caller also withholds the write tools + wakes from a leg — see index.ts.)
	 */
	async buildInjection(opts: { lean?: boolean } = {}): Promise<string> {
		const now = this.now();
		if (opts.lean) {
			const ltm = await this.longMemories();
			return renderMind({ persona: this.scope.persona, ltm, stm: [], backlog: [], now, lean: true, ...(this.budget ? { budget: this.budget } : {}) });
		}
		const [ltm, stmRaw, backlogRaw] = await Promise.all([this.longMemories(), this.stm.load(), this.backlog.load()]);
		return renderMind({
			persona: this.scope.persona,
			ltm,
			stm: pruneExpired(stmRaw.entries, now),
			backlog: openItems(backlogRaw.entries),
			now,
			...(this.budget ? { budget: this.budget } : {}),
		});
	}
}
