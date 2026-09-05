/**
 * One-way importer for the superseded `pi-`prefixed storage root.
 *
 * The old root is only read.  Destination writes go through JsonStore so two Pi
 * processes importing at the same time cannot lose entries. Two copies of one fact
 * are reconciled by which copy is LATER, not by which root it sits in; distinct
 * same-id content is preserved. Filenames and legacy bytes are not rewritten or removed.
 */

import { lstat, opendir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve, win32 } from "node:path";

import type { BacklogEntry, BacklogState } from "./backlog.ts";
import { validateBacklog } from "./backlog.ts";
import type { MemoryEntry } from "./memory.ts";
import { validateLongMemory, validateShortMemory } from "./memory.ts";
import { contentId } from "./ids.ts";
import { DEFAULT_PERSONA, projectSlug, sanitizePersona, type ProjectSlugOptions } from "./scope.ts";
import { DEFAULT_STORE_MAX_ENTRIES, JsonStore, readTextFileBounded, StoreCapacityError, type JsonStoreOptions } from "./store.ts";

const STORE_VERSION = 1;
const WIN_RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const DEFAULT_MAX_FILES = 256;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const LEGACY_MANIFEST_FILE = ".legacy-import-v1.json";

export type ImportKind = "ltm" | "stm" | "backlog";

interface ImportDirectory {
	relative: string;
	kind: ImportKind;
}

const IMPORT_DIRECTORIES: readonly ImportDirectory[] = [
	{ relative: join("memory", "ltm"), kind: "ltm" },
	{ relative: join("memory", "stm"), kind: "stm" },
	{ relative: "backlog", kind: "backlog" },
];

/** Counts and diagnostics returned by {@link migrateLegacyRoot}. */
export interface MigrationReport {
	/** Recognized JSON files whose contents were read under the three supported legacy directories. */
	filesScanned: number;
	/** Unchanged legacy files skipped from content read/parse by the durable source manifest. */
	filesSkipped: number;
	/** Files a commit touched: a recognized source that yielded at least one imported entry, or a
	 *  current destination whose stored records were reconciled in place (see `entriesAdded`). */
	filesMigrated: number;
	/** Valid, source-semantic-unique legacy entries considered. */
	entriesSeen: number;
	/** Entries newly appended to, or reconciled in place in, the current destination. */
	entriesAdded: number;
	/** Valid entries the destination already held under the same semantic identity (kept or reconciled). */
	conflicts: number;
	/** Entries rejected by the current schema validator. */
	invalidEntries: number;
	warnings: string[];
}

export interface LegacyMigrationOptions {
	/** Override the old root; defaults to `<agentDir>/pi-persona-mind`. */
	legacyRoot?: string;
	/** Override the current root; defaults to `<agentDir>/persona-mind`. */
	destinationRoot?: string;
	/** Injectable clock forwarded to JsonStore. */
	now?: () => number;
	/** Maximum recognized files imported in one pass. */
	maxFiles?: number;
	/** Maximum bytes read from one source file. */
	maxFileBytes?: number;
}

/** Options for the bounded migration of aliases created by the v0.5.2 scope rules. */
export interface ScopeAliasMigrationOptions {
	/** Override the old root; defaults to `<agentDir>/pi-persona-mind`. */
	legacyRoot?: string;
	/** Override the current root; defaults to `<agentDir>/persona-mind`. */
	currentRoot?: string;
	/** Injectable project canonicalization seam, forwarded to {@link projectSlug}. */
	project?: ProjectSlugOptions;
	/** Platform seam for the persona filename rule. Defaults to the project platform when supplied. */
	personaPlatform?: NodeJS.Platform | string;
	/** Injectable clock forwarded to JsonStore. */
	now?: () => number;
	/** Import a lossy/reserved persona alias only when an explicit user command opts in. */
	includeAmbiguousPersonaAlias?: boolean;
	/** Maximum bytes read from one source file. */
	maxFileBytes?: number;
}

