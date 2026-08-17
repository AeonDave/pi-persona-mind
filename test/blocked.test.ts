import assert from "node:assert/strict";
import { test } from "node:test";

import { detectBlockedLeg } from "../src/core/blocked.ts";

test("detects a [BLOCKED: …] marker and echoes it (with its reason) as the snippet", () => {
	const cue = detectBlockedLeg("tried A, B, C. [BLOCKED: need domain creds]");
	assert.ok(cue, "a blocked leg is detected");
	assert.match(cue.snippet, /\[BLOCKED: need domain creds\]/);
});

test("detects a CTF give-up (FLAG: UNKNOWN), case/spacing tolerant", () => {
	assert.ok(detectBlockedLeg("PROOF: none\nFLAG: UNKNOWN"));
	assert.ok(detectBlockedLeg("flag:   unknown"));
	assert.ok(detectBlockedLeg("[blocked: dead end]"), "lowercase marker still matches");
});

test("stays quiet on a clean report and on empty / non-string input", () => {
	assert.equal(detectBlockedLeg("done — foothold obtained, PROOF: id → uid=0(root)"), null);
	assert.equal(detectBlockedLeg(""), null);
	assert.equal(detectBlockedLeg("   "), null);
	assert.equal(detectBlockedLeg(undefined as unknown as string), null);
});

test("caps a very long marker snippet", () => {
	const cue = detectBlockedLeg(`[BLOCKED: ${"x".repeat(500)}]`);
	assert.ok(cue);
	assert.ok(cue.snippet.length <= 160, "snippet is length-capped for the status line");
});

test("sanitizes control characters before echoing an untrusted child marker to the status line", () => {
	const cue = detectBlockedLeg("[BLOCKED: wait\u001b[2J\u0007 for operator]");
	assert.ok(cue);
	assert.doesNotMatch(cue.snippet, /[\u0000-\u001f\u007f-\u009f]/u);
	assert.match(cue.snippet, /wait.*for operator/);
});
