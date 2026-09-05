import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve, win32 } from "node:path";
import { after, before, test } from "node:test";

import { type BacklogEntry, makeBacklog } from "../src/core/backlog.ts";
import { legacyContentId } from "../src/core/ids.ts";
import { makeMemory, type MemoryEntry } from "../src/core/memory.ts";
import { inspectStoreFile, migrateLegacyRoot, migrateCurrentScopeAliases } from "../src/core/migrate.ts";
import { mindPaths, projectSlug, sanitizePersona } from "../src/core/scope.ts";

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "ppm-migrate-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function putStore(path: string, entries: unknown[]): Promise<string> {
	const raw = `${JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(), sequence: 1, entries }, null, 2)}\n`;
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, raw, "utf8");
	return raw;
}

async function readEntries(path: string): Promise<unknown[]> {
	const parsed = JSON.parse(await readFile(path, "utf8")) as { entries?: unknown[] };
	return parsed.entries ?? [];
}

test("doctor inspection allocates for the observed store size, not the multi-megabyte cap", async () => {
	const path = join(dir, "doctor-allocation.json");
	const raw = await putStore(path, [makeMemory({ term: "long", kind: "note", text: "small diagnostic" }, 1_000_000)]);
	const allocations: number[] = [];
	const originalAlloc = Buffer.alloc;
	const originalAllocUnsafe = Buffer.allocUnsafe;
	Buffer.alloc = ((size: number, ...args: unknown[]) => {
		allocations.push(size);
		return Reflect.apply(originalAlloc, Buffer, [size, ...args]) as Buffer;
	}) as typeof Buffer.alloc;
	Buffer.allocUnsafe = ((size: number) => {
		allocations.push(size);
		return originalAllocUnsafe(size);
	}) as typeof Buffer.allocUnsafe;
	try {
		const diagnostic = await inspectStoreFile(path, "ltm");
		assert.equal(diagnostic.status, "ok");
	} finally {
		Buffer.alloc = originalAlloc;
		Buffer.allocUnsafe = originalAllocUnsafe;
	}
	assert.ok(allocations.length > 0, "the bounded reader allocation was observed");
	assert.ok(allocations.every((size) => size <= Buffer.byteLength(raw, "utf8") + 1), `unexpected allocations: ${allocations.join(", ")}`);
});

test("doctor inspection applies the same entry cap as the live store", async () => {
	const path = join(dir, "doctor-entry-cap.json");
	await putStore(path, [
		makeMemory({ term: "long", kind: "note", text: "one" }, 1_000_000),
		makeMemory({ term: "long", kind: "note", text: "two" }, 1_000_000),
	]);
	const diagnostic = await inspectStoreFile(path, "ltm", 1024 * 1024, 1);
	assert.equal(diagnostic.status, "corrupt");
	assert.match(diagnostic.message ?? "", /entry|limit/i);
});

test("migration deduplicates semantic content across legacy and current id encodings", async () => {
	const agentDir = join(dir, "semantic-id-agent");
	const entry = makeMemory({ term: "long", kind: "note", text: "same migrated fact", tags: ["a,b"] }, 1_000_000);
	const source = join(agentDir, "pi-persona-mind", "memory", "ltm", "p.json");
	const destination = join(agentDir, "persona-mind", "memory", "ltm", "p.json");
	await putStore(source, [entry]);
	await putStore(destination, [{ ...entry, id: legacyContentId(entry.kind, entry.text, entry.tags) }]);

	const report = await migrateLegacyRoot(agentDir);
	assert.equal(report.entriesAdded, 0);
	assert.equal((await readEntries(destination)).length, 1, "one fact must not persist twice solely because its id encoding changed");
});