function emptyReport(): MigrationReport {
	return {
		filesScanned: 0,
		filesSkipped: 0,
		filesMigrated: 0,
		entriesSeen: 0,
		entriesAdded: 0,
		conflicts: 0,
		invalidEntries: 0,
		warnings: [],
	};
}

interface LegacySourceStamp {
	id: string;
	source: string;
	destination: string;
	kind: ImportKind;
	size: string;
	mtimeNs: string;
	ctimeNs: string;
	dev: string;
	ino: string;
}

const DECIMAL = /^\d+$/;

function validateLegacySourceStamp(raw: unknown): LegacySourceStamp | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.id !== "string" || !/^[a-f0-9]{24}$/.test(raw.id)) return null;
	if (typeof raw.source !== "string" || !raw.source || raw.source.length > 8_192) return null;
	if (typeof raw.destination !== "string" || !raw.destination || raw.destination.length > 8_192) return null;
	if (raw.kind !== "ltm" && raw.kind !== "stm" && raw.kind !== "backlog") return null;
	for (const field of [raw.size, raw.mtimeNs, raw.ctimeNs, raw.dev, raw.ino]) {
		if (typeof field !== "string" || !DECIMAL.test(field)) return null;
	}
	return raw as unknown as LegacySourceStamp;
}

async function sourceStamp(source: string, destination: string, kind: ImportKind): Promise<LegacySourceStamp | null> {
	try {
		const stats = await lstat(source, { bigint: true });
		if (!stats.isFile()) return null;
		return {
			id: createHash("sha256").update(`${resolve(source)}\0${resolve(destination)}`).digest("hex").slice(0, 24),
			source: resolve(source),
			destination: resolve(destination),
			kind,
			size: stats.size.toString(),
			mtimeNs: stats.mtimeNs.toString(),
			ctimeNs: stats.ctimeNs.toString(),
			dev: stats.dev.toString(),
			ino: stats.ino.toString(),
		};
	} catch {
		return null;
	}
}

function sameStamp(a: LegacySourceStamp, b: LegacySourceStamp): boolean {
	return a.source === b.source && a.destination === b.destination && a.kind === b.kind && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.dev === b.dev && a.ino === b.ino;
}

async function regularFileExists(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch {
		return false;
	}
}

