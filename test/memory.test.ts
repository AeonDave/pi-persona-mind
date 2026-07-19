import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ageLabel,
	DEFAULT_TTL_HOURS,
	isExpired,
	makeMemory,
	type MemoryEntry,
	promoteToLong,
	pruneExpired,
	recall,
	upsertMemory,
	validateMemory,
} from "../src/core/memory.ts";

const T0 = Date.parse("2026-07-16T00:00:00.000Z");
const H = 3_600_000;

test("makeMemory(long) is durable — no expiry", () => {
	const e = makeMemory({ term: "long", kind: "preference", text: "prefers verbose recon", tags: ["Recon"] }, T0);
	assert.equal(e.kind, "preference");
	assert.equal(e.expiresAt, undefined);
	assert.match(e.id, /^[0-9a-f]{12}$/);
	assert.equal(e.recordedAt, new Date(T0).toISOString());
});

test("makeMemory(short) expires after ttlHours (default 48h)", () => {
	const def = makeMemory({ term: "short", kind: "note", text: "auth refactor on branch x" }, T0);
	assert.equal(def.expiresAt, new Date(T0 + DEFAULT_TTL_HOURS * H).toISOString());
	const custom = makeMemory({ term: "short", kind: "note", text: "flaky test today", ttlHours: 6 }, T0);
	assert.equal(custom.expiresAt, new Date(T0 + 6 * H).toISOString());
});

test("upsertMemory dedups by content id, preserving recordedAt and bumping lastSeenAt", () => {
	const first = makeMemory({ term: "long", kind: "note", text: "same fact", tags: ["a"] }, T0);
	const later = makeMemory({ term: "long", kind: "note", text: "  Same   Fact ", tags: ["a"] }, T0 + 5 * H);
	const list = upsertMemory([first], later);
	assert.equal(list.length, 1, "same content → one entry");
	assert.equal(list[0]?.recordedAt, first.recordedAt, "keeps original recordedAt");
	assert.equal(list[0]?.lastSeenAt, later.recordedAt, "bumps lastSeenAt");
});

test("upsertMemory with supersedes retires the old entry", () => {
	const old = makeMemory({ term: "long", kind: "convention", text: "use tabs", tags: [] }, T0);
	const fresh = makeMemory({ term: "long", kind: "convention", text: "use spaces", tags: [], supersedes: old.id }, T0 + H);
	const list = upsertMemory([old], fresh);
	assert.deepEqual(
		list.map((e) => e.text),
		["use spaces"],
	);
});

test("isExpired / pruneExpired drop stale short-term but keep long-term and fresh", () => {
	const ltm = makeMemory({ term: "long", kind: "invariant", text: "always confirm destructive ops" }, T0);
	const stale = makeMemory({ term: "short", kind: "note", text: "stale", ttlHours: 1 }, T0);
	const fresh = makeMemory({ term: "short", kind: "note", text: "fresh", ttlHours: 48 }, T0);
	const now = T0 + 2 * H;
	assert.equal(isExpired(stale, now), true);
	assert.equal(isExpired(fresh, now), false);
	assert.equal(isExpired(ltm, now), false);
	const kept = pruneExpired([ltm, stale, fresh], now).map((e) => e.text);
	assert.deepEqual(kept.sort(), ["always confirm destructive ops", "fresh"]);
});

test("recall ranks keyword matches first, then recency; empty query returns recent", () => {
	const a = makeMemory({ term: "long", kind: "note", text: "the SMB share needs creds", tags: ["smb"] }, T0);
	const b = makeMemory({ term: "long", kind: "note", text: "kerberos ticket expired", tags: [] }, T0 + H);
	const c = makeMemory({ term: "long", kind: "note", text: "another SMB detail", tags: [] }, T0 + 2 * H);
	const hits = recall([a, b, c], "smb", T0 + 3 * H, { max: 10 });
	assert.deepEqual(
		hits.map((e) => e.text),
		["another SMB detail", "the SMB share needs creds"],
		"only matches, most-recent first",
	);
	const recent = recall([a, b, c], "", T0 + 3 * H, { max: 2 });
	assert.equal(recent.length, 2, "budget honored");
	assert.equal(recent[0]?.text, "another SMB detail", "recency first when no query");
});

