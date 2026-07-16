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
	const result = (await before({ systemPrompt: "BASE PROMPT" }, ctx)) as { systemPrompt?: string } | undefined;
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
	const result = await before({ systemPrompt: "BASE" }, ctxFor(join(dir, "empty", "proj")));
	assert.equal(result, undefined, "no memory ⇒ prompt untouched");
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