function oldPersonaSegment(name: string, _platform: NodeJS.Platform | string = process.platform): string {
	const segment = name
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 64);
	if (!segment) return `persona-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
	const reserved = segment.toLowerCase() === "_shared" || segment.toLowerCase() === "_default" || WIN_RESERVED_DEVICE.test(segment);
	return reserved ? `persona-${segment}` : segment;
}

function oldProjectSlug(projectRoot: string, platform: NodeJS.Platform | string = process.platform): string {
	const canonical = platform === "win32" ? win32.resolve(projectRoot) : resolve(projectRoot);
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
	const baseName = platform === "win32" ? win32.basename(canonical) : basename(canonical);
	const base =
		(baseName || "project")
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "project";
	return `${base}-${hash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function readBounded(path: string, maxBytes: number, report: MigrationReport, label: string): Promise<string | null> {
	try {
		return await readTextFileBounded(path, maxBytes);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") warning(report, `${label}: could not read ${path}: ${String(err)}`);
		return null;
	}
}

export type StoreDiagnosticStatus = "missing" | "ok" | "invalid" | "corrupt";

export interface StoreDiagnostic {
	path: string;
	status: StoreDiagnosticStatus;
	validEntries: number;
	invalidEntries: number;
	message?: string;
}

/** Read-only store validation for `/mind doctor`; unlike JsonStore.load this never quarantines. */
export async function inspectStoreFile(
	path: string,
	kind: ImportKind,
	maxFileBytes = DEFAULT_MAX_FILE_BYTES,
	maxEntries = DEFAULT_STORE_MAX_ENTRIES,
): Promise<StoreDiagnostic> {
	let raw: string;
	try {
		raw = await readTextFileBounded(path, maxFileBytes);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path, status: "missing", validEntries: 0, invalidEntries: 0 };
		return { path, status: "corrupt", validEntries: 0, invalidEntries: 0, message: String(err) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { path, status: "corrupt", validEntries: 0, invalidEntries: 0, message: "invalid JSON" };
	}
	// Name a version skew explicitly: an operator reading `/mind doctor` must be able to tell "another
	// build wrote this" (nothing to repair here) from "these bytes are damaged". The predicate must
	// match JsonStore.parseStore EXACTLY — it refuses only a positive safe-integer version on an
	// otherwise well-formed envelope, and QUARANTINES everything else. Promising "left untouched" for
	// a shape load() moves aside to `*.corrupt-N` would send the operator away from a live data loss.
	if (isRecord(parsed) && Array.isArray(parsed.entries) && typeof parsed.version === "number" && Number.isSafeInteger(parsed.version) && parsed.version > 0 && parsed.version !== STORE_VERSION) {
		return { path, status: "corrupt", validEntries: 0, invalidEntries: 0, message: `store version ${parsed.version} was written by a different pi-persona-mind build (this one reads version ${STORE_VERSION}); it is left untouched` };
	}
	if (!isRecord(parsed) || parsed.version !== STORE_VERSION || typeof parsed.updatedAt !== "string" || !Number.isFinite(Date.parse(parsed.updatedAt)) || typeof parsed.sequence !== "number" || !Number.isSafeInteger(parsed.sequence) || parsed.sequence < 0 || !Array.isArray(parsed.entries)) {
		return { path, status: "corrupt", validEntries: 0, invalidEntries: 0, message: "invalid store envelope" };
	}
	if (parsed.entries.length > maxEntries) {
		return { path, status: "corrupt", validEntries: 0, invalidEntries: 0, message: `exceeds ${maxEntries}-entry limit` };
	}
	const validate = kind === "ltm" ? validateLongMemory : kind === "stm" ? validateShortMemory : validateBacklog;
	let validEntries = 0;
	let invalidEntries = 0;
	for (const entry of parsed.entries) {
		if (validate(entry) === null) invalidEntries++;
		else validEntries++;
	}
	return { path, status: invalidEntries > 0 ? "invalid" : "ok", validEntries, invalidEntries, ...(invalidEntries > 0 ? { message: `${invalidEntries} invalid entr${invalidEntries === 1 ? "y" : "ies"}` } : {}) };
}

function warning(report: MigrationReport, message: string): void {
	report.warnings.push(message);
}

function canonicalizeEntry<E>(entry: E): E {
	if (!isRecord(entry) || typeof entry.text !== "string" || !Array.isArray(entry.tags)) return entry;
	const tags = entry.tags.filter((tag): tag is string => typeof tag === "string");
	const kind = typeof entry.kind === "string" ? entry.kind : "backlog";
	const id = contentId(kind, entry.text, tags);
	return typeof entry.id === "string" && entry.id !== id ? ({ ...entry, id } as E) : entry;
}

function entryIdentity(entry: unknown): string {
	if (!isRecord(entry)) return JSON.stringify(entry);
	const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim().toLowerCase()).filter(Boolean).sort() : [];
	// Content identity is semantic, not the serialized id: v1 comma-joined tags and the
	// collision-safe v2 encoding can address the same fact with different hashes. Conversely,
	// distinct facts that once collided still differ by their normalized tag arrays/text here.
	if (typeof entry.kind === "string" && typeof entry.text === "string") return JSON.stringify([entry.kind, entry.text.trim().replace(/\s+/g, " ").toLowerCase(), tags]);
	if (typeof entry.state === "string" && typeof entry.text === "string") return JSON.stringify(["backlog", entry.text.trim().replace(/\s+/g, " ").toLowerCase(), tags]);
	return JSON.stringify(entry);
}

interface ParsedLegacy<E> {
	entries: E[];
	invalidEntries: number;
}

