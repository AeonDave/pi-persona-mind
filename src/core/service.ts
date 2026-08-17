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
import { clampBacklogMax, compactTerminal, makeBacklog, openItems, orderBacklog, transition, validateBacklog, viewFor, MAX_BACKLOG_NOTE_CHARS, MAX_BACKLOG_TAGS, MAX_BACKLOG_TAG_CHARS, MAX_BACKLOG_TEXT_CHARS } from "./backlog.ts";
import { contentId } from "./ids.ts";
import type { MindBudget } from "./inject.ts";
import { renderMind } from "./inject.ts";
import type { MemoryEntry, MemoryInput, MemoryKind, MemoryTerm } from "./memory.ts";
import { clampRecallMax, isExpired, isMemoryId, makeMemory, memoryContentKey, memoryIdMatches, promoteToLong, pruneExpired, recall, sameMemoryContent, supersedeTargets, upsertMemory, validateLongMemory, validateShortMemory, MAX_MEMORY_DERIVED_IDS, MAX_MEMORY_ID_CHARS, MAX_MEMORY_SOURCE_CHARS, MAX_MEMORY_TAGS, MAX_MEMORY_TAG_CHARS, MAX_MEMORY_TEXT_CHARS } from "./memory.ts";
import { scanContent } from "./scanner.ts";
import type { Scope } from "./scope.ts";
import { JsonStore, type JsonStoreOptions, withFileLock } from "./store.ts";

const STORE_VERSION = 1;

/** How many per-fact ids an ambiguity refusal spells out before it summarizes the remainder. */
const MAX_AMBIGUITY_IDS_IN_REASON = 5;

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

export interface BacklogListOptions {
	all?: boolean;
	state?: BacklogState;
	/** Optional page size; omitted for the compatibility view, bounded pages use `backlogListPage`. */
	max?: number;
}

export interface BacklogListPage {
	items: BacklogEntry[];
	total: number;
	withheld: number;
}

export type Recallable = "long" | "short" | "both";

/** One of the distinct facts a shared historical handle addresses, named by an id of its own. */
export interface AmbiguousMemory {
	/** This fact's CURRENT content id. Distinct facts always hash differently, so it names one entry. */
	id: string;
	kind: MemoryKind;
	text: string;
	/** False while this id is still the shared handle itself — the one legacy-encodable member of the
	 *  collision keeps the ambiguous id as its own, and becomes addressable once the others are gone. */
	resolves: boolean;
}

export type RememberResult = { ok: true; entry: MemoryEntry } | { ok: false; reason: string };
export type BacklogAddResult = { ok: true; entry: BacklogEntry } | { ok: false; reason: string };
export type BacklogSetResult = { ok: true; entry: BacklogEntry } | { ok: false; reason?: string };
export type ForgetResult = { removed: number; reason?: "ambiguous_id"; candidates?: AmbiguousMemory[] };

function storageFailure(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return `storage error: ${message || "unknown persistence failure"}`;
}

/**
 * The distinct facts a shared handle addresses, each named by an id of its OWN. A refusal that offers
 * no way forward is a dead end: destroying nothing is right, but the caller still has to be able to
 * pick one. Distinct facts always hash to distinct current ids, so every member of a collision is
 * nameable — except the single member whose v1 and v2 encodings coincide (that id IS the shared
 * handle), which becomes addressable as soon as its neighbours are gone.
 */
function ambiguityCandidates(pool: readonly MemoryEntry[], id: string): AmbiguousMemory[] {
	const distinct = new Map<string, MemoryEntry>();
	for (const entry of pool) if (memoryIdMatches(entry, id)) distinct.set(memoryContentKey(entry), entry);
	return [...distinct.values()]
		.map((entry) => {
			const handle = contentId(entry.kind, entry.text, entry.tags);
			const reached = new Set(pool.filter((e) => memoryIdMatches(e, handle)).map((e) => memoryContentKey(e)));
			return { id: handle, kind: entry.kind, text: entry.text, resolves: reached.size === 1 };
		})
		.sort((a, b) => Number(b.resolves) - Number(a.resolves));
}

function ambiguousSupersedesReason(id: string, candidates: readonly AmbiguousMemory[]): string {
	// The reason is read by the model, so the offer list is bounded rather than as long as the collision.
	const shown = candidates.slice(0, MAX_AMBIGUITY_IDS_IN_REASON);
	const offers = shown.map((c) => (c.resolves ? c.id : `${c.id} (still the shared handle — usable once the others are gone)`)).join(", ");
	const rest = candidates.length - shown.length;
	return `memory supersedes id ${id} is ambiguous — it addresses ${candidates.length} distinct stored memories; supersede one of them by its own current id instead: ${offers}${rest > 0 ? `, and ${rest} more` : ""}`;
}

