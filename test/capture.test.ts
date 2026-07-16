import assert from "node:assert/strict";
import { test } from "node:test";

import { detectCaptureCue } from "../src/core/capture.ts";

test("detects durable preference/instruction cues and suggests a kind", () => {
	const a = detectCaptureCue("From now on, always use verbose recon logs.");
	assert.ok(a);
	assert.equal(a.kind, "convention");
	assert.match(a.snippet, /verbose recon logs/);

	const b = detectCaptureCue("I prefer tabs over spaces");
	assert.ok(b);
	assert.equal(b.kind, "preference");

	const c = detectCaptureCue("Remember that the prod DB is read-only.");
	assert.ok(c);
	assert.equal(c.kind, "note");
});

test("ignores ordinary messages with no durable cue", () => {
	assert.equal(detectCaptureCue("what does this function do?"), null);
	assert.equal(detectCaptureCue("run the tests and show me the output"), null);
	assert.equal(detectCaptureCue(""), null);
});

test("the snippet is the relevant sentence, length-capped", () => {
	const long = `unrelated preamble. remember that ${"x".repeat(400)} matters. trailing stuff.`;
	const cue = detectCaptureCue(long);
	assert.ok(cue);
	assert.ok(cue.snippet.length <= 200, "snippet is capped");
	assert.match(cue.snippet, /^remember that/i, "snippet starts at the cued sentence");
});
