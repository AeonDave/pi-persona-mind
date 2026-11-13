import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMemoryInspector } from "../src/extension/memory-inspector.ts";

const request = { tab: "context", scope: "session", query: "", offset: 0 } as const;
const empty = { items: [], total: 0, offset: 0, notice: "read only" };
function fixture() {
	let current = true;
	let denied: string | undefined;
	let loads = 0;
	let shown = 0;
	const notices: string[] = [];
	const ctx = { mode: "tui", hasUI: true, ui: { notify: (s: string) => notices.push(s) } } as unknown as ExtensionContext;
	let screen: Parameters<Parameters<typeof createMemoryInspector>[0]["show"]>[1] | undefined;
	const inspector = createMemoryInspector({
		unavailableReason: () => denied,
		captureOwner: () => () => current,
		load: async () => { loads++; return empty; },
		show: async (_ctx, options) => { shown++; screen = options; },
	});
	return { ctx, inspector, notices, screen: () => screen!, loads: () => loads, shown: () => shown, revoke: () => { current = false; }, deny: () => { denied = "Persona unavailable"; } };
}

test("inspector context is the last prepared block, not a recomputed or provider claim", async () => {
	const f = fixture();
	await f.inspector.open(f.ctx, "context");
	assert.match((await f.screen().load(request)).notice, /no.*prepared/i);
	f.inspector.recordContext(f.ctx, "<persona-mind>exact prepared text</persona-mind>");
	await f.inspector.open(f.ctx, "context");
	const page = await f.screen().load(request);
	assert.equal(page.items.length, 1);
	assert.match(page.items[0]!.body, /<persona-mind>exact prepared text<\/persona-mind>/);
	assert.match(page.notice, /not.*provider/i);
	assert.equal(f.loads(), 0, "context does not reread stores or rebuild ranking");
});

test("inspector refuses headless and unavailable contexts without loading stores", async () => {
	const f = fixture();
	await f.inspector.open({ ...f.ctx, mode: "rpc" }, "memories");
	assert.equal(f.shown(), 0);
	f.deny();
	await f.inspector.open(f.ctx);
	assert.equal(f.shown(), 0);
	assert.equal(f.loads(), 0);
	assert.match(f.notices.join("\n"), /TUI|terminal/);
	assert.match(f.notices.join("\n"), /Persona unavailable/);
});

test("revoked owner cannot load a source or retain prepared context", async () => {
	const f = fixture();
	f.inspector.recordContext(f.ctx, "private previous owner");
	await f.inspector.open(f.ctx);
	const old = f.screen();
	f.revoke();
	assert.equal(old.isCurrent(), false);
	await assert.rejects(old.load({ ...request, tab: "memories" }), /owner|session/i);
	assert.equal(f.loads(), 0);
});

test("lifecycle invalidation aborts open screen and clears the prepared context", async () => {
	let screen: Parameters<Parameters<typeof createMemoryInspector>[0]["show"]>[1] | undefined;
	let resolveShow: (() => void) | undefined;
	const ctx = fixture().ctx;
	const inspector = createMemoryInspector({ unavailableReason: () => undefined, captureOwner: () => () => true, load: async () => empty,
		show: async (_ctx, options) => { screen = options; await new Promise<void>((resolve) => { resolveShow = resolve; options.signal.addEventListener("abort", () => resolve(), { once: true }); }); },
	});
	inspector.recordContext(ctx, "old branch");
	const opened = inspector.open(ctx);
	assert.ok(screen);
	inspector.invalidate();
	assert.equal(screen.signal.aborted, true);
	assert.equal(screen.isCurrent(), false);
	await opened;
	const next = inspector.open(ctx, "context");
	assert.match((await screen.load(request)).notice, /no.*prepared/i);
	resolveShow!();
	await next;
});

test("a context prepared across branch invalidation cannot become the new branch snapshot", async () => {
	const f = fixture();
	const accepting = f.inspector.captureContext(f.ctx);
	f.inspector.invalidate();
	f.inspector.recordContext(f.ctx, "stale branch content", accepting);
	await f.inspector.open(f.ctx, "context");
	assert.match((await f.screen().load(request)).notice, /no.*prepared/i);
});

test("late async data is rejected after owner revocation", async () => {
	const f = fixture();
	let settle: ((value: typeof empty) => void) | undefined;
	let screen: Parameters<Parameters<typeof createMemoryInspector>[0]["show"]>[1] | undefined;
	const inspector = createMemoryInspector({ unavailableReason: () => undefined, captureOwner: () => () => !revoked,
		load: async () => new Promise<typeof empty>((resolve) => { settle = resolve; }), show: async (_ctx, options) => { screen = options; },
	});
	let revoked = false;
	await inspector.open(f.ctx);
	const pending = screen!.load({ ...request, tab: "memories" });
	revoked = true;
	settle!(empty);
	await assert.rejects(pending, /owner|session/i);
});