function safePersistedText(text: string): { text: string; withheld: boolean } {
	const scan = scanContent(text);
	return scan.ok
		? { text, withheld: false }
		: { text: `[withheld unsafe stored content — ${scan.reason ?? "content policy"}]`, withheld: true };
}

function validateNewTextAndTags(text: string, tags: readonly string[] | undefined, label: string, maxText: number, maxTags: number, maxTagChars: number): string | undefined {
	if (text.length > maxText) return `${label} text exceeds ${maxText} characters`;
	if (tags === undefined) return undefined;
	if (!Array.isArray(tags)) return `${label} tags must be an array`;
	if (tags.length > maxTags) return `${label} has more than ${maxTags} tags`;
	if (tags.some((tag) => typeof tag !== "string" || tag.length > maxTagChars)) return `${label} tag exceeds ${maxTagChars} characters`;
	for (const tag of tags) {
		const scan = scanContent(tag);
		if (!scan.ok) return `${label} tag rejected: ${scan.reason ?? "content policy"}`;
	}
	return undefined;
}

function validPositiveFutureOffset(value: number | undefined, unitMs: number, now: number): boolean {
	if (value === undefined) return true;
	if (!Number.isFinite(value) || value <= 0) return false;
	const target = now + value * unitMs;
	return Number.isFinite(target) && Number.isFinite(new Date(target).getTime());
}

export class MindService {
	private readonly now: () => number;
	private readonly budget: MindBudget | undefined;
	private readonly ltm: JsonStore<MemoryEntry>;
	private readonly shared: JsonStore<MemoryEntry>;
	private readonly stm: JsonStore<MemoryEntry>;
	private readonly backlog: JsonStore<BacklogEntry>;
	private readonly memoryMutationLock: string;
	private readonly warn: (message: string) => void;

	constructor(
		private readonly scope: Scope,
		opts: MindServiceOptions = {},
	) {
		this.now = opts.now ?? Date.now;
		this.budget = opts.budget;
		this.warn = opts.onWarn ?? (() => {});
		const longOpts: JsonStoreOptions<MemoryEntry> = { version: STORE_VERSION, validateEntry: validateLongMemory, now: this.now };
		const shortOpts: JsonStoreOptions<MemoryEntry> = { version: STORE_VERSION, validateEntry: validateShortMemory, now: this.now };
		const backlogOpts: JsonStoreOptions<BacklogEntry> = { version: STORE_VERSION, validateEntry: validateBacklog, now: this.now };
		if (opts.onWarn) {
			longOpts.onWarn = opts.onWarn;
			shortOpts.onWarn = opts.onWarn;
			backlogOpts.onWarn = opts.onWarn;
		}
		this.ltm = new JsonStore<MemoryEntry>(scope.paths.ltm, longOpts);
		this.shared = new JsonStore<MemoryEntry>(scope.paths.shared, longOpts);
		this.stm = new JsonStore<MemoryEntry>(scope.paths.stm, shortOpts);
		this.backlog = new JsonStore<BacklogEntry>(scope.paths.backlog, backlogOpts);
		this.memoryMutationLock = `${scope.paths.stm}.memory-transaction.lock`;
	}

	private safeMemories(entries: readonly MemoryEntry[], tier: string): MemoryEntry[] {
		let withheld = 0;
		const safe = entries.map((entry) => {
			const guarded = safePersistedText(entry.text);
			if (!guarded.withheld) return entry;
			withheld++;
			return { ...entry, text: guarded.text };
		});
		if (withheld > 0) this.warn(`${withheld} unsafe persisted ${tier} memor${withheld === 1 ? "y was" : "ies were"} withheld from model context`);
		return safe;
	}

	private safeBacklog(entries: readonly BacklogEntry[]): BacklogEntry[] {
		let withheld = 0;
		const safe = entries.map((entry) => {
			const text = safePersistedText(entry.text);
			const note = entry.note === undefined ? undefined : safePersistedText(entry.note);
			if (!text.withheld && !note?.withheld) return entry;
			withheld++;
			return {
				...entry,
				text: text.text,
				...(note ? { note: note.text } : {}),
			};
		});
		if (withheld > 0) this.warn(`${withheld} unsafe persisted backlog item${withheld === 1 ? " was" : "s were"} withheld from model context`);
		return safe;
	}

	// ── memory ────────────────────────────────────────────────────────────────

