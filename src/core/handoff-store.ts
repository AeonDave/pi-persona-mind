import { randomBytes } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { canonicalProjectIdentity, type Scope } from "./scope.ts";
import { BoundedReadFailure, JsonStore, StoreCapacityError, StoreConflictError, StoreVersionError } from "./store.ts";
import { MAX_HANDOFF_ENTRIES, MAX_HANDOFF_GOAL_PREVIEW_CHARS, MAX_HANDOFF_RECORD_BYTES, MAX_HANDOFF_STORE_BYTES, validContext, validHandoffContent, validateHandoff, validResolution, type HandoffContext, type HandoffEntry, type HandoffInput } from "./handoff.ts";

export type HandoffResult =
	| { ok: false; reason: string }
	| { ok: true; operation: "save" | "read" | "complete"; entry: HandoffEntry }
	| { ok: true; operation: "list"; total: number; entries: (Pick<HandoffEntry, "id" | "revision" | "goal" | "status" | "createdAt" | "updatedAt"> & { goalTruncated: boolean })[] }
	| { ok: true; operation: "forget" };

export class HandoffStore {
	private readonly store: JsonStore<HandoffEntry>;
	constructor(privateScope: Scope) {
		this.scope = privateScope;
		// The byte cap bounds the shared file; entry quotas belong to each owner.
		this.store = new JsonStore(`${privateScope.paths.stm}.handoffs.json`, { version: 1, validateEntry: validateHandoff, maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: MAX_HANDOFF_STORE_BYTES });
	}
	private readonly scope: Scope;