function oldSanitizePersona(name: string): string {
	const s = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 64);
	if (!s) return `persona-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
	return s.toLowerCase() === "_shared" || s.toLowerCase() === "_default" || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)
		? `persona-${s}`
		: s;
}

function oldProjectSlug(projectRoot: string, platform: "win32" | "host" = "host"): string {
	const canonical = platform === "win32" ? win32.resolve(projectRoot) : resolve(projectRoot);
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
	const baseName = platform === "win32" ? win32.basename(canonical) : basename(canonical);
	const base = (baseName || "project").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
	return `${base}-${hash}`;
}

test("migrateLegacyRoot merges expected stores, preserves legacy bytes, and is idempotent", async () => {
	const agentDir = join(dir, "agent");
	const legacyLtm = join(agentDir, "pi-persona-mind", "memory", "ltm", "elite.json");
	const legacyStm = join(agentDir, "pi-persona-mind", "memory", "stm", "project.json");
	const legacyBacklog = join(agentDir, "pi-persona-mind", "backlog", "project.json");
	const now = 1_000_000;
	const ltm = makeMemory({ term: "long", kind: "preference", text: "legacy preference" }, now);
	const stm = makeMemory({ term: "short", kind: "note", text: "legacy context" }, now);
	const backlog = makeBacklog({ text: "legacy lead" }, now);
	const sourceBytes = await Promise.all([
		putStore(legacyLtm, [ltm]),
		putStore(legacyStm, [stm]),
		putStore(legacyBacklog, [backlog]),
	]);

	const first = await migrateLegacyRoot(agentDir);
	assert.equal(first.entriesAdded, 3);
	assert.equal(first.filesMigrated, 3);
	assert.equal((await readEntries(join(agentDir, "persona-mind", "memory", "ltm", "elite.json"))).length, 1);
	assert.equal((await readEntries(join(agentDir, "persona-mind", "memory", "stm", "project.json"))).length, 1);
	assert.equal((await readEntries(join(agentDir, "persona-mind", "backlog", "project.json"))).length, 1);
	assert.deepEqual(await readFile(legacyLtm, "utf8"), sourceBytes[0]);
	assert.deepEqual(await readFile(legacyStm, "utf8"), sourceBytes[1]);
	assert.deepEqual(await readFile(legacyBacklog, "utf8"), sourceBytes[2]);

	const second = await migrateLegacyRoot(agentDir);
	assert.equal(second.entriesAdded, 0);
	assert.equal(second.filesMigrated, 0);
});

test("legacy migration caches unchanged source fingerprints across fresh calls and rechecks changes", async () => {
	const agentDir = join(dir, "manifest-agent");
	const source = join(agentDir, "pi-persona-mind", "memory", "ltm", "custom.json");
	const firstEntry = makeMemory({ term: "long", kind: "note", text: "first legacy fact" }, 1_500_000);
	await putStore(source, [firstEntry]);

	const first = await migrateLegacyRoot(agentDir);
	assert.equal(first.entriesAdded, 1);
	assert.equal(first.filesSkipped, 0);

	const second = await migrateLegacyRoot(agentDir);
	assert.equal(second.entriesAdded, 0);
	assert.equal(second.filesScanned, 0, "an unchanged legacy file is not read and parsed again");
	assert.equal(second.filesSkipped, 1);

	const changedEntry = makeMemory({ term: "long", kind: "note", text: "later legacy fact" }, 1_600_000);
	await putStore(source, [firstEntry, changedEntry]);
	const changed = await migrateLegacyRoot(agentDir);
	assert.equal(changed.filesScanned, 1, "a changed source fingerprint invalidates the cache");
	assert.equal(changed.entriesAdded, 1);
	assert.equal((await readEntries(join(agentDir, "persona-mind", "memory", "ltm", "custom.json"))).length, 2);
});

test("migration keeps destination conflicts and converges under concurrent importers", async () => {
	const agentDir = join(dir, "conflict-agent");
	const legacyPath = join(agentDir, "pi-persona-mind", "memory", "ltm", "elite.json");
	const entry = makeMemory({ term: "long", kind: "note", text: "same id" }, 2_000_000);
	const legacy = { ...entry, text: "legacy text with destination id" };
	await putStore(legacyPath, [legacy]);
	const destinationPath = join(agentDir, "persona-mind", "memory", "ltm", "elite.json");
	await putStore(destinationPath, [{ ...entry, text: "destination wins" }]);
	const concurrentEntry = makeMemory({ term: "short", kind: "note", text: "only one concurrent append" }, 2_000_000);
	const concurrentLegacyPath = join(agentDir, "pi-persona-mind", "memory", "stm", "project.json");
	await putStore(concurrentLegacyPath, [concurrentEntry]);
	const concurrentDestinationPath = join(agentDir, "persona-mind", "memory", "stm", "project.json");

	const reports = await Promise.all([migrateLegacyRoot(agentDir), migrateLegacyRoot(agentDir)]);
	assert.equal((await readEntries(destinationPath)).map((e) => (e as { text: string }).text).join("\n"), "destination wins\nlegacy text with destination id");
	assert.equal((await readEntries(concurrentDestinationPath)).length, 1, "the lock prevents duplicate/lost concurrent appends");
	assert.equal((reports[0]?.entriesAdded ?? 0) + (reports[1]?.entriesAdded ?? 0), 2);
});

test("migration reports malformed legacy files and ignores unrelated files", async () => {
	const agentDir = join(dir, "warnings-agent");
	const malformed = join(agentDir, "pi-persona-mind", "memory", "ltm", "broken.json");
	await putStore(malformed, []);
	await writeFile(malformed, "not json", "utf8");
	await putStore(join(agentDir, "pi-persona-mind", "other.json"), []);

	const report = await migrateLegacyRoot(agentDir);
	assert.equal(report.entriesAdded, 0);
	assert.ok(report.warnings.some((warning) => warning.includes("broken.json")));
	assert.equal(report.filesScanned, 1);
});

test("scope alias migration moves a Windows case-folded project slug from the current root", async () => {
	const agentDir = join(dir, "alias-windows-agent");
	const projectRoot = "C:\\Work\\Project";
	const projectOptions = { realpath: () => "C:\\work\\project", platform: "win32" as const };
	const oldSlug = oldProjectSlug(projectRoot, "win32");
	const newSlug = projectSlug(projectRoot, projectOptions);
	assert.notEqual(oldSlug, newSlug);
	const oldPath = join(agentDir, "persona-mind", "memory", "stm", `${oldSlug}.json`);
	const destinationPath = mindPaths(agentDir, "elite", newSlug).stm;
	const entry = makeMemory({ term: "short", kind: "note", text: "survives slug canonicalization" }, 3_000_000);
	const oldBytes = await putStore(oldPath, [entry]);

	const reports = await Promise.all([
		migrateCurrentScopeAliases(agentDir, "elite", projectRoot, { project: projectOptions }),
		migrateCurrentScopeAliases(agentDir, "elite", projectRoot, { project: projectOptions }),
	]);
	assert.equal((reports[0]?.entriesAdded ?? 0) + (reports[1]?.entriesAdded ?? 0), 1);
	assert.deepEqual(await readEntries(destinationPath), [entry]);
	assert.equal(await readFile(oldPath, "utf8"), oldBytes, "alias migration is read-only on sources");
});

test("scope alias migration moves lossy and reserved persona filenames", async () => {
	const agentDir = join(dir, "alias-persona-agent");
	const projectRoot = join(dir, "alias-persona-project");
	const lossy = makeMemory({ term: "long", kind: "note", text: "lossy persona" }, 4_000_000);
	const reserved = makeMemory({ term: "long", kind: "note", text: "reserved persona" }, 4_000_000);
	const oldLossy = join(agentDir, "persona-mind", "memory", "ltm", `${oldSanitizePersona("dev ops")}.json`);
	const oldReserved = join(agentDir, "persona-mind", "memory", "ltm", `${oldSanitizePersona("NUL")}.json`);
	await putStore(oldLossy, [lossy]);
	await putStore(oldReserved, [reserved]);

	const report = await migrateCurrentScopeAliases(agentDir, "dev ops", projectRoot, { includeAmbiguousPersonaAlias: true });
	assert.equal(report.entriesAdded, 1);
	assert.deepEqual(await readEntries(mindPaths(agentDir, sanitizePersona("dev ops"), projectSlug(projectRoot)).ltm), [lossy]);
	const reservedReport = await migrateCurrentScopeAliases(agentDir, "NUL", projectRoot, { includeAmbiguousPersonaAlias: true });
	assert.equal(reservedReport.entriesAdded, 1);
	assert.deepEqual(await readEntries(mindPaths(agentDir, sanitizePersona("NUL"), projectSlug(projectRoot)).ltm), [reserved]);
});

test("scope alias migration uses the historical non-Latin hash and never aliases _default", async () => {
	const agentDir = join(dir, "alias-nonlatin-agent");
	const projectRoot = join(dir, "alias-nonlatin-project");
	const rawPersona = "日本語";
	const oldPersona = oldSanitizePersona(rawPersona);
	const newPersona = sanitizePersona(rawPersona);
	assert.match(oldPersona, /^persona-[0-9a-f]{12}$/);
	assert.equal(oldPersona, newPersona);
	const target = mindPaths(agentDir, newPersona, projectSlug(projectRoot)).ltm;
	const sourceEntry = makeMemory({ term: "long", kind: "note", text: "non-latin source" }, 4_500_000);
	const poisonedDefault = makeMemory({ term: "long", kind: "note", text: "must not bleed from default" }, 4_500_000);
	await putStore(target, [sourceEntry]);
	const defaultPath = join(agentDir, "persona-mind", "memory", "ltm", "_default.json");
	const defaultBytes = await putStore(defaultPath, [poisonedDefault]);

	const report = await migrateCurrentScopeAliases(agentDir, rawPersona, projectRoot);
	assert.equal(report.entriesAdded, 0);
	assert.deepEqual(await readEntries(target), [sourceEntry]);
	assert.equal(await readFile(defaultPath, "utf8"), defaultBytes);
});

test("scope alias migration uses persona-_shared and persona-NUL historical aliases", async () => {
	const agentDir = join(dir, "alias-reserved-agent");
	const projectRoot = "C:\\Work\\ReservedProject";
	const projectOptions = { realpath: (path: string) => path, platform: "win32" as const };
	const sharedEntry = makeMemory({ term: "long", kind: "note", text: "shared alias source" }, 4_600_000);
	const nulEntry = makeMemory({ term: "long", kind: "note", text: "nul alias source" }, 4_600_000);
	const poisonedShared = makeMemory({ term: "long", kind: "note", text: "must not import shared sentinel" }, 4_600_000);
	const poisonedNul = makeMemory({ term: "long", kind: "note", text: "must not import raw nul" }, 4_600_000);
	await putStore(join(agentDir, "persona-mind", "memory", "ltm", "persona-_shared.json"), [sharedEntry]);
	await putStore(join(agentDir, "persona-mind", "memory", "ltm", "_shared.json"), [poisonedShared]);
	await putStore(join(agentDir, "persona-mind", "memory", "ltm", "persona-NUL.json"), [nulEntry]);
	await putStore(join(agentDir, "persona-mind", "memory", "ltm", "NUL.json"), [poisonedNul]);

	const sharedReport = await migrateCurrentScopeAliases(agentDir, "_shared", projectRoot, { project: projectOptions, includeAmbiguousPersonaAlias: true });
	assert.equal(sharedReport.entriesAdded, 1);
	assert.deepEqual(await readEntries(mindPaths(agentDir, sanitizePersona("_shared"), projectSlug(projectRoot, projectOptions)).ltm), [sharedEntry]);
	const nulReport = await migrateCurrentScopeAliases(agentDir, "NUL", projectRoot, { project: projectOptions, includeAmbiguousPersonaAlias: true });
	assert.equal(nulReport.entriesAdded, 1);
	assert.deepEqual(await readEntries(mindPaths(agentDir, sanitizePersona("NUL", "win32"), projectSlug(projectRoot, projectOptions)).ltm), [nulEntry]);
});

test("doctor names a store written by another build instead of reporting anonymous corruption", async () => {
	const path = join(dir, "doctor-version-skew.json");
	await writeFile(path, `${JSON.stringify({ version: 2, updatedAt: new Date(0).toISOString(), sequence: 1, entries: [] })}\n`, "utf8");
	const diagnostic = await inspectStoreFile(path, "ltm");
	assert.match(diagnostic.message ?? "", /version 2/, "the offending version is named so skew is distinguishable from damage");
});

test("doctor only promises 'left untouched' for the envelopes the loader actually refuses", async () => {
	// The skew message tells the operator the file is safe where it lies. JsonStore.parseStore only
	// declines a positive safe-integer version on an otherwise well-formed envelope; every other shape
	// is genuine corruption, which load() QUARANTINES to `*.corrupt-N` and replaces with an empty store.
	// Reporting those as "left untouched" would send the operator away while their memory is moved aside.
	const stamp = new Date(0).toISOString();
	const cases: { name: string; envelope: Record<string, unknown> }[] = [
		{ name: "zero", envelope: { version: 0, updatedAt: stamp, sequence: 1, entries: [] } },
		{ name: "negative", envelope: { version: -1, updatedAt: stamp, sequence: 1, entries: [] } },
		{ name: "fractional", envelope: { version: 1.5, updatedAt: stamp, sequence: 1, entries: [] } },
		{ name: "nan", envelope: { version: Number.NaN, updatedAt: stamp, sequence: 1, entries: [] } },
		{ name: "entries-not-an-array", envelope: { version: 2, updatedAt: stamp, sequence: 1, entries: {} } },
	];
	for (const { name, envelope } of cases) {
		const path = join(dir, `doctor-version-${name}.json`);
		await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");
		const diagnostic = await inspectStoreFile(path, "ltm");
		assert.equal(diagnostic.status, "corrupt");
		assert.doesNotMatch(diagnostic.message ?? "", /left untouched/, `${name}: the loader quarantines this envelope, so doctor must not call it untouched`);
	}
});

test("scope alias migration re-attributes backlog items stored under the pre-0.5.2 persona segment", async () => {
	const agentDir = join(dir, "alias-backlog-persona-agent");
	const projectRoot = join(dir, "alias-backlog-persona-project");
	const projectOptions = { realpath: (path: string) => resolve(path), platform: process.platform };
	const slug = projectSlug(projectRoot, projectOptions);
	// A capitalized name is a fixed point of the OLD filename rule and hash-disambiguated by the new
	// one on win32, so the segment stored inside each record no longer matches the live scope.
	const oldPersona = oldSanitizePersona("Dave");
	const newPersona = sanitizePersona("Dave", "win32");
	assert.notEqual(oldPersona, newPersona);
	const backlogPath = mindPaths(agentDir, newPersona, slug).backlog;
	await putStore(backlogPath, [makeBacklog({ text: "chase the SMB lead", persona: oldPersona }, 8_000_000), makeBacklog({ text: "someone else's lead", persona: "other" }, 8_000_000)]);

	const report = await migrateCurrentScopeAliases(agentDir, "Dave", projectRoot, { project: projectOptions, personaPlatform: "win32" });

	assert.equal(report.entriesAdded, 1, "the reconciled record is reported, not silently rewritten");
	const entries = (await readEntries(backlogPath)) as { text: string; persona: string }[];
	assert.deepEqual(
		entries.map((entry) => `${entry.persona}:${entry.text}`).sort(),
		[`${newPersona}:chase the SMB lead`, "other:someone else's lead"],
		"only this persona's own historical segment is re-attributed",
	);
	const second = await migrateCurrentScopeAliases(agentDir, "Dave", projectRoot, { project: projectOptions, personaPlatform: "win32" });
	assert.equal(second.entriesAdded, 0, "a reconciled store is not rewritten again");
});

test("scope alias migration is a no-op when ordinary names and slug are unchanged", async () => {
	const agentDir = join(dir, "alias-noop-agent");
	const projectRoot = join(dir, "alias-noop-project");
	const projectOptions = { realpath: (path: string) => resolve(path), platform: process.platform };
	const slug = projectSlug(projectRoot, projectOptions);
	const paths = mindPaths(agentDir, "elite", slug);
	const entry = makeMemory({ term: "long", kind: "note", text: "already current" }, 5_000_000);
	const original = await putStore(paths.ltm, [entry]);

	const report = await migrateCurrentScopeAliases(agentDir, "elite", projectRoot, { project: projectOptions });
	assert.equal(report.filesScanned, 0);
	assert.equal(report.entriesAdded, 0);
	assert.equal(await readFile(paths.ltm, "utf8"), original);
});

test("scope alias migration keeps null persona on _default while reconciling its project alias", async () => {
	const agentDir = join(dir, "alias-default-agent");
	const projectRoot = "C:\\Work\\DefaultProject";
	const projectOptions = { realpath: () => "C:\\work\\defaultproject", platform: "win32" as const };
	const oldSlug = oldProjectSlug(projectRoot, "win32");
	const newSlug = projectSlug(projectRoot, projectOptions);
	assert.notEqual(oldSlug, newSlug);
	const entry = makeMemory({ term: "short", kind: "note", text: "default project alias" }, 6_000_000);
	await putStore(join(agentDir, "persona-mind", "memory", "stm", `${oldSlug}.json`), [entry]);

	const report = await migrateCurrentScopeAliases(agentDir, null, projectRoot, { project: projectOptions });
	assert.equal(report.entriesAdded, 1);
	assert.deepEqual(await readEntries(mindPaths(agentDir, "_default", newSlug).stm), [entry]);
});

test("automatic alias migration skips ambiguous persona files but still reconciles project aliases", async () => {
	const agentDir = join(dir, "alias-privacy-agent");
	const projectRoot = "C:\\Work\\PrivacyProject";
	const projectOptions = { realpath: (path: string) => path, platform: "win32" as const };
	const personaEntry = makeMemory({ term: "long", kind: "note", text: "ambiguous persona source" }, 7_000_000);
	const projectEntry = makeMemory({ term: "short", kind: "note", text: "safe project source" }, 7_000_000);
	await putStore(join(agentDir, "persona-mind", "memory", "ltm", "red-team.json"), [personaEntry]);
	const oldProject = oldProjectSlug(projectRoot, "win32");
	await putStore(join(agentDir, "persona-mind", "memory", "stm", `${oldProject}.json`), [projectEntry]);
	const report = await migrateCurrentScopeAliases(agentDir, "red team", projectRoot, { project: projectOptions });
	assert.equal(report.entriesAdded, 1, "only the unambiguous project alias is automatic");
	assert.equal(await readFile(mindPaths(agentDir, sanitizePersona("red team"), projectSlug(projectRoot, projectOptions)).ltm).catch(() => null), null, "ambiguous persona source was not imported");
	assert.deepEqual(await readEntries(mindPaths(agentDir, sanitizePersona("red team"), projectSlug(projectRoot, projectOptions)).stm), [projectEntry]);
});

test("legacy import bounds file count and bytes without following non-regular sources", async () => {
	const agentDir = join(dir, "bounded-root-agent");
	const first = join(agentDir, "pi-persona-mind", "memory", "ltm", "first.json");
	const second = join(agentDir, "pi-persona-mind", "memory", "ltm", "second.json");
	await putStore(first, [makeMemory({ term: "long", kind: "note", text: "first bounded" }, 8_000_000)]);
	await putStore(second, [makeMemory({ term: "long", kind: "note", text: "second bounded" }, 8_000_000)]);
	const report = await migrateLegacyRoot(agentDir, { maxFiles: 1, maxFileBytes: 100 });
	assert.equal(report.filesScanned, 1);
	assert.ok(report.warnings.some((warning) => /migration limit|byte/i.test(warning)));
	assert.equal(await readFile(join(agentDir, "persona-mind", "memory", "ltm", "first.json")).catch(() => null), null, "oversized source is skipped");
});

test("migration repairs colliding legacy comma-tag ids instead of dropping distinct memories", async () => {
	const agentDir = join(dir, "id-collision-agent");
	const a = makeMemory({ term: "long", kind: "note", text: "alpha", tags: ["a,b"] }, 9_000_000);
	const b = makeMemory({ term: "long", kind: "note", text: "alpha", tags: ["a", "b"] }, 9_000_000);
	const legacyId = legacyContentId("note", "alpha", ["a,b"]);
	const legacyPath = join(agentDir, "pi-persona-mind", "memory", "ltm", "elite.json");
	await putStore(legacyPath, [{ ...a, id: legacyId }, { ...b, id: legacyId }]);
	const report = await migrateLegacyRoot(agentDir);
	assert.equal(report.entriesAdded, 2);
	assert.equal((await readEntries(join(agentDir, "persona-mind", "memory", "ltm", "elite.json"))).length, 2);
});

test("legacy migration warns for a capacity source and continues with other files", async () => {
	const agentDir = join(dir, "capacity-legacy-agent");
	const blockedDestination = join(agentDir, "persona-mind", "memory", "ltm", "blocked.json");
	const blockedSource = join(agentDir, "pi-persona-mind", "memory", "ltm", "blocked.json");
	const followupSource = join(agentDir, "pi-persona-mind", "memory", "ltm", "followup.json");
	const followupDestination = join(agentDir, "persona-mind", "memory", "ltm", "followup.json");
	const full = Array.from({ length: 10_000 }, (_, index) => makeMemory({ term: "long", kind: "note", text: `already full ${index}` }, 10_000_000));
	await putStore(blockedDestination, full);
	await putStore(blockedSource, [makeMemory({ term: "long", kind: "note", text: "cannot fit" }, 10_000_000)]);
	const followup = makeMemory({ term: "long", kind: "note", text: "still imported" }, 10_000_000);
	await putStore(followupSource, [followup]);

	const report = await migrateLegacyRoot(agentDir);
	assert.equal(report.entriesAdded, 1);
	assert.deepEqual(await readEntries(followupDestination), [followup]);
	assert.ok(report.warnings.some((warning) => warning.includes(blockedSource) && /capacity|limit/i.test(warning)));
});

test("scope alias migration warns for a capacity source and continues with other aliases", async () => {
	const agentDir = join(dir, "capacity-alias-agent");
	const projectRoot = "C:\\Work\\AliasCapacityProject";
	const projectOptions = { realpath: () => "C:\\work\\aliascapacityproject", platform: "win32" as const };
	const oldSlug = oldProjectSlug(projectRoot, "win32");
	const newSlug = projectSlug(projectRoot, projectOptions);
	assert.notEqual(oldSlug, newSlug);
	const blockedDestination = mindPaths(agentDir, "elite", newSlug).stm;
	const blockedSource = join(agentDir, "persona-mind", "memory", "stm", `${oldSlug}.json`);
	const followupSource = join(agentDir, "persona-mind", "backlog", `${oldSlug}.json`);
	const followupDestination = mindPaths(agentDir, "elite", newSlug).backlog;
	const full = Array.from({ length: 10_000 }, (_, index) => makeMemory({ term: "short", kind: "note", text: `already full ${index}` }, 11_000_000));
	await putStore(blockedDestination, full);
	await putStore(blockedSource, [makeMemory({ term: "short", kind: "note", text: "cannot fit alias" }, 11_000_000)]);
	const followup = makeBacklog({ text: "still imported alias" }, 11_000_000);
	await putStore(followupSource, [followup]);

	const report = await migrateCurrentScopeAliases(agentDir, "elite", projectRoot, { project: projectOptions });
	assert.equal(report.entriesAdded, 1);
	assert.deepEqual(await readEntries(followupDestination), [followup]);
	assert.ok(report.warnings.some((warning) => warning.includes(blockedSource) && /capacity|limit/i.test(warning)));
});

test("the unprefixed root is where the mind writes, and the pi-prefixed root is the one-way source", async () => {
	const agentDir = join(dir, "inverted-direction-agent");
	const source = join(agentDir, "pi-persona-mind", "memory", "ltm", "elite.json");
	const entry = makeMemory({ term: "long", kind: "note", text: "written under the pi-prefixed root" }, 12_000_000);
	const sourceBytes = await putStore(source, [entry]);

	const report = await migrateLegacyRoot(agentDir);

	assert.equal(report.entriesAdded, 1);
	assert.deepEqual(await readEntries(join(agentDir, "persona-mind", "memory", "ltm", "elite.json")), [entry]);
	assert.equal(await readFile(source, "utf8"), sourceBytes, "the pi-prefixed root is only ever read");
});

test("the inverted import merges both populated roots and a true collision keeps the later record", async () => {
	const agentDir = join(dir, "inverted-merge-agent");
	const now = 12_100_000;
	const both = makeMemory({ term: "long", kind: "note", text: "recorded under both roots" }, now);
	// Same fact, and here the destination holds the LATER copy — so it must survive the merge untouched.
	const destinationCopy = { ...both, lastSeenAt: new Date(now + 3_600_000).toISOString() };
	const onlyOld = makeMemory({ term: "long", kind: "note", text: "only under the pi-prefixed root" }, now);
	const onlyNew = makeMemory({ term: "long", kind: "note", text: "only under the unprefixed root" }, now);
	const source = join(agentDir, "pi-persona-mind", "memory", "ltm", "elite.json");
	const destination = join(agentDir, "persona-mind", "memory", "ltm", "elite.json");
	await putStore(source, [both, onlyOld]);
	await putStore(destination, [destinationCopy, onlyNew]);

	const report = await migrateLegacyRoot(agentDir);

	assert.equal(report.entriesAdded, 1, "only the fact the destination did not already hold is appended");
	const merged = (await readEntries(destination)) as { text: string }[];
	assert.deepEqual(merged.map((entry) => entry.text).sort(), [both.text, onlyNew.text, onlyOld.text].sort(), "neither root loses an entry");
	assert.deepEqual(merged.find((entry) => entry.text === both.text), destinationCopy, "the later copy wins a true collision");

	const second = await migrateLegacyRoot(agentDir);
	assert.equal(second.entriesAdded, 0, "re-running the inverted import changes nothing");
	assert.equal((await readEntries(destination)).length, 3);
});

test("a manifest left by the pre-0.7.0 direction can neither skip nor re-import an entry", async () => {
	const agentDir = join(dir, "inverted-manifest-agent");
	const source = join(agentDir, "pi-persona-mind", "memory", "ltm", "elite.json");
	const entry = makeMemory({ term: "long", kind: "note", text: "must survive the direction flip" }, 12_200_000);
	await putStore(source, [entry]);
	// 0.6.x stamped its manifest at its destination — the root the flip turns back into the SOURCE.
	// Two independent reasons make it inert: a stamp id hashes source\0destination, so every record in
	// it addresses the opposite direction and can never match a stamp taken now; and it sits outside
	// the three scanned directories, so it is never mistaken for a store either.
	const supersededManifest = join(agentDir, "pi-persona-mind", ".legacy-import-v1.json");
	const supersededBytes = await putStore(supersededManifest, [
		{
			id: "abcdefabcdefabcdefabcdef",
			source: resolve(join(agentDir, "persona-mind", "memory", "ltm", "elite.json")),
			destination: resolve(source),
			kind: "ltm",
			size: "1",
			mtimeNs: "1",
			ctimeNs: "1",
			dev: "1",
			ino: "1",
		},
	]);

	const first = await migrateLegacyRoot(agentDir);
	assert.equal(first.filesSkipped, 0, "a stamp from the old direction must not suppress a real source");
	assert.equal(first.entriesAdded, 1);
	assert.deepEqual(await readEntries(join(agentDir, "persona-mind", "memory", "ltm", "elite.json")), [entry]);
	assert.equal(await readFile(supersededManifest, "utf8"), supersededBytes, "the superseded manifest is left where it lies");

	const second = await migrateLegacyRoot(agentDir);
	assert.equal(second.filesSkipped, 1, "only the manifest at the new destination decides a skip");
	assert.equal(second.entriesAdded, 0);
	assert.equal((await readEntries(join(agentDir, "persona-mind", ".legacy-import-v1.json"))).length, 1);
});

test("with nothing under the pi-prefixed root the current root is left byte-for-byte alone", async () => {
	const agentDir = join(dir, "only-current-agent");
	const destination = join(agentDir, "persona-mind", "memory", "ltm", "elite.json");
	const entry = makeMemory({ term: "long", kind: "note", text: "already in the current root" }, 12_300_000);
	const bytes = await putStore(destination, [entry]);

	const report = await migrateLegacyRoot(agentDir);

	assert.deepEqual(report, { filesScanned: 0, filesSkipped: 0, filesMigrated: 0, entriesSeen: 0, entriesAdded: 0, conflicts: 0, invalidEntries: 0, warnings: [] });
	assert.equal(await readFile(destination, "utf8"), bytes, "an absent legacy root is not an error and rewrites nothing");
	assert.equal(await readFile(join(agentDir, "pi-persona-mind", "memory", "ltm", "elite.json"), "utf8").catch(() => null), null, "the superseded root is never recreated");
});

test("a fresh install with neither root writes nothing, not even a manifest", async () => {
	const agentDir = join(dir, "no-roots-agent");
	await mkdir(agentDir, { recursive: true });

	const report = await migrateLegacyRoot(agentDir);

	assert.deepEqual(report, { filesScanned: 0, filesSkipped: 0, filesMigrated: 0, entriesSeen: 0, entriesAdded: 0, conflicts: 0, invalidEntries: 0, warnings: [] });
	assert.equal(existsSync(join(agentDir, "persona-mind")), false, "an empty pass must not materialize the store tree");
	assert.equal(existsSync(join(agentDir, "pi-persona-mind")), false);
});

test("a semantic collision is reconciled by freshness, not by which root the record sits in", async () => {
	const agentDir = join(dir, "stale-destination-agent");
	const base = makeMemory({ term: "short", kind: "note", text: "the deploy key rotates on fridays" }, Date.parse("2025-12-30T00:00:00.000Z"));
	// The destination root is the pre-0.6 snapshot the 0.6.x importer drained and deliberately left
	// populated, so ITS copy is the superseded one; the pi-prefixed root is where the user has lived since.
	const superseded = { ...base, lastSeenAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-03T00:00:00.000Z" };
	const live = { ...base, lastSeenAt: "2026-09-04T00:00:00.000Z", expiresAt: "2099-09-06T00:00:00.000Z", source: "session 12" };
	const source = join(agentDir, "pi-persona-mind", "memory", "stm", "p.json");
	const destination = join(agentDir, "persona-mind", "memory", "stm", "p.json");
	await putStore(destination, [superseded]);
	await putStore(source, [live]);

	const report = await migrateLegacyRoot(agentDir);

	const merged = (await readEntries(destination)) as MemoryEntry[];
	assert.equal(merged.length, 1, "one fact must not persist twice");
	assert.equal(merged[0]?.expiresAt, live.expiresAt, "a live short-term memory must not be re-expired by the superseded snapshot");
	assert.equal(merged[0]?.lastSeenAt, live.lastSeenAt);
	assert.equal(merged[0]?.source, "session 12");
	assert.equal(merged[0]?.id, superseded.id, "identity stays the destination's, as upsertMemory does");
	assert.equal(merged[0]?.recordedAt, superseded.recordedAt);
	assert.equal(report.conflicts, 1);
	assert.equal(report.entriesAdded, 1, "a record reconciled in place is a committed change");
});

test("a semantic duplicate dropped under a different id encoding is still counted as a conflict", async () => {
	const agentDir = join(dir, "conflict-count-agent");
	const entry = makeMemory({ term: "long", kind: "note", text: "counted once", tags: ["a,b"] }, 13_100_000);
	const source = join(agentDir, "pi-persona-mind", "memory", "ltm", "p.json");
	const destination = join(agentDir, "persona-mind", "memory", "ltm", "p.json");
	await putStore(source, [entry]);
	await putStore(destination, [{ ...entry, id: legacyContentId(entry.kind, entry.text, entry.tags) }]);

	const report = await migrateLegacyRoot(agentDir);

	assert.equal(report.entriesAdded, 0);
	assert.equal(report.conflicts, 1, "the counter must report what the dedup actually did");
});

test("a lead finished under the source root stays done when the superseded root still calls it open", async () => {
	const agentDir = join(dir, "terminal-backlog-agent");
	const open = makeBacklog({ text: "call the client", tags: ["client"], dueInSeconds: 60 }, 13_200_000);
	const done: BacklogEntry = { ...open, state: "done", note: "called on the 21st" };
	delete done.dueAtEpochMs; // the live copy already delivered and acknowledged its wake
	const source = join(agentDir, "pi-persona-mind", "backlog", "p.json");
	const destination = join(agentDir, "persona-mind", "backlog", "p.json");
	await putStore(destination, [open]);
	await putStore(source, [done]);

	const report = await migrateLegacyRoot(agentDir);

	const merged = (await readEntries(destination)) as BacklogEntry[];
	assert.equal(merged.length, 1, "state is not part of the content id — a done row must not join an open row");
	assert.equal(merged[0]?.state, "done", "finished work must not revert to open");
	assert.equal(merged[0]?.note, "called on the 21st");
	assert.equal(merged[0]?.dueAtEpochMs, undefined, "an acknowledged wake must not be re-armed by the superseded copy");
	assert.equal(report.entriesAdded, 1);
});

test("advancing a lead's state never drags the superseded copy's lifetime across", async () => {
	// Progress moves forward; retention does not travel with it. Taking the further-along copy WHOLESALE
	// pairs its `expiresAt` with the destination's own `createdAt`, and a superseded lifetime can predate
	// it — a row that expires before it exists, which no reader can make sense of.
	const agentDir = join(dir, "lifetime-backlog-agent");
	const open = makeBacklog({ text: "renew the cert", tags: ["ops"] }, 13_300_000);
	const stale: BacklogEntry = { ...open, state: "done", expiresAt: new Date(13_100_000).toISOString() };
	const source = join(agentDir, "pi-persona-mind", "backlog", "p.json");
	const destination = join(agentDir, "persona-mind", "backlog", "p.json");
	await putStore(destination, [open]);
	await putStore(source, [stale]);

	await migrateLegacyRoot(agentDir);

	const merged = (await readEntries(destination)) as BacklogEntry[];
	assert.equal(merged[0]?.state, "done", "the further-along state still wins");
	assert.equal(merged[0]?.expiresAt, open.expiresAt, "retention stays with the row the user has been living with");
	const lead = merged[0]!;
	assert.ok(lead.expiresAt, "the destination's lifetime is kept, so it is still set");
	assert.ok(
		Date.parse(lead.expiresAt) >= Date.parse(lead.createdAt),
		`a merged lead must not expire before it was created: created ${lead.createdAt}, expires ${lead.expiresAt}`,
	);
});

test("a terminal destination lead is not reopened by a superseded open copy", async () => {
	const agentDir = join(dir, "terminal-destination-agent");
	const open = makeBacklog({ text: "renew the certificate", tags: ["ops"] }, 13_250_000);
	const done: BacklogEntry = { ...open, state: "done", note: "renewed" };
	const source = join(agentDir, "pi-persona-mind", "backlog", "p.json");
	const destination = join(agentDir, "persona-mind", "backlog", "p.json");
	await putStore(destination, [done]);
	await putStore(source, [open]);

	const report = await migrateLegacyRoot(agentDir);

	const merged = (await readEntries(destination)) as BacklogEntry[];
	assert.equal(merged.length, 1);
	assert.equal(merged[0]?.state, "done");
	assert.equal(merged[0]?.note, "renewed");
	assert.equal(report.entriesAdded, 0, "a destination that already holds the later state is untouched");
});

test("one unimportable destination does not strand the rest of its directory", async () => {
	const agentDir = join(dir, "stranded-directory-agent");
	const now = 13_300_000;
	const a = makeMemory({ term: "long", kind: "note", text: "first legacy fact" }, now);
	const b = makeMemory({ term: "long", kind: "note", text: "second legacy fact" }, now);
	const c = makeMemory({ term: "long", kind: "note", text: "third legacy fact" }, now);
	const legacyDirectory = join(agentDir, "pi-persona-mind", "memory", "ltm");
	await putStore(join(legacyDirectory, "a.json"), [a]);
	await putStore(join(legacyDirectory, "b.json"), [b]);
	await putStore(join(legacyDirectory, "c.json"), [c]);
	// A destination written by another build: JsonStore.load throws StoreVersionError instead of
	// quarantining it, and that is not the capacity error mergeImport isolates.
	const blocked = join(agentDir, "persona-mind", "memory", "ltm", "b.json");
	await mkdir(join(blocked, ".."), { recursive: true });
	await writeFile(blocked, `${JSON.stringify({ version: 2, updatedAt: new Date(0).toISOString(), sequence: 1, entries: [] }, null, 2)}\n`, "utf8");

	const report = await migrateLegacyRoot(agentDir);

	assert.equal(report.filesScanned, 3, "every recognized source is still visited");
	assert.equal(report.entriesAdded, 2);
	assert.deepEqual(await readEntries(join(agentDir, "persona-mind", "memory", "ltm", "c.json")), [c], "a later file must not be stranded behind a failing one");
	assert.ok(report.warnings.some((warning) => warning.includes(join(legacyDirectory, "b.json"))), "the warning names the source that failed, not its directory");
});

test("a torn legacy source falls back to the last-known-good .bak sidecar beside it", async () => {
	const agentDir = join(dir, "torn-source-agent");
	const entry = makeMemory({ term: "long", kind: "note", text: "only the backup still has this" }, 13_400_000);
	const source = join(agentDir, "pi-persona-mind", "memory", "ltm", "torn.json");
	await putStore(`${source}.bak`, [entry]);
	await writeFile(source, '{"version":1,"entries":[{"id":"a","ki', "utf8");

	const report = await migrateLegacyRoot(agentDir);

	assert.deepEqual(await readEntries(join(agentDir, "persona-mind", "memory", "ltm", "torn.json")), [entry], "the sidecar JsonStore keeps for exactly this failure must be consulted");
	assert.ok(report.warnings.some((warning) => warning.includes("torn.json") && warning.includes(".bak")), "the warning says the backup was used");
	assert.equal(report.entriesAdded, 1);
});

test("an unreadable legacy source is never stamped as successfully imported", async () => {
	const agentDir = join(dir, "unstamped-source-agent");
	const source = join(agentDir, "pi-persona-mind", "memory", "ltm", "shredded.json");
	const destination = join(agentDir, "persona-mind", "memory", "ltm", "shredded.json");
	await putStore(destination, [makeMemory({ term: "long", kind: "note", text: "unrelated destination fact" }, 13_500_000)]);
	await mkdir(join(source, ".."), { recursive: true });
	await writeFile(source, "not json at all", "utf8");

	const first = await migrateLegacyRoot(agentDir);
	const second = await migrateLegacyRoot(agentDir);

	assert.ok(first.warnings.some((warning) => warning.includes("shredded.json")));
	assert.equal(second.filesSkipped, 0, "a source that was never imported must not be stamped as done");
	assert.ok(second.warnings.some((warning) => warning.includes("shredded.json")), "the damage keeps being surfaced until it is repaired");
});

test("a .bak that recovers nothing is not treated as a successful read", async () => {
	// Accepting an empty sidecar would let importFile stamp the torn source, and the next start's
	// `sameStamp && destination exists` skip would bury it forever — silently, after one warning.
	const agentDir = join(dir, "empty-bak-agent");
	const source = join(agentDir, "pi-persona-mind", "memory", "ltm", "p.json");
	await putStore(source, [makeMemory({ term: "long", kind: "note", text: "keep me", tags: [] }, 13_400_000)]);
	await putStore(`${source}.bak`, []);
	await writeFile(source, "{ this is torn", "utf8");

	const first = await migrateLegacyRoot(agentDir);
	assert.equal(first.entriesAdded, 0);
	assert.ok(first.warnings.some((w) => w.includes("no usable")), `the torn source must be reported: ${JSON.stringify(first.warnings)}`);

	// Not stamped, so a later run still retries it — here the user has restored a good .bak.
	await putStore(`${source}.bak`, [makeMemory({ term: "long", kind: "note", text: "keep me", tags: [] }, 13_400_000)]);
	const second = await migrateLegacyRoot(agentDir);
	assert.equal(second.entriesAdded, 1, "a source that was never successfully read must stay retryable");
});
