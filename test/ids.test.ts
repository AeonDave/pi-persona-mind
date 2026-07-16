import assert from "node:assert/strict";
import { test } from "node:test";

import { contentId } from "../src/core/ids.ts";

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