test("ageLabel is a coarse, prompt-cache-stable label (sub-day → one bucket, then day+)", () => {
	const rec = new Date(T0).toISOString();
	// Sub-day collapses to a single stable bucket — no per-minute/hour churn.
	assert.equal(ageLabel(rec, T0 + 30_000), "today");
	assert.equal(ageLabel(rec, T0 + 5 * 60_000), "today");
	assert.equal(ageLabel(rec, T0 + 3 * H), "today");
	// Day granularity where recency is load-bearing, then weeks/months/years.
	assert.equal(ageLabel(rec, T0 + 50 * H), "2d");
	assert.equal(ageLabel(rec, T0 + 12 * 24 * H), "12d");
	assert.equal(ageLabel(rec, T0 + 20 * 24 * H), "2w");
	assert.equal(ageLabel(rec, T0 + 70 * 24 * H), "2mo");
	assert.equal(ageLabel(rec, T0 + 400 * 24 * H), "1y");
	// A corrupt/unparseable timestamp must never render "NaN…".
	assert.equal(ageLabel("not-a-date", T0), "?");
	assert.equal(ageLabel("", T0), "?");
});

test("ageLabel is byte-stable across a session's turns (the prompt-cache guarantee)", () => {
	const rec = new Date(T0).toISOString();
	// Old rendering churned every minute ("29m"→"30m"…); now a whole day is one identical bucket.
	const within = [29 * 60_000, 30 * 60_000, 55 * 60_000, 5 * H, 23 * H].map((d) => ageLabel(rec, T0 + d));
	assert.deepEqual(within, ["today", "today", "today", "today", "today"]);
	// Two nearby turns on a multi-day-old entry render identically (no sub-day drift).
	assert.equal(ageLabel(rec, T0 + 3 * 24 * H + 60_000), ageLabel(rec, T0 + 3 * 24 * H + 40 * 60_000));
});

test("validateMemory accepts a well-formed entry and rejects junk", () => {
	const good = makeMemory({ term: "long", kind: "note", text: "x" }, T0);
	assert.deepEqual(validateMemory(JSON.parse(JSON.stringify(good))), good);
	assert.equal(validateMemory({ id: "x", kind: "bogus", text: "y" }), null);
	assert.equal(validateMemory(null), null);
	assert.equal(validateMemory({ id: "x" }), null);
});

test("objective is a valid kind (the persona's durable north-star)", () => {
	const e = makeMemory({ term: "long", kind: "objective", text: "root the DC before the window closes" }, T0);
	assert.equal(e.kind, "objective");
	assert.equal(e.expiresAt, undefined);
	assert.deepEqual(validateMemory(JSON.parse(JSON.stringify(e))), e);
});

test("provenance (source/derivedFrom) is stored but EXCLUDED from the content id", () => {
	const withProv = makeMemory({ term: "long", kind: "note", text: "same fact", tags: ["t"], source: "session 3", derivedFrom: ["abc", "def"] }, T0);
	const without = makeMemory({ term: "long", kind: "note", text: "same fact", tags: ["t"] }, T0);
	assert.equal(withProv.id, without.id, "re-recording the same fact from a new source must not fork the id");
	assert.equal(withProv.source, "session 3");
	assert.deepEqual(withProv.derivedFrom, ["abc", "def"]);
	assert.deepEqual(validateMemory(JSON.parse(JSON.stringify(withProv))), withProv);
});

test("promoteToLong drops expiry, preserves recordedAt + id, bumps lastSeenAt", () => {
	const stm = makeMemory({ term: "short", kind: "note", text: "graduating fact", ttlHours: 12, persona: "elite" }, T0);
	const ltm = promoteToLong(stm, T0 + 5 * 3_600_000);
	assert.equal(ltm.id, stm.id, "same fact, same id");
	assert.equal(ltm.expiresAt, undefined, "no longer decays");
	assert.equal(ltm.persona, undefined, "long-term is not persona-tagged in the entry");
	assert.equal(ltm.recordedAt, stm.recordedAt, "keeps its original age");
	assert.equal(ltm.lastSeenAt, new Date(T0 + 5 * 3_600_000).toISOString());
});

test("recall bumps nothing (pure) — inputs are not mutated", () => {
	const a = makeMemory({ term: "long", kind: "note", text: "immutable check", tags: [] }, T0);
	const snapshot: MemoryEntry = JSON.parse(JSON.stringify(a));
	recall([a], "immutable", T0 + H, { max: 5 });
	assert.deepEqual(a, snapshot);
});