/** Why one source could not be read as a store. The caller reports it — it may first retry a `.bak`. */
interface LegacyParseFailure {
	failure: string;
}

function isParseFailure<E>(result: ParsedLegacy<E> | LegacyParseFailure): result is LegacyParseFailure {
	return "failure" in result;
}

function parseLegacy<E>(raw: string, validate: (value: unknown) => E | null, path: string, report: MigrationReport): ParsedLegacy<E> | LegacyParseFailure {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { failure: `legacy mind: could not parse ${path}` };
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
		return { failure: `legacy mind: ${path} has no entries array` };
	}

	const entries: E[] = [];
	let invalidEntries = 0;
	const identities = new Set<string>();
	for (const rawEntry of parsed.entries) {
		const entry = validate(canonicalizeEntry(rawEntry));
		if (entry === null) {
			invalidEntries++;
			continue;
		}
		const identity = entryIdentity(entry);
		if (identities.has(identity)) continue;
		identities.add(identity);
		entries.push(entry);
	}
	if (invalidEntries > 0) warning(report, `legacy mind: ${path} contained ${invalidEntries} invalid entr${invalidEntries === 1 ? "y" : "ies"}`);
	return { entries, invalidEntries };
}

/**
 * Read one legacy store, falling back to the `<file>.bak` sidecar JsonStore maintains beside every
 * store (store.ts) when the live bytes are torn. This import is the only pass that will ever carry
 * those entries across — the release note invites the user to delete the legacy root afterwards — so
 * a recoverable last-known-good copy must not be abandoned. null ⇒ nothing was read: the caller must
 * NOT stamp the source, or the next start's skip test would bury the damage forever.
 */
async function readLegacyStore<E>(
	legacyPath: string,
	validate: (value: unknown) => E | null,
	report: MigrationReport,
	maxFileBytes: number,
): Promise<ParsedLegacy<E> | null> {
	const raw = await readBounded(legacyPath, maxFileBytes, report, "legacy mind");
	if (raw === null) return null;
	const parsed = parseLegacy<E>(raw, validate, legacyPath, report);
	if (!isParseFailure(parsed)) return parsed;
	// Only a source we could READ but not PARSE is torn. A source that vanished mid-scan is gone, and
	// importing a leftover sidecar for it would resurrect data the user deleted.
	const backupPath = `${legacyPath}.bak`;
	const backupRaw = await readBounded(backupPath, maxFileBytes, report, "legacy mind");
	const backup = backupRaw === null ? null : parseLegacy<E>(backupRaw, validate, backupPath, report);
	// A sidecar that parses to NOTHING is not a recovery: accepting it would let the caller stamp the
	// torn source as imported, and the skip test would then bury it on every later start — the exact
	// burial this fallback exists to prevent.
	if (backup !== null && !isParseFailure(backup) && backup.entries.length > 0) {
		warning(report, `${parsed.failure}; recovered its last-known-good ${backupPath}`);
		return backup;
	}
	warning(report, `${parsed.failure}; no usable ${backupPath} either — nothing was imported from it`);
	return null;
}

async function importFile(
	legacyPath: string,
	destinationPath: string,
	kind: ImportKind,
	report: MigrationReport,
	now: (() => number) | undefined,
	maxFileBytes: number,
): Promise<boolean> {
	if (kind === "ltm" || kind === "stm") {
		const validate = kind === "ltm" ? validateLongMemory : validateShortMemory;
		const parsed = await readLegacyStore<MemoryEntry>(legacyPath, validate, report, maxFileBytes);
		if (parsed === null) return false;
		report.entriesSeen += parsed.entries.length;
		report.invalidEntries += parsed.invalidEntries;
		if (parsed.entries.length === 0) return true;
		const store = new JsonStore<MemoryEntry>(destinationPath, makeStoreOptions(validate, now, report));
		return mergeImport(store, parsed.entries, report, legacyPath, "legacy mind", reconcileMemory);
	} else {
		const parsed = await readLegacyStore<BacklogEntry>(legacyPath, validateBacklog, report, maxFileBytes);
		if (parsed === null) return false;
		report.entriesSeen += parsed.entries.length;
		report.invalidEntries += parsed.invalidEntries;
		if (parsed.entries.length === 0) return true;
		const store = new JsonStore<BacklogEntry>(destinationPath, makeStoreOptions(validateBacklog, now, report));
		return mergeImport(store, parsed.entries, report, legacyPath, "legacy mind", reconcileBacklog);
	}
}

