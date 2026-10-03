/**
 * pi-persona-mind — a durable, persona-aware mind for Pi supervisors.
 *
 * Wires the two agent-facing tools (memory, backlog), injects the deterministic <persona-mind>
 * block into the system prompt every turn (so memory survives compaction + restart), re-arms
 * durable backlog wake timers on session start AND surfaces any that came due while offline as a
 * collapsed, display-only transcript card (never a follow-up that starts a turn), and
 * offers `/mind` (snapshot, doctor, workspace reset). All heavy lifting lives in the pure core; this factory is thin.
 * The only coupling to pi-persona is a best-effort read of its live CLI selector / active-persona
 * marker (see core/scope.ts); absent both, everything runs under a `_default` scope.
 */

import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { detectBlockedLeg } from "./core/blocked.ts";
import { captureMode, detectCaptureCues, type CaptureCue } from "./core/capture.ts";
import { EMPTY_HINT_PREFIX } from "./core/inject.ts";
import { compactMemoryText } from "./core/memory.ts";
import { inspectStoreFile, migrateCurrentScopeAliases, migrateLegacyRoot, type MigrationReport, type StoreDiagnostic } from "./core/migrate.ts";
import { personaFromCliArgs, preferredAgentDir, rawActivePersona, resetPersonaMarkerLatch, resolveScope } from "./core/scope.ts";
import { MindService } from "./core/service.ts";
import { registerBacklogTool } from "./tools/backlog.ts";
import { registerMemoryTool } from "./tools/memory.ts";
import { renderExpandableCard } from "./ui/presentation.ts";

const STATUS_KEY = "pi-persona-mind";
/** Display-only transcript card for a due backlog wake. Never sent to the model; never starts a turn. */
const WAKE_ENTRY_TYPE = "pi-persona-mind-wake";
/** A stalled read must never freeze a turn: injection degrades to nothing past this deadline. */
const INJECT_DEADLINE_MS = 750;
const MIGRATION_AWAIT_MS = 100;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MAX_WAKE_REMINDERS = 20;
const MAX_WAKE_TEXT_CHARS = 200;
const MAX_WAKE_OWNER_BYTES = 1024;
const MIN_PI_VERSION = [1, 0, 0] as const;
type WakeState = Awaited<ReturnType<MindService["backlogList"]>>;
// Unique per extension instance (not just per process): two instances in one process must not both
// believe they own the wake lock. Date/random are fine in the real runtime (unlike workflow scripts).
let ownerInstanceSeq = 0;

/** Pure semver floor check, kept local so the extension can fail closed before using newer Pi APIs. */
export function isSupportedPiVersion(version: string): boolean {
	const parsed = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
	if (!parsed) return false;
	const parts = parsed.slice(1, 4).map((part) => Number(part));
	if (parts.some((part) => !Number.isSafeInteger(part))) return false;
	const [major, minor, patch] = parts as [number, number, number];
	if (major !== MIN_PI_VERSION[0]) return major > MIN_PI_VERSION[0];
	if (minor !== MIN_PI_VERSION[1]) return minor > MIN_PI_VERSION[1];
	if (patch !== MIN_PI_VERSION[2]) return patch > MIN_PI_VERSION[2];
	return parsed[4] === undefined;
}

export interface ExtensionOptions {
	/** Override the agent dir (tests). Defaults to Pi's getAgentDir(). */
	agentDir?: string;
	/** Maximum time lifecycle hooks wait for migration; the migration continues in the background. */
	migrationAwaitMs?: number;
	/** Injectable timer ceiling for testing long wake delays. */
	wakeTimerMaxDelayMs?: number;
	/** Narrow lifecycle seam for deterministic wake read/race tests. */
	wakeStateReader?: (mind: MindService) => Promise<WakeState>;
	/** Raw Pi CLI args seam. Defaults to process.argv.slice(2); used for the one-shot --persona selector. */
	cliArgs?: readonly string[];
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

type WakeOwnerRead =
	| { status: "ok"; token: string }
	| { status: "missing" | "unreadable" | "nonregular" | "oversized" };

/** Read only a tiny, regular wake-owner file; owner locks are coordination metadata, not a data file. */
function readWakeOwner(path: string): WakeOwnerRead {
	let fd: number | undefined;
	try {
		const linkStat = lstatSync(path);
		if (linkStat.isSymbolicLink() || !linkStat.isFile()) return { status: "nonregular" };
		fd = openSync(path, "r");
		if (!fstatSync(fd).isFile()) return { status: "nonregular" };
		const bytes = Buffer.allocUnsafe(MAX_WAKE_OWNER_BYTES + 1);
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		if (length > MAX_WAKE_OWNER_BYTES) return { status: "oversized" };
		return { status: "ok", token: bytes.subarray(0, length).toString("utf8") };
	} catch (err) {
		return { status: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* raced close */
			}
		}
	}
}

export function ownerIsStale(path: string, token: string): boolean {
	const owner = readWakeOwner(path);
	if (owner.status === "missing") return true;
	if (owner.status !== "ok") return false;
	try {
		const content = owner.token;
		if (content === token) return false; // ours
		const colon = content.indexOf(":");
		const host = colon < 0 ? "" : content.slice(0, colon);
		const pid = colon < 0 ? NaN : Number.parseInt(content.slice(colon + 1), 10);
		if (host === hostname() && Number.isInteger(pid) && pid > 0) {
			// A LOCAL owner: stale iff its process is gone. Never time-steal a LIVE local owner — that is
			// the >120s double-fire (a second session opened later in the same project would steal the
			// still-alive owner's lock and both would then fire the same backlog wakes).
			return !isAlive(pid);
		}
		// Foreign host / unparseable token cannot be proven dead. Fail closed: time-stealing a live
		// foreign owner can make two sessions deliver the same wake. Manual cleanup is safer.
		return false;
	} catch {
		return false;
	}
}

