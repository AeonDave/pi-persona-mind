import assert from "node:assert/strict";
import { test } from "node:test";

import { makeBacklog, openItems, transition, validateBacklog, viewFor } from "../src/core/backlog.ts";

const T0 = Date.parse("2026-07-16T00:00:00.000Z");

test("makeBacklog creates an open, content-addressed entry", () => {
	const e = makeBacklog({ text: "revisit the SMB share", tags: ["smb"], persona: "elite" }, T0);
	assert.equal(e.state, "open");
	assert.equal(e.persona, "elite");
	assert.match(e.id, /^[0-9a-f]{12}$/);
	assert.equal(e.createdAt, new Date(T0).toISOString());
});

test("makeBacklog with dueInSeconds sets dueAtEpochMs", () => {
	const e = makeBacklog({ text: "re-run nmap after reset", dueInSeconds: 600 }, T0);
	assert.equal(e.dueAtEpochMs, T0 + 600_000);
});

test("transition moves state and records a note; unknown id is a no-op flagged not-ok", () => {
	const e = makeBacklog({ text: "task", persona: "elite" }, T0);
	const taken = transition([e], e.id, "taken");
	assert.equal(taken.ok, true);
	assert.equal(taken.entries[0]?.state, "taken");
	const done = transition(taken.entries, e.id, "done", "shipped");
	assert.equal(done.entries[0]?.state, "done");
	assert.equal(done.entries[0]?.note, "shipped");
	const miss = transition(done.entries, "nope", "done");
	assert.equal(miss.ok, false);
});

test("openItems returns open + taken (work not finished), not done/dropped", () => {
	const a = makeBacklog({ text: "a" }, T0);
	const b = { ...makeBacklog({ text: "b" }, T0), state: "taken" as const };
	const c = { ...makeBacklog({ text: "c" }, T0), state: "done" as const };
	const d = { ...makeBacklog({ text: "d" }, T0), state: "dropped" as const };
	assert.deepEqual(
		openItems([a, b, c, d]).map((e) => e.text).sort(),
		["a", "b"],
	);
});

test("viewFor filters to the persona by default, but all:true shows everything", () => {
	const mine = makeBacklog({ text: "mine", persona: "elite" }, T0);
	const other = makeBacklog({ text: "other", persona: "dev" }, T0);
	assert.deepEqual(
		viewFor([mine, other], "elite", false).map((e) => e.text),
		["mine"],
	);
	assert.equal(viewFor([mine, other], "elite", true).length, 2);
});

test("validateBacklog accepts good entries and rejects junk", () => {
	const good = makeBacklog({ text: "x", persona: "p" }, T0);
	assert.deepEqual(validateBacklog(JSON.parse(JSON.stringify(good))), good);
	assert.equal(validateBacklog({ id: "x", text: "y", state: "bogus" }), null);
	assert.equal(validateBacklog(null), null);
});