function makeStoreOptions<E>(validateEntry: (raw: unknown) => E | null, now: (() => number) | undefined, report: MigrationReport): JsonStoreOptions<E> {
	const options: JsonStoreOptions<E> = {
		version: STORE_VERSION,
		validateEntry,
		onWarn: (message) => warning(report, message),
	};
	if (now !== undefined) options.now = now;
	return options;
}

/**
 * How one semantic-identity collision is settled. Returns the destination record ITSELF when the
 * incoming copy carries nothing later — identity comparison is what keeps an unchanged import a
 * genuine no-op that does not bump the store sequence.
 */
type Reconcile<E> = (destination: E, incoming: E) => E;

/**
 * Settle two copies of one fact by FRESHNESS, not by which root they came from.
 *
 * The destination is no longer the newer root: 0.7.0 promotes the pre-0.6 snapshot that the 0.6.x
 * importer drained and deliberately left populated to DESTINATION, so keeping its record on every
 * match would resurrect a superseded copy — a dead `expiresAt` re-expiring a live short-term memory.
 * This is `upsertMemory`'s own live rule rather than a second reconciliation: identity (`id`) and
 * first-recorded (`recordedAt`) stay the destination's, and everything the user last touched comes
 * from whichever copy was seen last. Both sides are validated, so `lastSeenAt` parses on both.
 */
function reconcileMemory(destination: MemoryEntry, incoming: MemoryEntry): MemoryEntry {
	if (Date.parse(incoming.lastSeenAt) <= Date.parse(destination.lastSeenAt)) return destination;
	return { ...incoming, id: destination.id, recordedAt: destination.recordedAt };
}

/** open → taken → done/dropped; the state machine (backlog.ts) only ever moves forward. */
const BACKLOG_PROGRESS: Readonly<Record<BacklogState, number>> = { open: 0, taken: 1, done: 2, dropped: 2 };

/**
 * Settle two copies of one lead by LIFECYCLE PROGRESS, so a terminal state and its note survive a
 * merge in either direction and finished work never reverts to `open`.
 *
 * `state` deliberately stays out of the identity: `contentId("backlog", text, tags)` ignores it, so
 * adding it here would leave an open row and a done row sharing one content id — which the ambiguity
 * guards then refuse to act on, and which `backlog list` shows twice. Because the state machine only
 * moves forward, the further-along record is the later one; taking it whole also carries over the
 * `dueAtEpochMs` that `acknowledgeDue` already cleared, so a delivered wake is not re-armed.
 */
function reconcileBacklog(destination: BacklogEntry, incoming: BacklogEntry): BacklogEntry {
	if (BACKLOG_PROGRESS[incoming.state] <= BACKLOG_PROGRESS[destination.state]) return destination;
	// Carry only what the LIFECYCLE owns: the state, the note that explains it, and the due date, which
	// finishing a lead CLEARS — keeping the superseded copy's would re-arm a wake the user already
	// acknowledged. Identity and retention stay with the destination: taking the further-along copy
	// wholesale would drag its `expiresAt` across against the destination's own `createdAt`, and a
	// superseded lifetime can predate it, leaving a row that expires before it exists.
	const merged: BacklogEntry = { ...destination, state: incoming.state };
	if (incoming.note === undefined) delete merged.note;
	else merged.note = incoming.note;
	if (incoming.dueAtEpochMs === undefined) delete merged.dueAtEpochMs;
	else merged.dueAtEpochMs = incoming.dueAtEpochMs;
	return merged;
}

