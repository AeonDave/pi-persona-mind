import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createExtension, ownerIsStale } from "../src/index.ts";

// A minimal ExtensionAPI stand-in that records what the factory wires up and lets tests drive it.
interface ToolLike {
	name: string;
	execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;

function mockPi() {
	const tools = new Map<string, ToolLike>();
	const commands = new Map<string, unknown>();
	const handlers = new Map<string, Handler>();
	const messages: string[] = [];
	const pi = {
		registerTool: (t: ToolLike) => tools.set(t.name, t),
		registerCommand: (name: string, def: unknown) => commands.set(name, def),
		registerShortcut: () => {},
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		sendUserMessage: (text: string) => messages.push(text),
	};
	return { pi: pi as never, tools, commands, handlers, messages };
}

function ctxFor(cwd: string) {
	return { cwd, mode: "tui", hasUI: true, ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c: string, s: string) => s } } };
}

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "ppm-idx-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("createExtension registers the memory + backlog tools, /mind command, and lifecycle hooks", () => {
	const m = mockPi();
	createExtension(m.pi, { agentDir: join(dir, "reg", "agent") });
	assert.ok(m.tools.has("memory"));
	assert.ok(m.tools.has("backlog"));
	assert.ok(m.commands.has("mind"));
	for (const ev of ["before_agent_start", "session_start", "session_shutdown"]) {
		assert.ok(m.handlers.has(ev), `handler for ${ev}`);
	}
});

test("a remembered fact is injected into the next turn's system prompt", async () => {
	const m = mockPi();
	const agentDir = join(dir, "inject", "agent");
	createExtension(m.pi, { agentDir });
	const cwd = join(dir, "inject", "proj");
	const ctx = ctxFor(cwd);

	const memory = m.tools.get("memory");
	assert.ok(memory);
	const stored = await memory.execute("t1", { action: "remember", term: "long", kind: "preference", text: "prefers verbose recon" }, undefined, undefined, ctx);
	assert.equal(stored.details.ok, true);

	const before = m.handlers.get("before_agent_start");
	assert.ok(before);
	const result = (await before({ systemPrompt: "BASE PROMPT", prompt: "carry on" }, ctx)) as { systemPrompt?: string } | undefined;
	assert.ok(result?.systemPrompt, "the turn's system prompt was augmented");
	assert.match(result.systemPrompt, /BASE PROMPT/);
	assert.match(result.systemPrompt, /<persona-mind/);
	assert.match(result.systemPrompt, /prefers verbose recon/);
});

test("an EMPTY supervisor mind injects one soft discoverability line (an unseen faculty is unused)", async () => {
	const m = mockPi();
	createExtension(m.pi, { agentDir: join(dir, "empty", "agent") });
	const before = m.handlers.get("before_agent_start");
	assert.ok(before);
	const result = await before({ systemPrompt: "BASE", prompt: "hi" }, ctxFor(join(dir, "empty", "proj")));
	assert.ok(result, "an empty supervisor mind is now discoverable, not silent");
	const sp = (result as { systemPrompt: string }).systemPrompt;
	assert.match(sp, /^BASE\n\n/);
	assert.match(sp, /this mind is empty/);
	assert.match(sp, /otherwise ignore this line/); // optional, never obligatory
	// Announced ONCE per session: a second turn with the mind still empty does NOT re-show the line.
	const again = (await before({ systemPrompt: "BASE", prompt: "still here" }, ctxFor(join(dir, "empty", "proj")))) as { systemPrompt?: string } | undefined;
	assert.doesNotMatch(again?.systemPrompt ?? "", /this mind is empty/);
});

test("a memory whose TEXT quotes the empty-hint phrase is NOT mistaken for the announcement (no suppression)", async () => {
	// Regression: the announcement is matched by PREFIX, not by a substring of the block. A substring
	// check would see "this mind is empty" inside a real memory and suppress the whole content block on
	// later turns — silent memory loss from injection.
	const m = mockPi();
	createExtension(m.pi, { agentDir: join(dir, "collision", "agent") });
	const ctx = ctxFor(join(dir, "collision", "proj"));
	await m.tools.get("memory")?.execute("t1", { action: "remember", term: "long", kind: "note", text: "we discussed that this mind is empty as a discoverability phrase" }, undefined, undefined, ctx);
	const before = m.handlers.get("before_agent_start");
	assert.ok(before);
	// The content block must inject on BOTH turns — not suppressed on the second.
	for (const prompt of ["hi", "again"]) {
		const r = (await before({ systemPrompt: "BASE", prompt }, ctx)) as { systemPrompt?: string } | undefined;
		const sp = r?.systemPrompt;
		assert.ok(sp, `content block injected on '${prompt}'`);
		assert.match(sp, /<persona-mind persona=/);
		assert.match(sp, /as a discoverability phrase/);
	}
});

