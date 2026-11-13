import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MindService } from "../src/core/service.ts";
import { resolveScope } from "../src/core/scope.ts";
import { createSessionMemory } from "../src/session-memory.ts";
import { registerMemoryTool } from "../src/tools/memory.ts";
import { loadInspectorPage } from "../src/extension/inspector-data.ts";

test("native remember receipt opens its exact recording without store writes or foreign-owner links", async () => {
	const root = await mkdtemp(join(tmpdir(), "mind-inspector-native-"));
	try {
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const manager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager: manager } as unknown as ExtensionContext;
		const mind = new MindService(resolveScope(agentDir, cwd, { persona: "dev" }));
		const session = createSessionMemory({ appendEntry: (type, data) => { manager.appendCustomEntry(type, data); } });
		session.activate(ctx);
		let execute: (...args: unknown[]) => Promise<{ content: unknown[]; details: unknown }> = async () => { throw new Error("tool not registered"); };
		registerMemoryTool({ registerTool: (tool: { execute: typeof execute }) => { execute = tool.execute; } } as never, () => mind, session);
		const args = { action: "remember", term: "long", scope: "persona", kind: "invariant", text: "Native inspector exact source sentinel", tags: ["trace"] };
		const callId = "native-call";
		const assistantId = manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: callId, name: "memory", arguments: args }], timestamp: Date.now() } as never);
		const result = await execute(callId, args, undefined, undefined, ctx);
		assert.equal((result.details as { ok: boolean }).ok, true);
		const resultId = manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "memory", content: result.content, details: result.details, isError: false, timestamp: Date.now() } as never);
		const bytes = async () => {
			const names = (await readdir(agentDir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
			return Promise.all(names.map(async (path) => [path, (await readFile(path)).toString("base64")]));
		};
		const before = await bytes();
		const entriesBefore = manager.getEntries().length;
		const page = await loadInspectorPage(ctx, mind, session, { tab: "memories", scope: "persona", query: "", offset: 0 });
		assert.equal(page.items.length, 1);
		assert.ok(page.items[0]!.source, page.items[0]!.body);
		const source = page.items[0]!.source!.body;
		assert.ok(source.includes(assistantId));
		assert.ok(source.includes(resultId));
		assert.ok(source.includes(args.text));
		assert.match(source, /not proof|not.*truth/i);
		assert.deepEqual(await bytes(), before, "read-only inspection leaves every existing store byte unchanged");
		assert.equal(manager.getEntries().length, entriesBefore, "inspection adds no native entry");

		const foreign = new MindService(resolveScope(agentDir, cwd, { persona: "reviewer" }));
		assert.equal((await foreign.remember({ term: "long", scope: "persona", kind: "invariant", text: args.text, tags: args.tags })).ok, true);
		const foreignPage = await loadInspectorPage(ctx, foreign, session, { tab: "memories", scope: "persona", query: "", offset: 0 });
		assert.equal(foreignPage.items.length, 1);
		assert.equal(foreignPage.items[0]!.source, undefined, "same content ID does not authorize another persona's recording link");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