/** First occurrence wins, so the pre-read check and the locked mutator agree on the destination copy. */
function byIdentity<E>(entries: readonly E[]): Map<string, { at: number; entry: E }> {
	const index = new Map<string, { at: number; entry: E }>();
	for (const [at, entry] of entries.entries()) {
		const identity = entryIdentity(entry);
		if (!index.has(identity)) index.set(identity, { at, entry });
	}
	return index;
}

async function merge<E extends { id: string }>(store: JsonStore<E>, incoming: readonly E[], report: MigrationReport, reconcile: Reconcile<E>): Promise<void> {
	// A read avoids an unnecessary sequence bump on a repeat import. The update
	// callback still re-checks identities while holding JsonStore's per-file lock.
	const current = byIdentity((await store.load()).entries);
	// Count conflicts the way the merge actually dedups — by semantic identity. Counting serialized
	// ids instead let the v2 twin of a record written under the v1 comma-joined id be dropped by the
	// dedup below without the report ever saying so.
	let pending = false;
	for (const entry of incoming) {
		const held = current.get(entryIdentity(entry));
		if (held === undefined) {
			pending = true;
			continue;
		}
		report.conflicts++;
		if (reconcile(held.entry, entry) !== held.entry) pending = true;
	}
	if (!pending) return;

	let addedHere = 0;
	await store.update((entries) => {
		// JsonStore may replay the mutator after lock-ownership recovery; diagnostics must describe
		// the committed attempt, not accumulate counts from abandoned attempts.
		addedHere = 0;
		const next = [...entries];
		const held = byIdentity(next);
		for (const entry of incoming) {
			const identity = entryIdentity(entry);
			const existing = held.get(identity);
			if (existing === undefined) {
				held.set(identity, { at: next.length, entry });
				next.push(entry);
				addedHere++;
				continue;
			}
			const reconciled = reconcile(existing.entry, entry);
			if (reconciled === existing.entry) continue;
			next[existing.at] = reconciled;
			held.set(identity, { at: existing.at, entry: reconciled });
			addedHere++;
		}
		return next;
	});
	if (addedHere > 0) {
		report.entriesAdded += addedHere;
		report.filesMigrated++;
	}
}

/** A full destination is a source-local migration failure, not a reason to stop scanning. */
async function mergeImport<E extends { id: string }>(
	store: JsonStore<E>,
	incoming: readonly E[],
	report: MigrationReport,
	sourcePath: string,
	label: string,
	reconcile: Reconcile<E>,
): Promise<boolean> {
	try {
		await merge(store, incoming, report, reconcile);
		return true;
	} catch (err) {
		if (!(err instanceof StoreCapacityError)) throw err;
		warning(report, `${label}: skipped ${sourcePath} — ${err.message}`);
		return false;
	}
}

async function importAliasFile(
	sourcePath: string,
	destinationPath: string,
	kind: ImportKind,
	report: MigrationReport,
	now: (() => number) | undefined,
	maxFileBytes: number,
): Promise<void> {
	if (!(await regularFileExists(sourcePath))) return;
	report.filesScanned++;

	if (kind === "ltm" || kind === "stm") {
		const validate = kind === "ltm" ? validateLongMemory : validateShortMemory;
		// Same `.bak` recovery as the legacy-root pass: nothing else ever opens the OLD alias filename
		// (`mindPaths` only returns the new names), so this is the one pass that can rescue a torn one.
		const parsed = await readLegacyStore<MemoryEntry>(sourcePath, validate, report, maxFileBytes);
		if (parsed === null) return;
		report.entriesSeen += parsed.entries.length;
		report.invalidEntries += parsed.invalidEntries;
		if (parsed.entries.length === 0) return;
		await mergeImport(new JsonStore<MemoryEntry>(destinationPath, makeStoreOptions(validate, now, report)), parsed.entries, report, sourcePath, "scope alias", reconcileMemory);
		return;
	}

	const parsed = await readLegacyStore<BacklogEntry>(sourcePath, validateBacklog, report, maxFileBytes);
	if (parsed === null) return;
	report.entriesSeen += parsed.entries.length;
	report.invalidEntries += parsed.invalidEntries;
	if (parsed.entries.length === 0) return;
	await mergeImport(new JsonStore<BacklogEntry>(destinationPath, makeStoreOptions(validateBacklog, now, report)), parsed.entries, report, sourcePath, "scope alias", reconcileBacklog);
}