test("a backlog item due while offline is delivered on session_start", async () => {
	const m = mockPi();
	const agentDir = join(dir, "wakes", "agent");
	createExtension(m.pi, { agentDir });
	const ctx = ctxFor(join(dir, "wakes", "proj"));
	const backlog = m.tools.get("backlog");
	assert.ok(backlog);
	await backlog.execute("t1", { action: "add", text: "re-check the share", dueInSeconds: -60 }, undefined, undefined, ctx);
	const start = m.handlers.get("session_start");
	assert.ok(start);
	await start({}, ctx);
	assert.ok(
		m.messages.some((t) => /came due while you were away/.test(t) && /re-check the share/.test(t)),
		"the missed wake was delivered, not dropped",
	);
});

test("only the elected owner session delivers a missed wake (no double-fire)", async () => {
	const agentDir = join(dir, "owner", "agent");
	const cwd = join(dir, "owner", "proj");
	const a = mockPi();
	createExtension(a.pi, { agentDir });
	const ctxA = ctxFor(cwd);
	await a.tools.get("backlog")?.execute("t1", { action: "add", text: "shared lead", dueInSeconds: -60 }, undefined, undefined, ctxA);
	const b = mockPi();
	createExtension(b.pi, { agentDir });
	const ctxB = ctxFor(cwd);
	await a.handlers.get("session_start")?.({}, ctxA);
	await b.handlers.get("session_start")?.({}, ctxB);
	const delivered = a.messages.filter((t) => /came due/.test(t)).length + b.messages.filter((t) => /came due/.test(t)).length;
	assert.equal(delivered, 1, "exactly one session delivered the missed wake");
});