/** Non-blocking claim of the per-project wake-firer lock. Only the owner arms/fires wakes. */
function claimWakeOwner(path: string, token: string): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		let fd: number | undefined;
		let created = false;
		let createError: unknown;
		try {
			fd = openSync(path, "wx");
			created = true;
			writeSync(fd, token);
		} catch (err) {
			createError = err;
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					/* best effort; the create error remains authoritative */
				}
			}
		}
		if (created && createError !== undefined) {
			// A failed write can strand an empty file. Remove it only while it is still empty; a
			// non-empty replacement may belong to a racing claimant and must be left untouched.
			const current = readWakeOwner(path);
			if (current.status === "ok" && current.token === "") {
				try {
					unlinkSync(path);
				} catch {
					/* raced */
				}
			}
			return false;
		}
		if (created) {
			// Confirm our token actually stuck: a racing stealer's unlink+recreate could have replaced
			// it between our create and now. If the lock isn't ours, we do NOT own the wakes — retry.
			const current = readWakeOwner(path);
			if (current.status === "ok" && current.token === token) return true;
			continue;
		}
		if ((createError as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") return false;
		const current = readWakeOwner(path);
		if (current.status === "ok" && current.token === token) return true; // re-claim ours
		if (!ownerIsStale(path, token)) return false; // a live holder owns it
		try {
			unlinkSync(path);
		} catch {
			/* raced */
		}
	}
	return false;
}

/** Explain an owner lock that cannot be safely claimed; live local owners remain quiet by design. */
function wakeOwnerWarning(path: string, token: string): string | undefined {
	const owner = readWakeOwner(path);
	if (owner.status === "missing") return undefined;
	if (owner.status === "oversized") return "wake owner lock is oversized; wakes are suppressed until it is removed (see /mind doctor)";
	if (owner.status !== "ok") return "wake owner lock is unreadable or non-regular; wakes are suppressed until it is removed (see /mind doctor)";
	const content = owner.token;
	if (!content) {
		return "wake owner lock is malformed; wakes are suppressed until it is removed (see /mind doctor)";
	}
	if (content === token) return undefined;
	const fields = content.split(":");
	const pid = fields.length === 3 ? Number.parseInt(fields[1] ?? "", 10) : NaN;
	if (fields.length !== 3 || !fields[0] || !Number.isInteger(pid) || pid <= 0 || !fields[2]) {
		return "wake owner lock is malformed; wakes are suppressed until it is removed (see /mind doctor)";
	}
	if (fields[0] !== hostname()) {
		const safeHost = fields[0].replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "unknown";
		return `wake owner lock belongs to foreign host '${safeHost}'; wakes are suppressed until it is removed (see /mind doctor)`;
	}
	return undefined;
}

