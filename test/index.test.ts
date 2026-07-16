import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createExtension } from "../src/index.ts";

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

test("before_agent_start injects nothing when the mind is empty", async () => {
	const m = mockPi();
	createExtension(m.pi, { agentDir: join(dir, "empty", "agent") });
	const before = m.handlers.get("before_agent_start");
	assert.ok(before);
	const result = await before({ systemPrompt: "BASE", prompt: "hi" }, ctxFor(join(dir, "empty", "proj")));
	assert.equal(result, undefined, "no memory ⇒ prompt untouched");
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
	await before({ systemPrompt: "BASE", prompt: "From now on, always use verbose recon logs." }, ctx);
	assert.ok(status.some((s) => /worth remembering/.test(s)), "the nudge was surfaced");
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