test("a durable-preference user message raises the capture nudge on the status line", async () => {
	const m = mockPi();
	const status: string[] = [];
	createExtension(m.pi, { agentDir: join(dir, "nudge", "agent") });
	const ctx = { cwd: join(dir, "nudge", "proj"), mode: "tui", hasUI: true, ui: { setStatus: (_k: string, v: string) => status.push(v), notify: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const before = m.handlers.get("before_agent_start");
	assert.ok(before);
	const result = await before({ systemPrompt: "BASE", prompt: "From now on, always use verbose recon logs." }, ctx);
	assert.ok(status.some((s) => /worth remembering/.test(s)), "the status nudge was surfaced");
	// A STRONG cue ("from now on") ALSO lands a soft, optional hint in the prompt — the model can't read
	// the status line — so capture is actually reachable, without forcing it.
	assert.ok(result, "a strong cue injects a prompt hint");
	const sp = (result as { systemPrompt: string }).systemPrompt;
	assert.match(sp, /reads like a durable/);
	assert.match(sp, /optional, your call/);
	// Hinted ONCE: the same snippet next turn does NOT re-inject the cue (no per-turn nag).
	const again = (await before({ systemPrompt: "BASE", prompt: "From now on, always use verbose recon logs." }, ctx)) as { systemPrompt?: string } | undefined;
	assert.doesNotMatch(again?.systemPrompt ?? "", /reads like a durable/);
});

test("a SOFT cue (casual 'I prefer') stays status-only — no hint pushed into the model's context", async () => {
	const m = mockPi();
	const status: string[] = [];
	createExtension(m.pi, { agentDir: join(dir, "soft", "agent") });
	const ctx = { cwd: join(dir, "soft", "proj"), mode: "tui", hasUI: true, ui: { setStatus: (_k: string, v: string) => status.push(v), notify: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const before = m.handlers.get("before_agent_start");
	assert.ok(before);
	const result = (await before({ systemPrompt: "BASE", prompt: "I prefer tabs over spaces." }, ctx)) as { systemPrompt?: string } | undefined;
	assert.ok(status.some((s) => /worth remembering/.test(s)), "soft cue still gets the gentle status nudge");
	assert.doesNotMatch(result?.systemPrompt ?? "", /reads like a durable/); // but never the prompt hint
});

test("a delegated worker leg (PI_PERSONA_CHILD) withholds tools + wakes and injects only the lean mind", async () => {
	const agentDir = join(dir, "leg", "agent");
	const cwd = join(dir, "leg", "proj");

	// The supervisor seeds its mind: north-star + identity (LTM), working-context (STM), and a due backlog.
	const sup = mockPi();
	createExtension(sup.pi, { agentDir });
	const supCtx = ctxFor(cwd);
	await sup.tools.get("memory")?.execute("t1", { action: "remember", term: "long", kind: "objective", text: "root every box on the range" }, undefined, undefined, supCtx);
	await sup.tools.get("memory")?.execute("t2", { action: "remember", term: "long", kind: "preference", text: "prefers verbose recon" }, undefined, undefined, supCtx);
	await sup.tools.get("memory")?.execute("t3", { action: "remember", term: "short", kind: "note", text: "prod db is read-only right now" }, undefined, undefined, supCtx);
	await sup.tools.get("backlog")?.execute("t4", { action: "add", text: "revisit the SMB share", dueInSeconds: -60 }, undefined, undefined, supCtx);

	// A delegated leg — the flag is sampled at factory time, so set it only around createExtension.
	const prev = process.env.PI_PERSONA_CHILD;
	process.env.PI_PERSONA_CHILD = "1";
	const leg = mockPi();
	try {
		createExtension(leg.pi, { agentDir });
	} finally {
		if (prev === undefined) delete process.env.PI_PERSONA_CHILD;
		else process.env.PI_PERSONA_CHILD = prev;
	}

	// No write tools in a worker — it cannot read/mutate the supervisor persona's stores.
	assert.equal(leg.tools.has("memory"), false, "a leg registers no memory tool");
	assert.equal(leg.tools.has("backlog"), false, "a leg registers no backlog tool");

	// Lean injection: it inherits the north-star + identity but NOT the supervisor's project state.
	const before = leg.handlers.get("before_agent_start");
	assert.ok(before);
	const res = (await before({ systemPrompt: "BASE", prompt: "do the assigned task" }, ctxFor(cwd))) as { systemPrompt?: string } | undefined;
	assert.ok(res?.systemPrompt, "the leg inherits a lean mind block");
	assert.match(res.systemPrompt, /root every box/, "leg inherits the north-star");
	assert.match(res.systemPrompt, /verbose recon/, "leg inherits durable identity");
	assert.doesNotMatch(res.systemPrompt, /prod db is read-only/, "leg does NOT inherit working context");
	assert.doesNotMatch(res.systemPrompt, /revisit the SMB share/, "leg does NOT inherit the backlog");

	// A worker never arms/fires the supervisor's backlog wakes.
	await leg.handlers.get("session_start")?.({}, ctxFor(cwd));
	assert.equal(leg.messages.filter((t) => /came due/.test(t)).length, 0, "a leg fires no backlog wakes");
});

test("PI_PERSONA_LEG marks a delegated leg — the mind withholds its write tools", () => {
	const prev = process.env.PI_PERSONA_LEG;
	process.env.PI_PERSONA_LEG = "1";
	const leg = mockPi();
	try {
		createExtension(leg.pi, { agentDir: join(dir, "legmarker", "agent") });
	} finally {
		if (prev === undefined) delete process.env.PI_PERSONA_LEG;
		else process.env.PI_PERSONA_LEG = prev;
	}
	assert.equal(leg.tools.has("memory"), false, "a PI_PERSONA_LEG leg registers no memory tool");
	assert.equal(leg.tools.has("backlog"), false, "a PI_PERSONA_LEG leg registers no backlog tool");
});

test("PI_PERSONA_DISABLE alone (a user kill switch, no leg marker) is NOT a leg — the mind runs full", () => {
	const prevDisable = process.env.PI_PERSONA_DISABLE;
	const prevLeg = process.env.PI_PERSONA_LEG;
	const prevChild = process.env.PI_PERSONA_CHILD;
	process.env.PI_PERSONA_DISABLE = "1"; // pi-persona's kill switch — NOT a delegation marker
	delete process.env.PI_PERSONA_LEG;
	delete process.env.PI_PERSONA_CHILD;
	const sup = mockPi();
	try {
		createExtension(sup.pi, { agentDir: join(dir, "killswitch", "agent") });
	} finally {
		if (prevDisable === undefined) delete process.env.PI_PERSONA_DISABLE;
		else process.env.PI_PERSONA_DISABLE = prevDisable;
		if (prevLeg === undefined) delete process.env.PI_PERSONA_LEG;
		else process.env.PI_PERSONA_LEG = prevLeg;
		if (prevChild === undefined) delete process.env.PI_PERSONA_CHILD;
		else process.env.PI_PERSONA_CHILD = prevChild;
	}
	assert.equal(sup.tools.has("memory"), true, "a user who disabled pi-persona still gets the mind's tools (standalone)");
	assert.equal(sup.tools.has("backlog"), true, "backlog tool present for a kill-switch supervisor too");
});

test("a blocked delegated leg surfaces a backlog nudge on both delivery paths", async () => {
	const m = mockPi();
	const status: string[] = [];
	createExtension(m.pi, { agentDir: join(dir, "blocked", "agent") });
	const ctx = { cwd: join(dir, "blocked", "proj"), mode: "tui", hasUI: true, ui: { setStatus: (_k: string, v: string) => status.push(v), notify: () => {}, theme: { fg: (_c: string, s: string) => s } } };

	// SYNC path: a delegate tool_result whose report carries a BLOCKED marker.
	const onResult = m.handlers.get("tool_result");
	assert.ok(onResult, "a tool_result handler is registered");
	onResult({ toolName: "delegate", content: [{ type: "text", text: "leg 1: [BLOCKED: need creds]" }] }, ctx);
	assert.ok(status.some((s) => /backlog add/.test(s)), "a sync blocked leg nudges a backlog capture");

	// ASYNC path: the background completion report arrives as a follow-up user message (event.prompt).
	status.length = 0;
	const before = m.handlers.get("before_agent_start");
	assert.ok(before);
	await before({ systemPrompt: "BASE", prompt: "[pi-persona] 1 async run settled. leg reported [BLOCKED: dead end]" }, ctx);
	assert.ok(status.some((s) => /backlog add/.test(s)), "an async blocked report nudges a backlog capture");

	// A NON-delegation tool result with the same marker is ignored (only delegate/council report legs).
	status.length = 0;
	onResult({ toolName: "read", content: [{ type: "text", text: "the file literally contains [BLOCKED: x]" }] }, ctx);
	assert.equal(status.length, 0, "a non-delegation tool result never nudges");
});

test("ownerIsStale protects a live local wake-owner and reclaims a dead one", () => {
	const lock = join(dir, "owner.lock");
	writeFileSync(lock, `${hostname()}:${process.pid}:7`, "utf8"); // us — an alive local owner
	const old = new Date(Date.now() - 5 * 60_000);
	utimesSync(lock, old, old); // even 5 minutes old — well past OWNER_STALE_MS
	assert.equal(ownerIsStale(lock, "someone:1:1"), false, "a live local owner is never time-stolen (no >120s double-fire)");
	writeFileSync(lock, `${hostname()}:999999:1`, "utf8"); // a dead pid
	assert.equal(ownerIsStale(lock, "someone:1:1"), true, "a dead local owner is reclaimable");
});

test("an armed wake does not fire for a backlog item dropped before it comes due", async () => {
	const m = mockPi();
	const agentDir = join(dir, "stalefire", "agent");
	createExtension(m.pi, { agentDir });
	const ctx = ctxFor(join(dir, "stalefire", "proj"));
	const backlog = m.tools.get("backlog");
	assert.ok(backlog);
	const add = await backlog.execute("t1", { action: "add", text: "ping CI", dueInSeconds: 0.2 }, undefined, undefined, ctx);
	const id = (add.details as { id?: string }).id;
	assert.ok(id, "the add returned an id");
	await m.handlers.get("session_start")?.({}, ctx); // arms the ~200ms timer
	await backlog.execute("t2", { action: "drop", id }, undefined, undefined, ctx); // close it before it fires
	await new Promise((r) => setTimeout(r, 400)); // let the timer elapse
	assert.ok(!m.messages.some((t) => /backlog due/.test(t) && /ping CI/.test(t)), "no stale wake fired for a dropped item");
});

test("the backlog tool queues and lists an item through the Pi surface", async () => {
	const m = mockPi();
	createExtension(m.pi, { agentDir: join(dir, "bl", "agent") });
	const ctx = ctxFor(join(dir, "bl", "proj"));
	const backlog = m.tools.get("backlog");
	assert.ok(backlog);
	const add = await backlog.execute("t1", { action: "add", text: "revisit the SMB share" }, undefined, undefined, ctx);
	assert.equal(add.details.ok, true);
	const list = await backlog.execute("t2", { action: "list" }, undefined, undefined, ctx);
	assert.match(list.content[0]?.text ?? "", /revisit the SMB share/);
});