function withDeadline<T>(p: Promise<T>, ms: number, fallback: T, onTimeout?: () => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			onTimeout?.();
			resolve(fallback);
		}, ms);
		timer.unref?.();
		void p.then(
			(value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			(err: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/** Build the extension. Exported (separately from the default factory) so tests can inject agentDir. */
export function createExtension(pi: ExtensionAPI, opts: ExtensionOptions = {}): void {
	// Do not touch the host API when loaded by a Pi release below the supported contract floor.
	if (!isSupportedPiVersion(VERSION)) throw new Error(`pi-persona-mind requires Pi 1.0.0+ (found ${VERSION}).`);
	// Mirror pi-persona's own PI_AGENT_DIR precedence so both extensions co-locate their data (and the
	// mind never reads a stale/missing marker under the wrong root). getAgentDir() stays lazy — only
	// called when neither an explicit override (tests) nor PI_AGENT_DIR is set.
	const agentDir = preferredAgentDir(opts.agentDir) ?? getAgentDir();
	const nudgeEnabled = process.env.PI_PERSONA_MIND_NUDGE !== "off";
	const capturePolicy = captureMode();
	// pi-persona's one-shot `--persona` selector deliberately does not update its persisted marker.
	// Pi scopes getFlag() to the extension that registered a flag and rejects duplicate declarations,
	// so a companion extension must mirror this CLI-only selector from argv. Persona names stay opaque.
	const liveCliPersona = (): string | undefined => personaFromCliArgs(opts.cliArgs ?? process.argv.slice(2));
	const resolveMindScope = (ctx: ExtensionContext) => {
		const cliPersona = liveCliPersona();
		return cliPersona === undefined ? resolveScope(agentDir, ctx.cwd) : resolveScope(agentDir, ctx.cwd, { cliPersona });
	};
	const rawMindPersona = (): string | null => rawActivePersona(agentDir, process.env, liveCliPersona());
	const migrationWaitMs = Math.max(0, opts.migrationAwaitMs ?? MIGRATION_AWAIT_MS);
	const wakeTimerMaxDelayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(1, opts.wakeTimerMaxDelayMs ?? MAX_TIMER_DELAY_MS));
	const ownerToken = `${hostname()}:${process.pid}:${++ownerInstanceSeq}`;
	const warnings = new Set<string>();
	let warningStatusActive = false;
	const setStatus = (ctx: ExtensionContext, value: string, color: "warning" | "dim" | "accent" = "dim"): void => {
		try {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme ? ctx.ui.theme.fg(color, value) : value);
		} catch {
			/* cosmetic */
		}
	};
	const surfaceWarning = (ctx: ExtensionContext, message: string): void => {
		if (warnings.has(message)) return;
		warnings.add(message);
		warningStatusActive = true;
		try {
			ctx.ui.notify(`[pi-persona-mind] ${message}`, "warning");
		} catch {
			/* a diagnostic must not break the host */
		}
		setStatus(ctx, "mind warning · /mind doctor", "warning");
	};
	const getMind = (ctx: ExtensionContext): MindService =>
		new MindService(resolveMindScope(ctx), { onWarn: (message) => surfaceWarning(ctx, message) });

	pi.registerEntryRenderer<{ content: string }>(WAKE_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const body = typeof entry.data?.content === "string" ? entry.data.content : "";
		return renderExpandableCard("pi-persona-mind", body, expanded, theme);
	});

	/** Human-visible due reminder: toast + collapsed card. Must never sendUserMessage / triggerTurn. */
	const deliverWake = (ctx: ExtensionContext, body: string): void => {
		const first = body.split("\n", 1)[0] ?? body;
		const toast = first.length > 160 ? `${first.slice(0, 159)}…` : first;
		try {
			ctx.ui.notify(`[pi-persona-mind] ${toast}`, "info");
		} catch {
			/* headless / no UI */
		}
		try {
			pi.appendEntry(WAKE_ENTRY_TYPE, { content: body });
		} catch {
			/* host without transcript entries */
		}
	};
	let rootMigration: Promise<MigrationReport> | undefined;
	let backgroundMigration: Promise<MigrationReport> | undefined;
	let backgroundMigrationKey: string | undefined;
	const aliasMigrations = new Map<string, Promise<MigrationReport>>();
	let migrationNoticeShown = false;
	let migrationGeneration = 0;
	let sessionActive = false;
	let sessionStarting = false;
	let lastArmedMigrationGeneration = 0;

	const mergeReports = (a: MigrationReport, b: MigrationReport): MigrationReport => ({
		filesScanned: a.filesScanned + b.filesScanned,
		filesSkipped: a.filesSkipped + b.filesSkipped,
		filesMigrated: a.filesMigrated + b.filesMigrated,
		entriesSeen: a.entriesSeen + b.entriesSeen,
		entriesAdded: a.entriesAdded + b.entriesAdded,
		conflicts: a.conflicts + b.conflicts,
		invalidEntries: a.invalidEntries + b.invalidEntries,
		warnings: [...a.warnings, ...b.warnings],
	});
	const reportMigration = (ctx: ExtensionContext, report: MigrationReport): void => {
		if (report.warnings.length === 1) surfaceWarning(ctx, report.warnings[0] ?? "legacy memory migration reported a warning");
		else if (report.warnings.length > 1) {
			const shown = report.warnings.slice(0, 4).join(" | ");
			surfaceWarning(ctx, `legacy memory migration reported ${report.warnings.length} warnings: ${shown}${report.warnings.length > 4 ? ` | +${report.warnings.length - 4} more` : ""}`);
		}
		if (report.entriesAdded > 0 && !migrationNoticeShown) {
			migrationNoticeShown = true;
			try {
				ctx.ui.notify(
					`[pi-persona-mind] Imported/reconciled ${report.entriesAdded} stored entr${report.entriesAdded === 1 ? "y" : "ies"} from legacy scope paths; source files were left untouched.`,
					"info",
				);
			} catch {
				/* headless/no UI */
			}
		}
	};
	const runMigration = async (ctx: ExtensionContext, includeAmbiguousPersonaAlias: boolean): Promise<MigrationReport> => {
		const rootReport = await (rootMigration ??= migrateLegacyRoot(agentDir));
		const scope = resolveMindScope(ctx);
		const rawPersona = rawMindPersona();
		const aliasKey = JSON.stringify([rawPersona, scope.projectRoot, includeAmbiguousPersonaAlias]);
		let aliasPromise = aliasMigrations.get(aliasKey);
		if (!aliasPromise) {
			aliasPromise = migrateCurrentScopeAliases(agentDir, rawPersona, scope.projectRoot, { includeAmbiguousPersonaAlias });
			aliasMigrations.set(aliasKey, aliasPromise);
		}
		return mergeReports(rootReport, await aliasPromise);
	};
	const rearmAfterMigration = (ctx: ExtensionContext): void => {
		if (!sessionActive || sessionStarting || migrationGeneration <= lastArmedMigrationGeneration) return;
		const scope = resolveMindScope(ctx);
		if (activeScopeKey !== JSON.stringify([scope.persona, scope.projectRoot])) return;
		void (async () => {
			try {
				await armWakes(ctx);
				lastArmedMigrationGeneration = migrationGeneration;
				await refreshStatus(ctx);
			} catch (err) {
				surfaceWarning(ctx, `could not refresh after memory migration: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
	};
	const startBackgroundMigration = (ctx: ExtensionContext): Promise<MigrationReport> => {
		const scope = resolveMindScope(ctx);
		const key = JSON.stringify([rawMindPersona(), scope.projectRoot]);
		if (backgroundMigration && backgroundMigrationKey === key) return backgroundMigration;
		const task = runMigration(ctx, false);
		backgroundMigration = task;
		backgroundMigrationKey = key;
		void task.then(
			(report) => {
				reportMigration(ctx, report);
				migrationGeneration++;
				rearmAfterMigration(ctx);
			},
			(err: unknown) => {
				backgroundMigration = undefined;
				backgroundMigrationKey = undefined;
				rootMigration = undefined;
				aliasMigrations.clear();
				surfaceWarning(ctx, `legacy memory migration failed; continuing and will retry: ${err instanceof Error ? err.message : String(err)}`);
			},
		).catch((err: unknown) => {
			backgroundMigration = undefined;
			backgroundMigrationKey = undefined;
			surfaceWarning(ctx, `legacy memory migration completion failed; continuing and will retry: ${err instanceof Error ? err.message : String(err)}`);
		});
		return task;
	};
	const ensureLegacyMigrated = async (ctx: ExtensionContext, includeAmbiguousPersonaAlias = false, awaitCompletion = false): Promise<void> => {
		if (isDelegatedLeg) return;
		const task = includeAmbiguousPersonaAlias ? runMigration(ctx, true) : startBackgroundMigration(ctx);
		try {
			if (includeAmbiguousPersonaAlias || awaitCompletion) {
				const report = await task;
				if (includeAmbiguousPersonaAlias || awaitCompletion) reportMigration(ctx, report);
				return;
			}
			await withDeadline(task, migrationWaitMs, undefined, () =>
				surfaceWarning(ctx, `legacy memory migration is still running; continuing this turn and will retry in the background`),
			);
		} catch (err) {
			if (!includeAmbiguousPersonaAlias) {
				backgroundMigration = undefined;
				backgroundMigrationKey = undefined;
			}
			rootMigration = undefined;
			aliasMigrations.clear();
			surfaceWarning(ctx, `legacy memory migration failed; continuing and will retry: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	// A DELEGATED worker leg? pi-persona (≥ 1.5.2) marks its sub-agent sessions with a DEDICATED marker,
	// PI_PERSONA_LEG=1 — the in-process fork-bomb guard sets it transiently around session creation, and
	// the child engine puts it in the spawn env (a child process also carries PI_PERSONA_CHILD=1). We key
	// on those, NOT on PI_PERSONA_DISABLE: that flag is ALSO pi-persona's user-facing kill switch, so a
	// user who disables pi-persona interactively is a supervisor running the mind standalone — not a leg,
	// and it must keep its memory tools. Sampled HERE at factory time (the in-process marker is popped
	// before the turn runs). A worker is not the persona: it inherits only the lean mind (north-star +
	// identity — see buildInjection) and must NOT manage the supervisor's memory or fire its wakes. Absent
	// the markers (the normal supervisor, or a user kill switch), everything runs full — behavior unchanged.
	const isDelegatedLeg = process.env.PI_PERSONA_LEG === "1" || process.env.PI_PERSONA_CHILD === "1";

	// Withhold the write tools from a worker: a leg reading/writing the supervisor persona's LTM/STM/
	// backlog is exactly the bleed we prevent. It still INHERITS the lean block below (read-only, curated).
	if (!isDelegatedLeg) {
		registerMemoryTool(pi, getMind);
		registerBacklogTool(pi, getMind);
	}

	// Backlog wake timers — only the elected owner session arms/fires them, so concurrent sessions
	// never double-deliver. In-memory, unref'd, re-armed from disk on session start; cleared on shutdown.
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	// Undelivered alarms outlive their timeout handles: a concurrent re-arm or slow store read
	// must not turn a deadline that just passed into an ignored, apparently old overdue item.
	const pendingWakeIds = new Set<string>();
	// Keep the exact displayed deadline until a fresh snapshot observes its acknowledgement.
	// An in-flight-only guard would miss a pre-ack snapshot that returns after the write settles.
	const displayedWakeDeadlines = new Map<string, number>();
	let ownerPath: string | undefined;
	let wakeGeneration = 0;
	const readWakeState = opts.wakeStateReader ?? ((mind: MindService): Promise<WakeState> => mind.backlogList({ all: true }));
	const clearTimers = (preservePending = false): void => {
		for (const t of timers.values()) clearTimeout(t);
		timers.clear();
		if (!preservePending) {
			pendingWakeIds.clear();
			displayedWakeDeadlines.clear();
		}
	};
	const releaseWakeOwner = (): void => {
		if (!ownerPath) return;
		try {
			const owner = readWakeOwner(ownerPath);
			if (owner.status === "ok" && owner.token === ownerToken) unlinkSync(ownerPath);
		} catch {
			/* already released */
		}
		ownerPath = undefined;
	};
	const armWakes = async (ctx: ExtensionContext, deliverPastDue = true, newlyQueuedId?: string): Promise<void> => {
		const generation = ++wakeGeneration;
		if (newlyQueuedId) pendingWakeIds.add(newlyQueuedId);
		clearTimers(true);
		const scope = resolveMindScope(ctx);
		if (scope.homeWorkspace) {
			pendingWakeIds.clear();
			displayedWakeDeadlines.clear();
			releaseWakeOwner();
			return;
		}
		const nextOwnerPath = `${scope.paths.backlog}.wakeowner`;
		ownerPath = nextOwnerPath;
		if (!claimWakeOwner(nextOwnerPath, ownerToken)) {
			const warning = wakeOwnerWarning(nextOwnerPath, ownerToken);
			if (warning) surfaceWarning(ctx, warning);
			if (wakeGeneration === generation && ownerPath === nextOwnerPath) ownerPath = undefined; // another live session owns the wakes; we still inject, just don't fire
			return;
		}
		const mind = getMind(ctx);
		let all: Awaited<ReturnType<MindService["backlogList"]>>;
		try {
			all = await readWakeState(mind);
		} catch (err) {
			if (sessionActive && wakeGeneration === generation && ownerPath === nextOwnerPath) {
				surfaceWarning(ctx, `could not load backlog wake state: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (wakeGeneration === generation && ownerPath === nextOwnerPath) releaseWakeOwner();
			return;
		}
		const now = Date.now();
		if (!sessionActive || wakeGeneration !== generation || ownerPath !== nextOwnerPath) {
			if (wakeGeneration === generation && ownerPath === nextOwnerPath) releaseWakeOwner();
			return;
		}
		// Deliver items that came due while offline as ONE combined reminder, instead of dropping them.
		// Display-only: the mind is already injected on the next user turn; a follow-up would start the
		// agent unprompted (it used to treat "Use backlog take" as an order to resume work).
		const activeWakeDeadlines = new Map<string, number>();
		for (const item of all) if (item.dueAtEpochMs !== undefined) activeWakeDeadlines.set(item.id, item.dueAtEpochMs);
		for (const id of pendingWakeIds) if (!activeWakeDeadlines.has(id)) pendingWakeIds.delete(id);
		for (const [id, deadline] of displayedWakeDeadlines) if (activeWakeDeadlines.get(id) !== deadline) displayedWakeDeadlines.delete(id);
		const due = all.filter((item) => item.dueAtEpochMs !== undefined && item.dueAtEpochMs <= now && displayedWakeDeadlines.get(item.id) !== item.dueAtEpochMs && (deliverPastDue || pendingWakeIds.has(item.id)));
		if (due.length > 0) {
			try {
				const shown = due.slice(0, MAX_WAKE_REMINDERS);
				const list = shown.map((e) => `• ${compactMemoryText(e.text, MAX_WAKE_TEXT_CHARS)} (id ${e.id})`).join("\n");
				const omitted = due.length - shown.length;
				const more = omitted > 0 ? `\n… +${omitted} more due item(s); use \`backlog list\` to review them.` : "";
				if (!sessionActive || wakeGeneration !== generation || ownerPath !== nextOwnerPath) return;
				for (const item of due) {
					pendingWakeIds.delete(item.id);
					if (item.dueAtEpochMs !== undefined) displayedWakeDeadlines.set(item.id, item.dueAtEpochMs);
				}
				const headline = deliverPastDue ? `${due.length} backlog item(s) came due while you were away:` : `backlog due — ${due.length} item(s):`;
				deliverWake(
					ctx,
					`${headline}\n${list}${more}\nReview when ready — stale leads auto-remove after ~48h; keep durable facts in long-term memory.`,
				);
				await mind.acknowledgeDue(due.map((item) => item.id));
			} catch {
				/* raced shutdown */
			}
		}
		// Schedule the future ones.
		const scheduleWake = (item: (typeof all)[number], remainingMs: number): void => {
			if (!sessionActive || wakeGeneration !== generation || ownerPath !== nextOwnerPath) return;
			pendingWakeIds.add(item.id);
			const delay = Math.min(Math.max(1, remainingMs), wakeTimerMaxDelayMs);
			const t = setTimeout(() => {
				if (!sessionActive || wakeGeneration !== generation || ownerPath !== nextOwnerPath) return;
				timers.delete(item.id);
				// Re-check at every chunk. This avoids Node's ~24.8-day timer overflow and also notices
				// a completed/dropped item before re-arming the next chunk.
				void (async () => {
					try {
						if (!sessionActive || wakeGeneration !== generation || ownerPath !== nextOwnerPath) return;
						const live = (await mind.backlogList({ all: true })).find((entry) => entry.id === item.id);
						if (!sessionActive || wakeGeneration !== generation || ownerPath !== nextOwnerPath) return;
						if (!live || (live.state !== "open" && live.state !== "taken") || live.dueAtEpochMs === undefined) {
							pendingWakeIds.delete(item.id);
							return;
						}
						if (displayedWakeDeadlines.get(live.id) === live.dueAtEpochMs) {
							pendingWakeIds.delete(live.id);
							return;
						}
						const left = live.dueAtEpochMs - Date.now();
						if (left > 0) {
							scheduleWake(live, left);
							return;
						}
						if (!sessionActive || wakeGeneration !== generation || ownerPath !== nextOwnerPath) return;
						pendingWakeIds.delete(item.id);
						displayedWakeDeadlines.set(live.id, live.dueAtEpochMs);
						deliverWake(
							ctx,
							`backlog due — ${compactMemoryText(live.text, MAX_WAKE_TEXT_CHARS)} (id ${live.id}). Review when ready.`,
						);
						await mind.acknowledgeDue([live.id]);
					} catch (err) {
						if (sessionActive && wakeGeneration === generation && ownerPath === nextOwnerPath) surfaceWarning(ctx, `could not re-check due backlog item ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
					}
				})();
			}, delay);
			t.unref?.();
			timers.set(item.id, t);
		};
		for (const item of all) {
			if ((item.state !== "open" && item.state !== "taken") || item.dueAtEpochMs === undefined) continue;
			const delay = item.dueAtEpochMs - now;
			if (delay <= 0 || timers.has(item.id)) continue;
			scheduleWake(item, delay);
		}
	};
	let activeScopeKey: string | undefined;
	let sessionLifecycleGeneration = 0;
	const reconcileScope = async (ctx: ExtensionContext, lifecycleGeneration = sessionLifecycleGeneration): Promise<void> => {
		if (lifecycleGeneration !== sessionLifecycleGeneration) return;
		const scope = resolveMindScope(ctx);
		const nextKey = JSON.stringify([scope.persona, scope.projectRoot]);
		if (activeScopeKey === undefined) {
			activeScopeKey = nextKey;
			return;
		}
		if (activeScopeKey === nextKey) return;
		clearTimers();
		releaseWakeOwner();
		activeScopeKey = nextKey;
		if (sessionActive && !isDelegatedLeg) {
			await armWakes(ctx);
			if (lifecycleGeneration !== sessionLifecycleGeneration) return;
			lastArmedMigrationGeneration = migrationGeneration;
			await refreshStatus(ctx);
		}
	};

	const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
		try {
			const s = await getMind(ctx).summary();
			if (warningStatusActive) {
				setStatus(ctx, "mind warning · /mind doctor", "warning");
				return;
			}
			const label = `mind ${s.ltm}L·${s.stm}S · backlog ${s.backlogOpen}`;
			setStatus(ctx, label);
		} catch (err) {
			surfaceWarning(ctx, `could not refresh memory status: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	// A delegated leg came back BLOCKED — surface it as a backlog candidate (deterministic, nudge-only,
	// never auto-writes). Reached on BOTH delivery paths: the sync delegate/council tool_result, and the
	// v1.5.0 background-default path where the report arrives as a follow-up user message (before_agent_start).
	const nudgeBlocked = (ctx: ExtensionContext, snippet: string): void => {
		try {
			const hint = `⚠️ a delegated leg reported ${snippet} — \`backlog add\` so the thread isn't lost`;
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme ? ctx.ui.theme.fg("accent", hint) : hint);
		} catch {
			/* cosmetic */
		}
	};
	const isDelegatedReport = (prompt: string): boolean => /^(?:\[pi-persona\]\s+)?\d+\s+async runs? settled\b/i.test(prompt.trim());

	interface CaptureNotice {
		hint: string;
	}
	let pendingCaptureNotice: CaptureNotice | undefined;
	let pendingInputProvenance: { source: "interactive" | "rpc" | "extension" } | undefined;
	let latestDirectInputPrompt: string | undefined;
	let captureInputGeneration = 0;
	const directInputPrompts = new Set<string>();
	const rememberDirectInputPrompt = (prompt: string): void => {
		directInputPrompts.delete(prompt);
		directInputPrompts.add(prompt);
		while (directInputPrompts.size > 128) {
			const oldest = directInputPrompts.values().next().value as string | undefined;
			if (oldest === undefined) break;
			directInputPrompts.delete(oldest);
		}
	};
	// Cue snippets already surfaced in the prompt this session: at most once per direct statement.
	const cueHinted = new Set<string>();
	const nestedBlockedRelays = new Set<string>();
	const rememberCueHint = (snippet: string): void => {
		cueHinted.delete(snippet);
		cueHinted.add(snippet);
		while (cueHinted.size > 128) {
			const oldest = cueHinted.values().next().value as string | undefined;
			if (oldest === undefined) break;
			cueHinted.delete(oldest);
		}
	};
	// The empty-mind discoverability line is an ANNOUNCEMENT — shown once per session, not a banner that
	// persists every turn while the mind stays empty (that would be the nag we avoid).
	let emptyAnnounced = false;
	const resetSessionTransientState = (): number => {
		sessionLifecycleGeneration++;
		captureInputGeneration++;
		pendingCaptureNotice = undefined;
		pendingInputProvenance = undefined;
		latestDirectInputPrompt = undefined;
		directInputPrompts.clear();
		cueHinted.clear();
		nestedBlockedRelays.clear();
		emptyAnnounced = false;
		return sessionLifecycleGeneration;
	};
	const rememberNestedBlockedRelay = (toolCallId: string): void => {
		nestedBlockedRelays.delete(toolCallId);
		nestedBlockedRelays.add(toolCallId);
		while (nestedBlockedRelays.size > 256) {
			const oldest = nestedBlockedRelays.values().next().value as string | undefined;
			if (oldest === undefined) break;
			nestedBlockedRelays.delete(oldest);
		}
	};
	const captureDirectCues = async (
		text: string,
		ctx: ExtensionContext,
		lifecycleGeneration: number,
		inputGeneration: number,
	): Promise<CaptureNotice | undefined> => {
		const cues = detectCaptureCues(text);
		if (cues.length === 0) return undefined;
		const explicit = capturePolicy === "auto" ? cues.filter((cue) => cue.strong) : [];
		const mind = explicit.length > 0 ? getMind(ctx) : undefined;
		const isCurrent = (): boolean => lifecycleGeneration === sessionLifecycleGeneration && inputGeneration === captureInputGeneration;
		if (explicit.length > 0) {
			await ensureLegacyMigrated(ctx);
			if (isCurrent()) await reconcileScope(ctx, lifecycleGeneration);
		}
		const stored: string[] = [];
		const failures: string[] = [];
		if (mind) {
			for (const cue of explicit) {
				const label = cue.kind === "preference" ? "User preference" : cue.kind === "rationale" ? "Durable user decision" : "User explicitly asked to retain";
				const result = await mind.remember({
					term: cue.term,
					kind: cue.kind,
					text: `${label}: ${cue.candidate}`,
					tags: ["auto-captured"],
					source: "direct user persistence cue",
				});
				if (result.ok) stored.push(result.entry.id);
				else failures.push(result.reason);
			}
		}
		// Durable writes from the accepted user input are preserved across a session change, but its
		// acknowledgement and prompt/UI state belong only to the session/input that accepted it.
		if (!isCurrent()) return undefined;
		for (const cue of explicit) rememberCueHint(cue.snippet);

		let hint = "";
		if (stored.length > 0) {
			hint = `⟢ pi-persona-mind — already captured ${stored.length} explicit user memor${stored.length === 1 ? "y" : "ies"} (${stored.join(", ")}); do not duplicate ${stored.length === 1 ? "it" : "them"}.`;
			try {
				ctx.ui.notify(`[pi-persona-mind] Captured ${stored.length} explicit memor${stored.length === 1 ? "y" : "ies"}.`, "info");
			} catch {
				/* headless/no UI */
			}
			await refreshStatus(ctx);
		}
		if (failures.length > 0) {
			const reason = failures[0] ?? "unknown storage failure";
			const retryHint = `⚠ pi-persona-mind could not auto-capture one explicit user memory: ${reason}. Before final, retry once with a safe declarative \`memory remember\` entry.`;
			hint = [hint, retryHint].filter(Boolean).join("\n\n");
			surfaceWarning(ctx, `automatic capture failed: ${reason}`);
		}
		if (!hint && nudgeEnabled) {
			const cue = cues[0];
			if (cue) {
				rememberCueHint(cue.snippet);
				hint = `⟢ pi-persona-mind — possible durable ${cue.kind} detected in direct user input. Save one safe declarative memory only if it should outlive this task.`;
				try {
					ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme ? ctx.ui.theme.fg("accent", `💡 worth remembering? memory remember (${cue.kind})`) : `💡 worth remembering? (${cue.kind})`);
				} catch {
					/* cosmetic */
				}
			}
		}
		return hint ? { hint } : undefined;
	};

	// Capture only INPUT owned by the user. Extension-authored follow-ups and delegated reports are
	// foreign data; before_agent_start cannot distinguish them, but the input event can. Direct,
	// explicit persist-intent is safe to commit deterministically before the model runs. Everything
	// softer remains a model-visible candidate governed by the standing tool guideline.
	pi.on("input", async (event, ctx) => {
		const lifecycleGeneration = sessionLifecycleGeneration;
		const inputGeneration = ++captureInputGeneration;
		pendingInputProvenance = { source: event.source };
		pendingCaptureNotice = undefined;
		if (event.source === "extension") {
			return;
		}
		if (isDelegatedLeg || capturePolicy === "off") {
			return;
		}
		latestDirectInputPrompt = event.text;
		rememberDirectInputPrompt(event.text);
		const notice = await captureDirectCues(event.text, ctx, lifecycleGeneration, inputGeneration);
		if (lifecycleGeneration === sessionLifecycleGeneration && inputGeneration === captureInputGeneration && latestDirectInputPrompt === event.text) {
			pendingCaptureNotice = notice;
		}
	});

	const customMessageText = (content: unknown): string => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
			.filter(Boolean)
			.join("\n");
	};

	// pi-persona's custom follow-ups call Pi's sendMessage(), which bypasses BOTH the input and
	// before_agent_start hooks. Observe their attributed message type directly: a deferred input is
	// still the user's own text and may be auto-captured; async child/exocom reports remain foreign.
	pi.on("message_start", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "custom") return;
		const lifecycleGeneration = sessionLifecycleGeneration;
		const inputGeneration = ++captureInputGeneration;
		pendingInputProvenance = { source: "extension" };
		pendingCaptureNotice = undefined;
		const text = customMessageText(message.content);
		if (!text) return;
		if (message.customType === "pi-persona") {
			const blocked = nudgeEnabled && isDelegatedReport(text) ? detectBlockedLeg(text) : undefined;
			if (blocked) nudgeBlocked(ctx, blocked.snippet);
			return;
		}
		if (message.customType === "pi-persona-deferred-input") {
			if (isDelegatedLeg || capturePolicy === "off") return;
			pendingInputProvenance = { source: "interactive" };
			latestDirectInputPrompt = text;
			rememberDirectInputPrompt(text);
			const notice = await captureDirectCues(text, ctx, lifecycleGeneration, inputGeneration);
			if (lifecycleGeneration === sessionLifecycleGeneration && inputGeneration === captureInputGeneration && latestDirectInputPrompt === text) {
				pendingCaptureNotice = notice;
			}
			return;
		}
		pendingInputProvenance = { source: "extension" };
		pendingCaptureNotice = undefined;
	});

	// Inject the mind into every turn. before_agent_start re-fires after compaction, so this is also
	// how memory survives compaction: it re-injects from disk. Fail-open: a stalled read (slow disk,
	// lock contention) degrades to no injection rather than hanging the turn.
	pi.on("before_agent_start", async (event, ctx) => {
		const lifecycleGeneration = sessionLifecycleGeneration;
		await ensureLegacyMigrated(ctx);
		if (lifecycleGeneration !== sessionLifecycleGeneration) return;
		await reconcileScope(ctx, lifecycleGeneration);
		if (lifecycleGeneration !== sessionLifecycleGeneration) return;
		const provenance = pendingInputProvenance?.source;
		pendingInputProvenance = undefined;
		let cueHint = "";
		if (!isDelegatedLeg) {
			// A delegated leg that came back BLOCKED arrives HERE on the v1.5.0 async/background-default
			// path: pi-persona delivers the completion report as a fresh follow-up user message, so it
			// shows up as event.prompt (not a delegate tool_result). A blocked leg is deferred intent —
			// nudge a backlog capture so the thread isn't lost. This takes precedence over the capture cue.
			const blocked = nudgeEnabled && provenance === "extension" && isDelegatedReport(event.prompt) ? detectBlockedLeg(event.prompt) : undefined;
			if (blocked) {
				nudgeBlocked(ctx, blocked.snippet);
			} else if (capturePolicy !== "off") {
				const notice = pendingCaptureNotice;
				pendingCaptureNotice = undefined;
				const promptBelongsToAnOlderDirectInput = directInputPrompts.has(event.prompt) && event.prompt !== latestDirectInputPrompt;
				if (notice && (provenance === "interactive" || provenance === "rpc") && !promptBelongsToAnOlderDirectInput) {
					cueHint = notice.hint;
				} else if (nudgeEnabled && provenance !== "extension") {
					// Compatibility fallback for host paths that do not emit `input`: nudge only. Never auto-write
					// here because an extension-authored follow-up is indistinguishable from direct user input.
					const cue: CaptureCue | undefined = detectCaptureCues(event.prompt)[0];
					if (cue && !cueHinted.has(cue.snippet)) {
						rememberCueHint(cue.snippet);
						try {
							ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme ? ctx.ui.theme.fg("accent", `💡 worth remembering? memory remember (${cue.kind})`) : `💡 worth remembering? (${cue.kind})`);
						} catch {
							/* cosmetic */
						}
						if (cue.strong) {
							cueHint = "⟢ pi-persona-mind — an explicit persistence cue was detected, but its input provenance was unavailable. Save one safe declarative `memory remember` entry before final only if it came directly from the user.";
						}
					}
				}
			}
		}
		let block = "";
		try {
			// A worker inherits the LEAN mind (north-star + identity only); the supervisor gets it all.
			block = await withDeadline(getMind(ctx).buildInjection({ lean: isDelegatedLeg }), INJECT_DEADLINE_MS, "", () => {
				if (lifecycleGeneration === sessionLifecycleGeneration) surfaceWarning(ctx, `memory injection exceeded ${INJECT_DEADLINE_MS}ms and was skipped for this turn`);
			});
		} catch (err) {
			if (lifecycleGeneration === sessionLifecycleGeneration) surfaceWarning(ctx, `memory injection failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (lifecycleGeneration !== sessionLifecycleGeneration) return;
		// The empty-mind hint announces the faculty ONCE per session, then goes quiet even if the mind
		// stays empty — a state indicator, not a per-turn nag. Matched by PREFIX: a content block starts
		// with `<persona-mind …` and a memory's text sits inside the fence, so this only ever recognises
		// the announcement itself — never a real memory that happens to quote the phrase.
		if (block.startsWith(EMPTY_HINT_PREFIX)) {
			if (emptyAnnounced) block = "";
			else emptyAnnounced = true;
		}
		const injected = [block, cueHint].filter(Boolean).join("\n\n");
		if (injected) return { systemPrompt: `${event.systemPrompt}\n\n${injected}` };
		return;
	});

	// The SYNC delegation path: a `delegate`/`council` tool_result whose report carries a BLOCKED/UNKNOWN
	// marker (the async/background default lands in before_agent_start above). No result mutation — just a
	// status-line nudge — so it composes cleanly alongside pi-persona's own tool_result hook.
	const REPORT_TOOLS = new Set(["delegate", "council"]);
	pi.on("tool_result", async (event, ctx) => {
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
		const relaysNestedBlocked = toolCallId ? nestedBlockedRelays.delete(toolCallId) : false;
		if (isDelegatedLeg) return undefined;
		if (event.toolName === "memory" || event.toolName === "backlog") {
			const details = event.details && typeof event.details === "object" ? (event.details as Record<string, unknown>) : undefined;
			if (details?.ok === false) return { isError: true };
			if (details?.ok === true) {
				await refreshStatus(ctx);
				// A due item added during a running session must be armed now, not only after the next
				// restart. Re-arm on every successful backlog mutation so take/done/drop also cancel
				// stale timers. Existing overdue items are not re-announced by this maintenance pass.
				if (event.toolName === "backlog" && sessionActive) {
					const newlyQueuedId = event.input?.action === "add" && typeof details.id === "string" ? details.id : undefined;
					await armWakes(ctx, false, newlyQueuedId);
				}
			}
			return undefined;
		}
		if (!nudgeEnabled) return undefined;
		const text = event.content.reduce((s, c) => (c.type === "text" ? s + c.text : s), "");
		const blocked = detectBlockedLeg(text);
		const parentToolCallId = typeof event.parentToolCallId === "string" && event.parentToolCallId.length > 0 ? event.parentToolCallId : undefined;
		if (parentToolCallId) {
			if (blocked && (REPORT_TOOLS.has(event.toolName) || relaysNestedBlocked)) rememberNestedBlockedRelay(parentToolCallId);
			return undefined;
		}
		if (blocked && (REPORT_TOOLS.has(event.toolName) || relaysNestedBlocked)) nudgeBlocked(ctx, blocked.snippet);
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		const lifecycleGeneration = resetSessionTransientState();
		// A reused Pi process must not inherit the previous session's persona-switch latch.
		resetPersonaMarkerLatch();
		// A worker never arms/fires the supervisor's backlog wakes (nor shows a status line).
		if (isDelegatedLeg) return;
		sessionActive = true;
		sessionStarting = true;
		try {
			await ensureLegacyMigrated(ctx);
			if (lifecycleGeneration !== sessionLifecycleGeneration) return;
			await reconcileScope(ctx, lifecycleGeneration);
			if (lifecycleGeneration !== sessionLifecycleGeneration) return;
			await armWakes(ctx);
			if (lifecycleGeneration !== sessionLifecycleGeneration) return;
			lastArmedMigrationGeneration = migrationGeneration;
			try {
				await getMind(ctx).sweepExpired();
			} catch {
				/* expired STM/backlog must not block session start */
			}
			if (lifecycleGeneration !== sessionLifecycleGeneration) return;
			await refreshStatus(ctx);
		} finally {
			if (lifecycleGeneration === sessionLifecycleGeneration) {
				sessionStarting = false;
				rearmAfterMigration(ctx);
			}
		}
	});

	pi.on("session_shutdown", () => {
		resetSessionTransientState();
		sessionActive = false;
		sessionStarting = false;
		resetPersonaMarkerLatch();
		wakeGeneration++;
		clearTimers();
		releaseWakeOwner();
	});

	// Human view of what is currently in the mind (and injected each turn), plus workspace reset.
	pi.registerCommand("mind", {
		description: "Show this persona's mind. /mind doctor for diagnostics. /mind reset clears this project's working memory and backlog.",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			const [verb, qualifier] = command.split(/\s+/);
			if (command && verb !== "doctor" && verb !== "reset" && command !== "migrate-persona") {
				ctx.ui.notify("usage: /mind | /mind doctor | /mind reset | /mind migrate-persona", "warning");
				return;
			}
			if (command === "migrate-persona") {
				const rawPersona = rawMindPersona();
				await ensureLegacyMigrated(ctx, true, true);
				surfaceWarning(
					ctx,
					rawPersona === null
						? "AMBIGUOUS persona migration requested, but no active persona is selected; only project aliases were reconciled."
						: `AMBIGUOUS persona migration imported the historical alias for '${rawPersona}'. Review the result; source files were left untouched.`,
				);
				return;
			}
			await ensureLegacyMigrated(ctx, false, command === "doctor");
			const scope = resolveMindScope(ctx);
			if (command === "doctor") {
				const diagnostics: Array<[string, StoreDiagnostic]> = await Promise.all([
					inspectStoreFile(scope.paths.ltm, "ltm").then((d): [string, StoreDiagnostic] => ["long-term", d]),
					inspectStoreFile(scope.paths.shared, "ltm").then((d): [string, StoreDiagnostic] => ["shared", d]),
					inspectStoreFile(scope.paths.stm, "stm").then((d): [string, StoreDiagnostic] => ["short-term", d]),
					inspectStoreFile(scope.paths.backlog, "backlog").then((d): [string, StoreDiagnostic] => ["backlog", d]),
				]);
				const pathLine = ([label, diagnostic]: [string, StoreDiagnostic]): string => {
					const suffix = diagnostic.status === "missing" ? "not created" : diagnostic.status === "ok" ? `ok (${diagnostic.validEntries} entries)` : `${diagnostic.status} (${diagnostic.message ?? `${diagnostic.invalidEntries} invalid entries`})`;
					return `${label}: ${diagnostic.path} (${suffix})`;
				};
				const diagnosticWarnings = diagnostics.filter(([, diagnostic]) => diagnostic.status !== "missing" && diagnostic.status !== "ok").map(([label, diagnostic]) => `${label}: ${diagnostic.status} — ${diagnostic.message ?? "invalid store"}`);
				const allWarnings = [...warnings, ...diagnosticWarnings];
				const lines = [
					"pi-persona-mind doctor",
					`persona: ${scope.persona}`,
					`cwd: ${ctx.cwd}`,
					`project root: ${scope.projectRoot}${scope.homeWorkspace ? " (home — STM/backlog not injected, wakes off)" : ""}`,
					`project slug: ${scope.slug}`,
					`capture: ${capturePolicy} (PI_PERSONA_MIND_CAPTURE)`,
					pathLine(diagnostics[0]!),
					pathLine(diagnostics[1]!),
					pathLine(diagnostics[2]!),
					pathLine(diagnostics[3]!),
					`legacy root: ${join(agentDir, "pi-persona-mind")} (${existsSync(join(agentDir, "pi-persona-mind")) ? "detected; imported non-destructively" : "absent"})`,
					`warnings: ${allWarnings.length === 0 ? "none" : allWarnings.join(" | ")}`,
				];
				warnings.clear();
				warningStatusActive = false;
				setStatus(ctx, allWarnings.length === 0 ? "mind doctor · healthy" : `mind doctor · ${allWarnings.length} warning(s) acknowledged`, allWarnings.length === 0 ? "dim" : "warning");
				ctx.ui.notify(lines.join("\n"), allWarnings.length === 0 ? "info" : "warning");
				return;
			}
			if (verb === "reset") {
				if (isDelegatedLeg) {
					ctx.ui.notify("a delegated worker cannot reset the supervisor's workspace mind", "warning");
					return;
				}
				if (qualifier && qualifier !== "workspace") {
					ctx.ui.notify(
						"/mind reset clears THIS PROJECT's short-term memory and backlog only. Long-term persona identity is not workspace-scoped — forget individual facts with `memory forget <id>`.",
						"warning",
					);
					return;
				}
				const mind = getMind(ctx);
				const result = await mind.resetWorkspace();
				if (!result.ok) {
					ctx.ui.notify(`mind reset failed: ${result.reason}`, "error");
					return;
				}
				if (sessionActive) {
					await armWakes(ctx, false);
					await refreshStatus(ctx);
				}
				ctx.ui.notify(
					`Cleared this workspace (${scope.projectRoot}): ${result.stmRemoved} short-term · ${result.backlogRemoved} backlog. Long-term identity (${result.ltmKept}) left intact.`,
					"info",
				);
				return;
			}
			const mind = getMind(ctx);
			const [summary, block] = await Promise.all([mind.summary(), mind.buildInjection()]);
			const header = `pi-persona-mind (${scope.persona}) — ${summary.ltm} long-term · ${summary.stm} short-term · ${summary.backlogOpen} open backlog`;
			ctx.ui.notify(block ? `${header}\n\n${block}` : `${header}\n\n(empty)`, "info");
		},
	});
}

export default function piPersonaMind(pi: ExtensionAPI): void {
	createExtension(pi);
}