/**
 * A backlog record carries the persona segment that was current when it was written, and the segment
 * rule changed in 0.5.2 — so a record written by an older version no longer matches the live scope
 * and the persona view silently returns nothing (while the injected block still shows the items).
 * Rewrite only THIS persona's own historical segment; another persona's records are left alone, and
 * the no-persona scope is never touched (its records were always written as the `_default` segment).
 */
async function reconcileBacklogPersona(
	path: string,
	from: string,
	to: string,
	report: MigrationReport,
	now: (() => number) | undefined,
): Promise<void> {
	const store = new JsonStore<BacklogEntry>(path, makeStoreOptions(validateBacklog, now, report));
	let reconciled = 0;
	try {
		// Read first so an already-current store is a genuine no-op and does not bump its sequence.
		if (!(await store.load()).entries.some((entry) => entry.persona === from)) return;
		await store.update((entries) => {
			// JsonStore may replay the mutator after lock recovery; count the committed attempt only.
			reconciled = 0;
			return entries.map((entry) => {
				if (entry.persona !== from) return entry;
				reconciled++;
				return { ...entry, persona: to };
			});
		});
	} catch (err) {
		warning(report, `scope alias: could not reconcile the stored persona of ${path}: ${String(err)}`);
		return;
	}
	if (reconciled > 0) {
		report.entriesAdded += reconciled;
		report.filesMigrated++;
	}
}

/**
 * Reconciles at most three old filenames for one already-visited scope, then the persona segment
 * stored inside the current backlog. It does not scan either root: callers choose when a scope is
 * active, keeping startup bounded. Sources are read-only; destination updates use JsonStore locking.
 */
export async function migrateCurrentScopeAliases(
	agentDir: string,
	rawPersona: string | null,
	projectRoot: string,
	options: ScopeAliasMigrationOptions = {},
): Promise<MigrationReport> {
	const report = emptyReport();
	const platform = options.personaPlatform ?? options.project?.platform;
	const persona = rawPersona === null ? DEFAULT_PERSONA : sanitizePersona(rawPersona, platform);
	const project = projectSlug(projectRoot, options.project);
	const oldPersona = oldPersonaSegment(rawPersona ?? DEFAULT_PERSONA, platform);
	const oldProject = oldProjectSlug(projectRoot, options.project?.platform);
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const legacyRoot = options.legacyRoot ?? join(agentDir, "pi-persona-mind");
	const currentRoot = options.currentRoot ?? join(agentDir, "persona-mind");
	const currentBase = currentRoot;
	const roots = [currentRoot, legacyRoot];
	const aliases: readonly { kind: ImportKind; oldRelative: string; newRelative: string }[] = [
		...(options.includeAmbiguousPersonaAlias ? [{ kind: "ltm" as const, oldRelative: join("memory", "ltm", `${oldPersona}.json`), newRelative: join("memory", "ltm", `${persona}.json`) }] : []),
		{ kind: "stm", oldRelative: join("memory", "stm", `${oldProject}.json`), newRelative: join("memory", "stm", `${project}.json`) },
		{ kind: "backlog", oldRelative: join("backlog", `${oldProject}.json`), newRelative: join("backlog", `${project}.json`) },
	];
	const visited = new Set<string>();
	for (const alias of aliases) {
		// A stable ordinary name has no alias to reconcile. This also guarantees
		// the common path is a genuine no-op and does not bump store sequence.
		if (alias.oldRelative === alias.newRelative) continue;
		const destination = join(currentBase, alias.newRelative);
		for (const root of roots) {
			const sourcePath = join(root, alias.oldRelative);
			if (sourcePath === destination || visited.has(sourcePath)) continue;
			visited.add(sourcePath);
			await importAliasFile(sourcePath, destination, alias.kind, report, options.now, maxFileBytes);
		}
	}
	// After the filenames are reconciled, repair the persona segment embedded in the backlog records
	// themselves — nothing else rewrites it, so the view would stay empty for the rest of time.
	if (rawPersona !== null && oldPersona !== persona) {
		await reconcileBacklogPersona(join(currentBase, "backlog", `${project}.json`), oldPersona, persona, report, options.now);
	}
	return report;
}

