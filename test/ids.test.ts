import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { compatibleContentIds, contentId, legacyContentId } from "../src/core/ids.ts";

test("contentId is stable regardless of tag order", () => {
	const a = contentId("preference", "verbose recon logs", ["recon", "logging"]);
	const b = contentId("preference", "verbose recon logs", ["logging", "recon"]);
	assert.equal(a, b);
});

test("contentId ignores case and whitespace noise (same fact dedups)", () => {
	const a = contentId("note", "The auth refactor is on branch X", []);
	const b = contentId("note", "  the   AUTH refactor is on branch x  ", []);
	assert.equal(a, b);
});

test("contentId differs by kind, text, and tag set", () => {
	const base = contentId("note", "same text", ["t"]);
	assert.notEqual(base, contentId("gotcha", "same text", ["t"]));
	assert.notEqual(base, contentId("note", "other text", ["t"]));
	assert.notEqual(base, contentId("note", "same text", ["u"]));
});

test("contentId is a 12-char lowercase hex string", () => {
	const id = contentId("invariant", "always confirm destructive ops", []);
	assert.match(id, /^[0-9a-f]{12}$/);
});

test("contentId keeps comma-containing tags distinct from comma-separated tag sets", () => {
	const embeddedComma = contentId("note", "same text", ["a,b"]);
	const separateTags = contentId("note", "same text", ["a", "b"]);
	assert.notEqual(embeddedComma, separateTags);
});

test("contentId preserves the legacy digest for ordinary tag inputs", () => {
	const legacyMaterial = "note\0same text\0a,b";
	const legacy = createHash("sha256").update(legacyMaterial).digest("hex").slice(0, 12);
	assert.equal(contentId("note", "same text", ["a", "b"]), legacy);
});

test("compatible ids include the migrated v1 id for delimiter-bearing tags", () => {
	const current = contentId("note", "same text", ["a,b"]);
	const legacy = legacyContentId("note", "same text", ["a,b"]);
	assert.notEqual(current, legacy);
	assert.deepEqual(new Set(compatibleContentIds("note", "same text", ["a,b"])), new Set([current, legacy]));
});