	/** Store a memory (long or short term). Scanned + non-empty-checked before it is persisted. */
	async remember(input: RememberInput): Promise<RememberResult> {
		const now = this.now();
		const text = input.text.trim();
		if (!text) return { ok: false, reason: "memory text is empty" };
		const sizeError = validateNewTextAndTags(text, input.tags, "memory", MAX_MEMORY_TEXT_CHARS, MAX_MEMORY_TAGS, MAX_MEMORY_TAG_CHARS);
		if (sizeError) return { ok: false, reason: sizeError };
		if (input.source !== undefined && (typeof input.source !== "string" || input.source.length > MAX_MEMORY_SOURCE_CHARS)) {
			return { ok: false, reason: `memory source exceeds ${MAX_MEMORY_SOURCE_CHARS} characters` };
		}
		if (input.source !== undefined) {
			const sourceScan = scanContent(input.source);
			if (!sourceScan.ok) return { ok: false, reason: `memory source rejected: ${sourceScan.reason ?? "content policy"}` };
		}
		if (input.supersedes !== undefined && !isMemoryId(input.supersedes)) {
			return { ok: false, reason: `memory supersedes id must be one safe token of at most ${MAX_MEMORY_ID_CHARS} characters` };
		}
		if (input.derivedFrom !== undefined) {
			if (!Array.isArray(input.derivedFrom) || input.derivedFrom.length > MAX_MEMORY_DERIVED_IDS) {
				return { ok: false, reason: `memory has more than ${MAX_MEMORY_DERIVED_IDS} derived ids` };
			}
			if (input.derivedFrom.some((id) => !isMemoryId(id))) {
				return { ok: false, reason: `memory derived id must be one safe token of at most ${MAX_MEMORY_ID_CHARS} characters` };
			}
		}
		if (!validPositiveFutureOffset(input.ttlHours, 3_600_000, now)) return { ok: false, reason: "ttlHours must be a finite positive duration within the supported date range" };
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

		const entry = makeMemory(makeInput, now);
		const store = term === "short" ? this.stm : input.toShared ? this.shared : this.ltm;
		try {
			let committed: MemoryEntry | undefined;
			let ambiguous: { id: string; candidates: AmbiguousMemory[] } | undefined;
			await withFileLock(this.memoryMutationLock, async () => {
				if (entry.supersedes !== undefined) {
					// Same contract as `forget`: a handle that addresses more than one fact retires none of
					// them, and the caller is told so rather than silently getting a partial write. Read under
					// the mutation lock every writer holds, so the answer cannot go stale before the update.
					// The pool is the one `forget` resolves against — ALL THREE memory tiers, not just the one
					// being written: a v1 comma-joined id can name a durable fact in `shared` and another in
					// `ltm`, and a per-store check would still let the write destroy whichever copy sits in the
					// target tier while the delete path refuses the identical handle.
					const [ltm, shared, stm] = await Promise.all([this.ltm.load(), this.shared.load(), this.stm.load()]);
					const visible = [...ltm.entries, ...shared.entries, ...pruneExpired(stm.entries, this.now())];
					if (supersedeTargets(visible, entry.supersedes).ambiguous) {
						ambiguous = { id: entry.supersedes, candidates: ambiguityCandidates(visible, entry.supersedes) };
						return;
					}
				}
				const updated = await store.update((es) => upsertMemory(term === "short" ? pruneExpired(es, this.now()) : es, entry));
				committed = updated.entries.find((candidate) => sameMemoryContent(candidate, entry));
			});
			if (ambiguous) {
				return { ok: false, reason: ambiguousSupersedesReason(ambiguous.id, ambiguous.candidates) };
			}
			return { ok: true, entry: committed ?? entry };
		} catch (err) {
			return { ok: false, reason: storageFailure(err) };
		}
	}

	/** Graduate a short-term entry into the persona's long-term store (model-free consolidation). */
	async promote(id: string): Promise<{ ok: true; entry: MemoryEntry; ambiguousSupersedes?: string } | { ok: false; reason?: string }> {
		try {
			return await withFileLock(this.memoryMutationLock, async () => {
				const stm = await this.stm.load();
				const found = stm.entries.find((e) => memoryIdMatches(e, id));
				if (!found || isExpired(found, this.now())) return { ok: false } as const;
				const promoted = promoteToLong(found, this.now());
				// Write the durable tier FIRST, then remove from short-term: a crash between the two leaves a
				// harmless duplicate (collapsed by id on recall/inject) rather than losing the entry entirely.
				let unretired: string | undefined;
				const updated = await this.ltm.update((es) => {
					// The lineage handle rides along from the short-term entry, so it can be one of the shared v1
					// ids `upsertMemory` refuses to act on. The graduation still stands, but a caller told only
					// "promoted" would believe the retirement happened. Re-derived per attempt: the store may
					// replay this mutator after lock recovery, and only the committed attempt counts.
					unretired = promoted.supersedes !== undefined && supersedeTargets(es, promoted.supersedes).ambiguous ? promoted.supersedes : undefined;
					return upsertMemory(es, promoted);
				});
				await this.stm.update((es) => es.filter((e) => !sameMemoryContent(e, found)));
				const entry = updated.entries.find((e) => sameMemoryContent(e, promoted)) ?? promoted;
				return unretired === undefined ? ({ ok: true, entry } as const) : ({ ok: true, entry, ambiguousSupersedes: unretired } as const);
			});
		} catch (err) {
			return { ok: false, reason: storageFailure(err) };
		}
	}