/**
 * Import supported files from `<agentDir>/pi-persona-mind` into the current
 * `<agentDir>/persona-mind` root. It is safe to call repeatedly and from
 * concurrent processes. The legacy root is never written.
 */
export async function migrateLegacyRoot(agentDir: string, options: LegacyMigrationOptions = {}): Promise<MigrationReport> {
	const report = emptyReport();
	const legacyRoot = options.legacyRoot ?? join(agentDir, "pi-persona-mind");
	const destinationRoot = options.destinationRoot ?? join(agentDir, "persona-mind");
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const manifest = new JsonStore<LegacySourceStamp>(
		join(destinationRoot, LEGACY_MANIFEST_FILE),
		makeStoreOptions(validateLegacySourceStamp, options.now, report),
	);
	const known = new Map((await manifest.load()).entries.map((entry) => [entry.id, entry]));
	const processed: LegacySourceStamp[] = [];
	let recognized = 0;

	directories:
	for (const directory of IMPORT_DIRECTORIES) {
		const sourceDirectory = join(legacyRoot, directory.relative);
		let handle: Awaited<ReturnType<typeof opendir>> | undefined;
		try {
			handle = await opendir(sourceDirectory);
			for await (const file of handle) {
				if (!file.isFile() || !file.name.toLowerCase().endsWith(".json")) continue;
				if (recognized >= maxFiles) {
					warning(report, `legacy mind: stopped after the ${maxFiles}-file migration limit`);
					break directories;
				}
				recognized++;
				const relativeFile = join(directory.relative, file.name);
				const source = join(legacyRoot, relativeFile);
				const destination = join(destinationRoot, relativeFile);
				try {
					const stamp = await sourceStamp(source, destination, directory.kind);
					const previous = stamp ? known.get(stamp.id) : undefined;
					if (stamp && previous && sameStamp(stamp, previous) && (await regularFileExists(destination))) {
						report.filesSkipped++;
						continue;
					}
					report.filesScanned++;
					if (await importFile(source, destination, directory.kind, report, options.now, maxFileBytes)) {
						const committedStamp = stamp ?? (await sourceStamp(source, destination, directory.kind));
						if (committedStamp) processed.push(committedStamp);
					}
				} catch (err) {
					// One destination's failure (a version skew, a lock timeout under two concurrent Pi
					// starts, an EPERM on the Windows rename) belongs to THIS source. Letting it reach the
					// directory catch aborts the iteration, and readdir order is stable — every later file
					// would be stranded, unnamed, on every subsequent start.
					warning(report, `legacy mind: could not import ${source}: ${String(err)}`);
				}
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") warning(report, `legacy mind: could not scan ${sourceDirectory}: ${String(err)}`);
		} finally {
			await handle?.close().catch(() => {});
		}
	}
	if (processed.length > 0) {
		try {
			await manifest.update((entries) => {
				const next = new Map(entries.map((entry) => [entry.id, entry]));
				for (const entry of processed) next.set(entry.id, entry);
				return [...next.values()].sort((a, b) => a.source.localeCompare(b.source));
			});
		} catch (err) {
			warning(report, `legacy mind: imported data but could not update the source manifest: ${String(err)}`);
		}
	}
	return report;
}