	async execute(context: HandoffContext, input: HandoffInput): Promise<HandoffResult> {
		try {
			if (this.scope.homeWorkspace || !validContext(context) || context.isCurrent?.() === false || context.persona !== this.scope.persona || canonicalProjectIdentity(context.projectRoot) !== canonicalProjectIdentity(this.scope.projectRoot)) return { ok: false, reason: "handoff owner or project unavailable" };
			const cwdRelative = relative(canonicalProjectIdentity(context.projectRoot), canonicalProjectIdentity(context.cwd));
			if (cwdRelative === ".." || cwdRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(cwdRelative)) return { ok: false, reason: "handoff cwd outside project" };
			if (input.operation === "save" && !validHandoffContent(input)) return { ok: false, reason: "invalid or unsafe handoff content" };
			if (input.operation === "complete" && !validResolution(input.resolution)) return { ok: false, reason: "resolution must be nonempty and safe" };
			for (let attempt = 0; attempt < 10; attempt++) {
				const snapshot = await this.store.inspectStrict();
				if (context.isCurrent?.() === false) return { ok: false, reason: "handoff owner changed" };
				if (new Set(snapshot.store.entries.map((e) => e.id)).size !== snapshot.store.entries.length) return { ok: false, reason: "handoff store contains duplicate IDs" };
				const owned = snapshot.store.entries.filter((e) => e.persona === context.persona && canonicalProjectIdentity(e.projectRoot) === canonicalProjectIdentity(context.projectRoot));
				if (input.operation === "list") return { ok: true, operation: "list", total: owned.length, entries: owned.map(({ id, revision, goal, status, createdAt, updatedAt }) => {
					const goalTruncated = goal.length > MAX_HANDOFF_GOAL_PREVIEW_CHARS;
					const preview = goalTruncated ? `${goal.slice(0, MAX_HANDOFF_GOAL_PREVIEW_CHARS - 1).replace(/[\uD800-\uDBFF]$/, "")}…` : goal;
					return { id, revision, goal: preview, goalTruncated, status, createdAt, updatedAt };
				}) };
				if (input.operation === "read") {
					const entry = owned.find((e) => e.id === input.id);
					return entry ? { ok: true, operation: "read", entry } : { ok: false, reason: "handoff not found" };
				}
				let entry: HandoffEntry;
				if (input.operation === "save") {
					// CAS rechecks this snapshot under the lock, so concurrent saves cannot exceed the quota.
					if (owned.length >= MAX_HANDOFF_ENTRIES) return { ok: false, reason: `handoff quota of ${MAX_HANDOFF_ENTRIES} entries reached for this persona in this project; use forget to free space` };
					const now = new Date().toISOString();
					entry = { id: randomBytes(16).toString("hex"), revision: 1, persona: context.persona, projectRoot: canonicalProjectIdentity(context.projectRoot), origin: { sessionId: context.sessionId, branchId: context.branchId, cwd: context.cwd }, createdAt: now, updatedAt: now, status: "open", goal: input.goal, completed: [...input.completed], pending: [...input.pending], nextStep: input.nextStep, references: [...input.references] };
				} else {
					const found = owned.find((e) => e.id === input.id);
					if (!found) return { ok: false, reason: "handoff not found" };
					if (found.revision !== input.revision) return { ok: false, reason: "handoff changed; read it again" };
					if (input.operation === "complete" && found.status !== "open") return { ok: false, reason: "handoff already completed" };
					entry = input.operation === "complete" ? { ...found, status: "completed", revision: found.revision + 1, updatedAt: new Date().toISOString(), resolution: input.resolution } : found;
				}
				if (Buffer.byteLength(JSON.stringify(entry), "utf8") > MAX_HANDOFF_RECORD_BYTES) return { ok: false, reason: `handoff snapshot including metadata exceeds ${MAX_HANDOFF_RECORD_BYTES} bytes; shorten the content or resolution` };
				const normalized = validateHandoff(entry);
				if (!normalized) return { ok: false, reason: "handoff snapshot metadata is invalid" };
				entry = normalized;
				try {
					await this.store.compareAndUpdate(snapshot.fingerprint, (entries) => {
						if (context.isCurrent?.() === false) throw new Error("handoff owner changed");
						return input.operation === "save" ? [...entries, entry] : input.operation === "forget" ? entries.filter((e) => e.id !== entry.id) : entries.map((e) => e.id === entry.id ? entry : e);
					});
					if (context.isCurrent?.() === false) return { ok: false, reason: "handoff owner changed after commit; inspect the original scope" };
					if (input.operation === "forget") return { ok: true, operation: "forget" };
					return { ok: true, operation: input.operation, entry };
				} catch (error) {
					if (error instanceof StoreConflictError) continue;
					if (error instanceof StoreCapacityError && error.kind === "bytes") {
						const otherEntries = snapshot.store.entries.filter((e) => e.persona !== context.persona);
						// Match JsonStore's envelope, indentation and newline: could this operation fit
						// if the caller freed every existing entry they own?
						const afterForgetting = { ...snapshot.store, sequence: snapshot.store.sequence + 1, updatedAt: new Date().toISOString(),
							entries: input.operation === "forget" ? otherEntries : [...otherEntries, entry] };
						const othersBlock = Buffer.byteLength(`${JSON.stringify(afterForgetting, null, 2)}\n`, "utf8") > error.limit;
						const counts = `your entries: ${owned.length}; other personas: ${otherEntries.length} entries`;
						const remedy = owned.length > 0 ? "; use forget to free space" : "";
						return { ok: false, reason: othersBlock
							? `other personas' handoffs fill this project's handoff file ${this.store.filePath} (${counts}); ${error.limit}-byte limit exceeded${remedy}`
							: `handoff file ${this.store.filePath} exceeds ${error.limit} bytes (${counts})${remedy}` };
					}
					throw error;
				}
			}
			return { ok: false, reason: "handoff store busy; retry" };
		} catch (error) {
			const file = `handoff file ${this.store.filePath}`;
			if (error instanceof BoundedReadFailure) {
				return { ok: false, reason: error.kind === "path"
					? `${file} has an unsafe or changing path; repair it as a regular file and retry`
					: `${file} exceeds safe read limits or changed size while being read; repair it within the ${MAX_HANDOFF_STORE_BYTES}-byte limit and retry` };
			}
			if (error instanceof StoreVersionError) {
				return { ok: false, reason: `${file} uses version ${error.found}, but this build reads version ${error.expected}; use a compatible build; the file is left untouched` };
			}
			// JsonStore's two untyped strict-read refusals are covered by real-file regression
			// cases, so a change to either upstream message cannot silently lose this mapping.
			if (error instanceof Error && error.message === "memory store is missing with a recoverable backup; repair before optimizing") {
				return { ok: false, reason: `${file} is missing while ${this.store.filePath}.bak exists; inspect the backup and repair the handoff file by hand` };
			}
			if (error instanceof Error && error.message === "memory store is corrupt or contains invalid entries; repair before optimizing") {
				return { ok: false, reason: `${file} is corrupt or contains invalid entries; repair or remove the invalid entry by hand` };
			}
			if (error instanceof Error && "code" in error && typeof error.code === "string") {
				return { ok: false, reason: `${file} cannot be accessed (${error.code}); check the path and permissions, repair access and retry` };
			}
			return { ok: false, reason: error instanceof Error ? error.message : "handoff storage failure" };
		}
	}
}