	/** Merge shared ⊕ persona long-term memory (the persona's entry wins on an id conflict). */
	private async longMemories(): Promise<MemoryEntry[]> {
		const [shared, persona] = await Promise.all([this.shared.load(), this.ltm.load()]);
		const merged = new Map<string, MemoryEntry>();
		for (const e of [...shared.entries, ...persona.entries]) {
			merged.set(memoryContentKey(e), e);
		}
		return [...merged.values()];
	}

	/** Keyword + recency recall across the requested tier(s). Returns the top `max` plus the TOTAL
	 *  number of matches, so the caller can tell the model what it withheld. Short-term is pruned first. */
	async recall(query: string, term: Recallable, max: number): Promise<{ hits: MemoryEntry[]; total: number; withheldUnsafe: number }> {
		const limit = clampRecallMax(max);
		const pool: MemoryEntry[] = [];
		if (term === "long" || term === "both") pool.push(...(await this.longMemories()));
		if (term === "short" || term === "both") pool.push(...pruneExpired((await this.stm.load()).entries, this.now()));
		// A fact can live in both tiers under different historical IDs (e.g. after migration) — collapse
		// by semantic content (keep the most-recently-seen) so it is neither returned twice nor counted.
		const deduped = new Map<string, MemoryEntry>();
		for (const e of pool) {
			const key = memoryContentKey(e);
			const previous = deduped.get(key);
			if (!previous || Date.parse(e.lastSeenAt) > Date.parse(previous.lastSeenAt)) deduped.set(key, e);
		}
		const all = recall([...deduped.values()], query, this.now(), { max: Number.MAX_SAFE_INTEGER });
		let withheldUnsafe = 0;
		const safe = all.map((entry) => {
			const guarded = safePersistedText(entry.text);
			if (guarded.withheld) withheldUnsafe++;
			return guarded.withheld ? { ...entry, text: guarded.text } : entry;
		});
		return { hits: safe.slice(0, limit), total: safe.length, withheldUnsafe };
	}

	/** Remove a memory by id from every memory tier it appears in. Returns how many were removed. */
	async forget(id: string): Promise<ForgetResult> {
		return withFileLock(this.memoryMutationLock, async () => {
			const stores = [this.ltm, this.shared, this.stm];
			const loaded = await Promise.all(stores.map((store) => store.load()));
			const matches = loaded.flatMap((result) => result.entries.filter((entry) => memoryIdMatches(entry, id)));
			const representatives = new Set(matches.map((entry) => memoryContentKey(entry)));
			// A v1 id can be ambiguous because comma-joining erased the tag boundary. Never delete two
			// different semantic facts merely because they share that historical handle — but hand back
			// the per-fact ids that DO resolve, or the refusal is a store the caller can never repair.
			if (representatives.size > 1) {
				return { removed: 0, reason: "ambiguous_id", candidates: ambiguityCandidates(loaded.flatMap((result) => result.entries), id) };
			}
			let removed = 0;
			for (let i = 0; i < stores.length; i++) {
				if (!loaded[i]?.entries.some((entry) => memoryIdMatches(entry, id))) continue;
				const after = await stores[i]!.update((es) => es.filter((entry) => !memoryIdMatches(entry, id)));
				removed += loaded[i]!.entries.length - after.entries.length;
			}
			return { removed };
		});
	}

	// ── backlog ───────────────────────────────────────────────────────────────

	/** Add a deferred intent (open). Scanned + non-empty-checked. */
	async backlogAdd(input: BacklogAddInput): Promise<BacklogAddResult> {
		const now = this.now();
		const text = input.text.trim();
		if (!text) return { ok: false, reason: "backlog text is empty" };
		const sizeError = validateNewTextAndTags(text, input.tags, "backlog", MAX_BACKLOG_TEXT_CHARS, MAX_BACKLOG_TAGS, MAX_BACKLOG_TAG_CHARS);
		if (sizeError) return { ok: false, reason: sizeError };
		if (!validPositiveFutureOffset(input.dueInSeconds, 1_000, now)) return { ok: false, reason: "dueInSeconds must be a finite positive duration within the supported date range" };
		const scan = scanContent(text);
		if (!scan.ok) return { ok: false, reason: scan.reason ?? "rejected by content scanner" };
		const makeInput = { text, persona: this.scope.persona } as Parameters<typeof makeBacklog>[0];
		if (input.tags) makeInput.tags = input.tags;
		if (input.dueInSeconds !== undefined) makeInput.dueInSeconds = input.dueInSeconds;
		const entry = makeBacklog(makeInput, now);
		try {
			await this.backlog.update((es) => [...compactTerminal(es).filter((e) => e.id !== entry.id), entry]);
			return { ok: true, entry };
		} catch (err) {
			return { ok: false, reason: storageFailure(err) };
		}
	}

	private async backlogView(opts: BacklogListOptions): Promise<BacklogEntry[]> {
		const entries = viewFor((await this.backlog.load()).entries, this.scope.persona, opts.all ?? false);
		const selected = opts.state ? entries.filter((e) => e.state === opts.state) : openItems(entries);
		return this.safeBacklog(orderBacklog(selected, this.now()));
	}

	/** The persona's unfinished view by default; `all` crosses personas and `state` selects history. */
	async backlogList(opts: BacklogListOptions = {}): Promise<BacklogEntry[]> {
		const entries = await this.backlogView(opts);
		return opts.max === undefined ? entries : entries.slice(0, clampBacklogMax(opts.max));
	}

	/** Bounded tool-facing backlog page with an explicit withheld count. */
	async backlogListPage(opts: BacklogListOptions = {}): Promise<BacklogListPage> {
		const entries = await this.backlogView(opts);
		const max = clampBacklogMax(opts.max);
		return { items: entries.slice(0, max), total: entries.length, withheld: Math.max(0, entries.length - max) };
	}

	/** Transition one backlog item; ok=false when the id is unknown. */
	async backlogSet(id: string, state: BacklogState, note?: string): Promise<BacklogSetResult> {
		if (note !== undefined && (typeof note !== "string" || note.length > MAX_BACKLOG_NOTE_CHARS)) {
			return { ok: false, reason: `backlog note exceeds ${MAX_BACKLOG_NOTE_CHARS} characters` };
		}
		if (note !== undefined) {
			const noteScan = scanContent(note);
			if (!noteScan.ok) return { ok: false, reason: `backlog note rejected: ${noteScan.reason ?? "content policy"}` };
		}
		try {
			const cur = await this.backlog.load();
			if (!cur.entries.some((e) => e.id === id)) return { ok: false, reason: "backlog item not found" };
			let transitioned = false;
			const store = await this.backlog.update((es) => {
				const result = transition(es, id, state, note);
				transitioned = result.ok;
				return result.entries;
			});
			if (!transitioned) return { ok: false, reason: `cannot transition backlog item to ${state}` };
			const entry = store.entries.find((e) => e.id === id);
			return entry ? { ok: true, entry } : { ok: false, reason: "backlog item disappeared during update" };
		} catch (err) {
			return { ok: false, reason: storageFailure(err) };
		}
	}

	/** Open backlog items whose wake time has passed (for the session-start re-arm and timer fire). */
	async dueBacklog(): Promise<BacklogEntry[]> {
		const now = this.now();
		return openItems((await this.backlog.load()).entries)
			.filter((e) => e.dueAtEpochMs !== undefined && e.dueAtEpochMs <= now)
			.map((entry) => {
				const guarded = safePersistedText(entry.text);
				return guarded.withheld ? { ...entry, text: guarded.text } : entry;
			});
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
			const ltm = this.safeMemories(await this.longMemories(), "long-term");
			return renderMind({ persona: this.scope.persona, ltm, stm: [], backlog: [], now, lean: true, ...(this.budget ? { budget: this.budget } : {}) });
		}
		const [ltm, stmRaw, backlogRaw] = await Promise.all([this.longMemories(), this.stm.load(), this.backlog.load()]);
		return renderMind({
			persona: this.scope.persona,
			ltm: this.safeMemories(ltm, "long-term"),
			stm: this.safeMemories(pruneExpired(stmRaw.entries, now), "short-term"),
			backlog: this.safeBacklog(orderBacklog(openItems(backlogRaw.entries), now)),
			now,
			...(this.budget ? { budget: this.budget } : {}),
		});
	}
}
