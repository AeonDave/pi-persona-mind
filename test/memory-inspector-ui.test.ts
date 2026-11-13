import assert from "node:assert/strict";
import { test } from "node:test";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import type { InspectorPage, InspectorRequest } from "../src/extension/inspector-data.ts";
import { createMemoryInspectorComponent, memoryInspectorViewportRows, openMemoryInspector } from "../src/ui/memory-inspector.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
function harness(load: (request: InspectorRequest) => Promise<InspectorPage>, isCurrent = () => true, signal?: AbortSignal, renderTheme = theme, bindings?: { getKeys(action: string): string[]; matches(data: string, action: string): boolean }) {
  let doneCount = 0;
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  const kb = { getKeys: (action: string) => ({ "tui.select.up": ["up"], "tui.select.down": ["down"], "tui.select.confirm": ["enter"], "tui.select.cancel": ["escape"], "tui.select.pageUp": ["pageUp"], "tui.select.pageDown": ["pageDown"] }[action] ?? []), matches: (data: string, action: string) => ({
    "tui.select.up": data === "UP", "tui.select.down": data === "DOWN",
    "tui.select.confirm": data === "ENTER", "tui.select.cancel": data === "ESC",
    "tui.select.pageUp": data === "PGUP", "tui.select.pageDown": data === "PGDN",
    "tui.altScreen.pageUp": data === "ALT_PGUP", "tui.altScreen.pageDown": data === "ALT_PGDN",
  }[action] ?? false) };
  const component = createMemoryInspectorComponent(tui as never, renderTheme as never, (bindings ?? kb) as never, () => { doneCount++; }, { load, isCurrent, ...(signal ? { signal } : {}) });
  return { component, doneCount: () => doneCount, key: (s: string) => component.handleInput(s), resize: (rows: number) => { tui.terminal.rows = rows; }, render: (w = 80, rows?: number) => component.render(w, rows).join("\n") };
}
const page = (items: InspectorPage["items"], offset = 0, nextOffset?: number): InspectorPage => ({ items, total: 0, offset, ...(nextOffset === undefined ? {} : { nextOffset }), notice: "" });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("cycles tabs, lists items, and opens then restores read-only detail", async () => {
  const requests: InspectorRequest[] = [];
  const h = harness(async (r) => { requests.push(r); return page([{ id: "a", title: "Alpha", body: "full body" }]); });
  await tick();
  assert.match(h.render(), /Memories/);
  h.key("\t"); await tick();
  assert.equal(requests.at(-1)?.tab, "context");
  h.key("ENTER");
  assert.match(h.render(), /full body/);
  h.key("ESC");
  assert.match(h.render(), /Alpha/);
});

test("source navigation, control/ANSI sanitization, and Unicode width are safe", async () => {
  const h = harness(async () => page([{ id: "x", title: "\u001b]0;spoof\u0007界Title", body: "\u001b[31mbody\u001b[0m", source: { title: "Origin", body: "source detail" } }]));
  await tick();
  assert.match(h.render(), /\[source\]/);
  h.key("s");
  assert.match(h.render(), /source detail/);
  assert.doesNotMatch(h.render(), /spoof|\u001b/);
  for (const width of [1, 2, 5, 12, 40]) for (const line of h.component.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
});

test("ignores stale out-of-order responses and closes on revoked lifecycle", async () => {
  let current = true;
  const pending: ((value: InspectorPage) => void)[] = [];
  const h = harness(() => new Promise((resolve) => pending.push(resolve)), () => current);
  h.key("\t");
  pending[1]?.(page([{ id: "new", title: "New", body: "new" }])); await tick();
  pending[0]?.(page([{ id: "old", title: "Old", body: "old" }])); await tick();
  assert.match(h.render(), /New/); assert.doesNotMatch(h.render(), /Old/);
  current = false;
  assert.equal(h.component.render(50).length, 0);
  assert.equal(h.doneCount(), 1);
});

test("abort signal closes promptly and is safe when already aborted", async () => {
  const controller = new AbortController();
  const h = harness(async () => page([]), () => true, controller.signal);
  controller.abort();
  assert.equal(h.doneCount(), 1);
  assert.equal(h.component.render(40).length, 0);
});

test("timeline search is sent and a long list keeps the selected row in its viewport", async () => {
  const seen: InspectorRequest[] = [];
  const items = Array.from({ length: 40 }, (_, i) => ({ id: String(i), title: `row-${i}`, body: `body-${i}` }));
  const h = harness(async (r) => { seen.push(r); return page(items, r.offset, 40); });
  await tick();
  h.key("\t"); await tick(); h.key("\t"); await tick();
  h.key("/"); h.key("l"); h.key("o"); h.key("g"); h.key("ENTER"); await tick();
  assert.equal(seen.at(-1)?.tab, "timeline");
  assert.equal(seen.at(-1)?.query, "log");
  for (let i = 0; i < 35; i++) h.key("DOWN");
  const output = h.render(80, 10);
  assert.match(output, /row-35/);
  assert.doesNotMatch(output, /row-0/);
  assert.equal(output.split("\n").length <= 10, true);
  for (const rows of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    h.resize(rows);
    assert.ok(h.component.render(80).length <= rows);
    assert.match(h.render(80), /row-35/, `selected row remains visible at ${rows} rows`);
  }
});

test("detail to source to detail preserves independent scroll positions", async () => {
  const lines = (prefix: string) => Array.from({ length: 30 }, (_, i) => `${prefix}-${i}`).join("\n");
  const h = harness(async () => page([{ id: "scroll", title: "Row", body: lines("detail"), source: { title: "Origin", body: lines("source") } }]));
  await tick(); h.key("ENTER");
  const initial = h.render(18, 7);
  h.key("DOWN");
  const afterScroll = h.render(18, 7);
  assert.notEqual(afterScroll, initial);
  h.key("s");
  assert.match(h.render(18, 7), /source-/);
  h.key("DOWN"); h.key("ESC");
  assert.equal(h.render(18, 7), afterScroll, "returning from source restores detail's saved viewport");
});

test("dispose removes the lifecycle abort listener", () => {
  let removed = false;
  const signal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() { removed = true; },
  } as unknown as AbortSignal;
  const h = harness(async () => page([]), () => true, signal);
  h.component.dispose();
  assert.equal(removed, true);
});

test("search and memory scope changes issue bounded read requests", async () => {
  const seen: InspectorRequest[] = [];
  const h = harness(async (r) => { seen.push(r); return page([]); });
  await tick();
  h.key("/"); h.key("f"); h.key("o"); h.key("o"); h.key("ENTER"); await tick();
  assert.equal(seen.at(-1)?.query, "foo");
  h.key("\u001b[C"); await tick();
  assert.equal(seen.at(-1)?.scope, "project");
  assert.equal(seen.at(-1)?.query, "foo");
});

test("pagination uses next offsets and back restores previous request", async () => {
  const seen: InspectorRequest[] = [];
  const h = harness(async (r) => { seen.push(r); return r.offset === 0 ? page([], 0, 40) : page([], 40); });
  await tick(); h.key("n"); await tick();
  assert.equal(seen.at(-1)?.offset, 40);
  h.key("p"); await tick();
  assert.equal(seen.at(-1)?.offset, 0);
});

test("short final page status reports range without a misleading derived page number", async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 80), title: `row-${i + 80}`, body: "body" }));
  const h = harness(async () => ({ ...page(items, 80), total: 90 }));
  await tick();
  assert.match(h.render(80, 12), /81-90 of 90/);
  assert.doesNotMatch(h.render(80, 12), /p9/);
});

test("Focusable state forwards to search Input and viewport page keys are captured", async () => {
  const h = harness(async () => page([{ id: "scroll", title: "Row", body: Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n") }]));
  await tick();
  h.component.focused = true;
  h.key("/");
  assert.equal(h.component.focused, true);
  assert.equal((h.component as unknown as { searchInput: { focused: boolean } }).searchInput.focused, true);
  assert.equal((h.component as unknown as { capturesViewportInput?: boolean }).capturesViewportInput, true);
  h.key("ESC");
  h.component.focused = false;
  assert.equal(h.component.focused, false);
  h.key("ENTER");
  const initial = h.render(40, 8);
  h.key("ALT_PGDN");
  assert.notEqual(h.render(40, 8), initial, "fullscreen PageDown reaches the inspector scroll handler");
});

test("list status shows counts, empty state, flattened notice and detailed coverage help", async () => {
  const notice = "Coverage is limited\nsecond line with complete explanation";
  const h = harness(async () => ({ ...page([]), total: 3, notice }));
  await tick();
  const output = h.render(80, 12);
  assert.match(output, /0 of 3/);
  assert.match(output, /No items/);
  assert.match(output, /Coverage notice/);
  assert.doesNotMatch(output, /second line/);
  h.key("?");
  let help = h.render(80, 12);
  for (let i = 0; i < 4; i++) { h.key("PGDN"); help += h.render(80, 12); }
  assert.match(help, /second line with complete explanation/);
});

test("search appears on timeline; context ignores slash and tab switches clear query", async () => {
  const seen: InspectorRequest[] = [];
  const h = harness(async (r) => { seen.push(r); return page([]); });
  await tick();
  h.key("/"); for (const c of "needle") h.key(c); h.key("ENTER"); await tick();
  h.key("\t"); await tick();
  assert.equal(seen.at(-1)?.query, "");
  h.key("/");
  assert.doesNotMatch(h.render(), /Enter search/);
  h.key("\t"); await tick();
  assert.equal(seen.at(-1)?.tab, "timeline");
  assert.equal(seen.at(-1)?.query, "");
  assert.match(h.render(), /Search: none/);
});

test("empty-list movement remains safe and detail exposes missing source", async () => {
  const h = harness(async () => page([{ id: "x", title: "Row", body: "Full record details" }]));
  await tick();
  h.key("UP"); h.key("PGDN");
  h.key("ENTER");
  assert.match(h.render(), /Source unavailable/);
  assert.match(h.render(), /Full record details/);
});

test("multiline titles flatten and overlay viewport height matches host maxHeight", async () => {
  const h = harness(async () => page([{ id: "x", title: "First\nSecond", body: "body" }]));
  await tick();
  assert.doesNotMatch(h.render(), /First\nSecond/);
  assert.match(h.render(), /First Second/);
  for (const terminalRows of [1, 2, 3, 24, 60]) {
    const viewportRows = memoryInspectorViewportRows(terminalRows);
    assert.equal(viewportRows, Math.max(1, Math.min(Math.floor(terminalRows * 0.9), terminalRows - 2)));
    assert.ok(viewportRows <= terminalRows);
  }
});

test("coverage help starts at the top and scrolls through the complete multiline notice", async () => {
  const notice = Array.from({ length: 100 }, (_, i) => `coverage detail ${i}`).join("\n");
  const longBody = Array.from({ length: 200 }, (_, i) => `record detail ${i}`).join("\n");
  const h = harness(async () => ({ ...page([{ id: "x", title: "Record", body: longBody }]), total: 100, notice }));
  await tick(); h.key("ENTER"); h.key("PGDN"); h.render(80, 24);
  h.key("ESC"); h.key("?");
  assert.match(h.render(80, 24), /Navigation:/);
  for (let i = 0; i < 6; i++) h.key("PGDN");
  assert.match(h.render(80, 24), /coverage detail 99/);
});

test("inspector frames every view like F9 and reserves space for borders and padding", async () => {
  const h = harness(async () => ({ ...page([{ id: "frame", title: "Readable fact", body: Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n"), source: { title: "Recording", body: "Source text" } }]), notice: "Coverage details" }));
  await tick();
  const assertFrame = () => {
    const rows = h.component.render(60, 12);
    assert.match(rows[0]!, /^┌─+┐$/);
    assert.match(rows.at(-1)!, /^└─+┘$/);
    assert.ok(rows.length <= 12);
    for (const row of rows) assert.equal(visibleWidth(row), 60);
    for (const row of rows.slice(1, -1)) assert.match(row, /^│ .* │$/);
  };
  assertFrame();
  h.key("ENTER"); assertFrame();
  for (let i = 0; i < 50; i++) h.key("DOWN");
  assert.match(h.render(60, 12), /line-49/);
  h.key("s"); assertFrame();
  h.key("ESC"); h.key("ESC"); h.key("?"); assertFrame();
});

test("F10 matches F9 content gutters and separates header, records and navigation", async () => {
  const h = harness(async () => ({ ...page([{ id: "spacing", title: "First record", body: "Full record text", source: { title: "Recorded source", body: "Original source text" } }]), total: 1, notice: "Bounded coverage" }));
  await tick();
  const blank = (line: string | undefined) => /^│ +│$/.test(line ?? "");
  const frame = () => {
    const rows = h.component.render(80, 24);
    for (const row of rows.slice(1, -1)) assert.match(row, /^│  .*  │$/, "F9 Text padding plus frame padding gives two-column gutters");
    for (const row of rows) assert.equal(visibleWidth(row), 80);
    assert.ok(rows.length <= 24);
    assert.ok(blank(rows[2]), "one blank row after the title, as in F9");
    return rows;
  };
  const list = frame();
  const f9Title = new Text("Memory inspector", 1, 0).render(76)[0]!;
  assert.equal(list[1], `│ ${f9Title}${" ".repeat(Math.max(0, 76 - visibleWidth(f9Title)))} │`, "same native Text + frame padding used by Persona F9");
  const selected = list.findIndex((row) => row.includes("▸ First record"));
  assert.ok(blank(list[selected - 1]), "separate the metadata header from records");
  const listFooter = list.findIndex((row) => row.includes("Tab / Shift+Tab tabs"));
  assert.ok(blank(list[listFooter - 1]), "separate records from navigation");
  for (const key of ["ENTER", "s", "?"]) {
    h.key(key);
    const rows = frame();
    const footer = rows.findIndex((row) => row.includes("Up/Down scroll"));
    assert.ok(blank(rows[footer - 1]), "detail, source and help keep a footer gutter");
  }
});

test("action payload tracks actual list/detail selection and is unavailable without a handler or on other tabs", async () => {
  const h = harness(async () => page([
    { id: "first-id", title: "First label", body: "first" },
    { id: "second-id", title: "Second label", body: "second" },
  ]));
  await tick();
  h.key("a");
  assert.equal(h.component.takeAction(), undefined, "handler-less inspector stays read-only");
  h.key("DOWN"); h.key("a");
  assert.equal(h.component.takeAction(), undefined);
  h.key("ENTER");
  const enabled = createMemoryInspectorComponent(
    { terminal: { rows: 24 }, requestRender() {} } as never, theme as never,
    { getKeys: (action: string) => ({ "tui.select.up": ["up"], "tui.select.down": ["down"], "tui.select.confirm": ["enter"], "tui.select.cancel": ["escape"] }[action] ?? []), matches: (data: string, action: string) => ({ "tui.select.up": data === "UP", "tui.select.down": data === "DOWN", "tui.select.confirm": data === "ENTER", "tui.select.cancel": data === "ESC" }[action] ?? false) } as never,
    () => {}, { load: async (request) => ({ ...page([{ id: "first-id", title: "First label", body: "first" }, { id: "second-id", title: "Second label", body: "second" }], request.offset, request.offset === 0 ? 20 : undefined) }), isCurrent: () => true, onAction: async () => {} },
  );
  await tick(); enabled.handleInput("/"); for (const char of "needle") enabled.handleInput(char); enabled.handleInput("ENTER"); await tick();
  enabled.handleInput("\u001b[C"); await tick(); enabled.handleInput("n"); await tick();
  enabled.handleInput("DOWN"); enabled.handleInput("a");
  assert.deepEqual(enabled.takeAction(), { tab: "memories", scope: "project", query: "needle", offset: 20, selectedId: "second-id" });
  const otherTab = createMemoryInspectorComponent(
    { terminal: { rows: 24 }, requestRender() {} } as never, theme as never,
    { getKeys: (action: string) => ({ "tui.select.up": ["up"], "tui.select.down": ["down"], "tui.select.confirm": ["enter"], "tui.select.cancel": ["escape"] }[action] ?? []), matches: (data: string, action: string) => ({ "tui.select.cancel": data === "ESC" }[action] ?? false) } as never,
    () => {}, { load: async (request) => page([{ id: "context-id", title: "Context row", body: "body" }]), isCurrent: () => true, initialTab: "context", onAction: async () => {} },
  );
  await tick(); otherTab.handleInput("a");
  assert.equal(otherTab.takeAction(), undefined, "context and timeline tabs never expose the mutation launcher");
  assert.match(otherTab.render(100, 12).join("\n"), /\? help/);
  otherTab.handleInput("?");
  assert.doesNotMatch(otherTab.render(100, 12).join("\n"), /a actions/);
  const detail = createMemoryInspectorComponent(
    { terminal: { rows: 24 }, requestRender() {} } as never, theme as never,
    { getKeys: (action: string) => ({ "tui.select.up": ["up"], "tui.select.down": ["down"], "tui.select.confirm": ["enter"], "tui.select.cancel": ["escape"] }[action] ?? []), matches: (data: string, action: string) => ({ "tui.select.confirm": data === "ENTER" }[action] ?? false) } as never,
    () => {}, { load: async () => page([{ id: "record-id", title: "Not the ID", body: "detail" }]), isCurrent: () => true, onAction: async () => {} },
  );
  await tick(); detail.handleInput("ENTER"); detail.handleInput("a");
  assert.deepEqual(detail.takeAction(), { tab: "memories", scope: "session", query: "", offset: 0, selectedId: "record-id" });
  enabled.dispose(); detail.dispose(); otherTab.dispose(); h.component.dispose();
});

test("theme accents header, active tab and selected row; metadata is dim and errors are errors", async () => {
  const calls: string[] = [];
  const spy = { bold: (text: string) => `BOLD(${text})`, fg: (name: string, text: string) => { calls.push(name); return `${name.toUpperCase()}(${text})`; } };
  const h = harness(async () => page([{ id: "one", title: "Selected", body: "body", source: { title: "Origin", body: "source" } }]), () => true, undefined, spy);
  await tick();
  const output = h.render(80, 14);
  assert.match(output, /ACCENT\(BOLD\(Memory inspector\)\)/);
  assert.match(output, /ACCENT\(.*Memories.*\)/);
  assert.match(output, /ACCENT\(▸ Selected/);
  assert.match(output, /DIM\(.*Up\/Down select/);
  assert.match(output, /ACCENT\(BOLD\(Session\)\)/, "active scope is accent and bold inside the full scope strip");
  assert.ok(output.includes("DIM(  [source])"));
  const missing = harness(async () => page([{ id: "missing", title: "Missing source", body: "record" }]), () => true, undefined, spy);
  await tick(); missing.key("ENTER");
  assert.match(missing.render(80, 12), /WARNING\(Source unavailable for this item\.\)/);
  const help = harness(async () => page([{ id: "help", title: "Help target", body: "body" }]), () => true, undefined, spy);
  await tick(); help.key("?");
  assert.match(help.render(80, 24), /DIM\(Navigation:/);
  const bad = harness(async () => { throw new Error("load failed"); }, () => true, undefined, spy);
  await tick();
  assert.match(bad.render(80, 12), /ERROR\(load failed\)/);
  const empty = harness(async () => ({ ...page([]), notice: "coverage note" }), () => true, undefined, spy);
  await tick();
  assert.match(empty.render(80, 12), /DIM\(No items on this page\.\)/);
  assert.match(empty.render(80, 12), /DIM\(Coverage notice/);
  const compact = harness(async () => page([{ id: "compact", title: "Compact row", body: "body" }]), () => true, undefined, spy);
  await tick();
  assert.match(compact.render(80, 3), /ACCENT\(BOLD\(Session\)\)/, "active scope survives the narrow-height fallback");
  compact.key("/"); for (const char of "needle") compact.key(char);
  assert.match(compact.render(80, 7), /needle/, "compact search keeps its input visible");
});

test("mid-detail scroll shows both range indicators and keeps the complete back/close footer", async () => {
  const body = Array.from({ length: 100 }, (_, i) => `detail line ${i}`).join("\n");
  const h = harness(async () => page([{ id: "long", title: "Long detail", body }]));
  await tick(); h.key("ENTER"); h.key("PGDN");
  const output = h.render(80, 12);
  assert.match(output, /▲ .*lines above/);
  assert.match(output, /▼ .*lines below/);
  assert.match(output, /Esc back · F10 close/);
  assert.ok(output.split("\n").length <= 12);
});

test("navigation labels fit, reverse tabs work, source return paths and help preserve scroll", async () => {
  const longBody = Array.from({ length: 50 }, (_, i) => `detail-${i}`).join("\\n");
  const h = harness(async (r) => page([{ id: "one", title: "Selected", body: longBody, source: { title: "Origin", body: "source body" } }], 0, 12));
  await tick();
  const list = h.render(80, 24);
  const mediumList = h.render(80, 12);
  for (const hint of ["Tab", "Shift+Tab", "Memories", "Context", "Timeline", "Up/Down select", "Enter open", "Esc/F10 close", "←/→ scope", "/ search", "s source", "n/p result pages", "Tab switch clears search"]) {
    assert.ok(list.includes(hint), `missing ${hint}`);
    assert.ok(mediumList.includes(hint), `80x12 layout clipped ${hint}`);
  }
  h.key("\\t"); await tick();
  h.key("\\u001b[Z"); await tick();
  assert.match(h.render(), /Memories/);
  h.key("ENTER");
  h.key("DOWN");
  const detailAtScroll = h.render(80, 10);
  h.key("?");
  h.key("PGDN");
  assert.match(h.render(80, 10), /lines above/);
  h.key("ESC");
  assert.equal(h.render(80, 10), detailAtScroll, "help has independent scroll and returns to the preserved detail viewport");
  h.key("s");
  h.key("ESC");
  assert.equal(h.render(80, 10), detailAtScroll, "source escape returns to detail with its scroll intact");
  h.key("ESC");
  h.key("s");
  h.key("ESC");
  assert.match(h.render(), /Selected/, "source opened from list returns to list");
  h.key("?");
  let help = h.render(80, 24);
  for (let i = 0; i < 4; i++) { h.key("PGDN"); help += h.render(80, 24); }
  for (const instruction of ["switch tabs", "changes memory scope", "moves selection within", "result page", "read-only", "actions"]) assert.ok(help.toLowerCase().includes(instruction.toLowerCase()), `help missing ${instruction}`);
});

test("custom keybindings are shown using human names and control list navigation", async () => {
  const bindings = {
    getKeys: (action: string) => ({ "tui.select.up": ["ctrl+k"], "tui.select.down": ["alt+j"], "tui.select.confirm": ["ctrl+enter"], "tui.select.cancel": ["ctrl+q"], "tui.select.pageUp": ["pageUp"], "tui.select.pageDown": ["pageDown"] }[action] ?? []),
    matches: (data: string, action: string) => ({ "tui.select.up": data === "CTRL_K", "tui.select.down": data === "ALT_J", "tui.select.confirm": data === "CTRL_ENTER", "tui.select.cancel": data === "CTRL_Q" }[action] ?? false),
  };
  const h = harness(async () => page([{ id: "one", title: "One", body: "one" }, { id: "two", title: "Two", body: "two" }]), () => true, undefined, theme, bindings);
  await tick();
  const list = h.render(80, 24);
  assert.ok(list.includes("Ctrl+K/Alt+J select"));
  assert.ok(list.includes("Ctrl+Enter open"));
  assert.ok(list.includes("Ctrl+Q/F10 close"));
  h.key("ALT_J");
  assert.match(h.render(), /▸ Two/);
});

test("disabled bindings read as unbound and list help does not reuse a stale source", async () => {
  const unbound = harness(async () => page([{ id: "one", title: "One", body: "body" }]), () => true, undefined, theme, { getKeys: () => [], matches: () => false });
  await tick();
  assert.match(unbound.render(80, 24), /unbound select/);
  unbound.key("?");
  const help = unbound.render(80, 24);
  assert.match(help, /unbound opens/);
  const stale = harness(async () => page([
    { id: "linked", title: "Linked", body: "linked body", source: { title: "Origin", body: "source" } },
    { id: "plain", title: "Plain", body: "plain body" },
  ]));
  await tick(); stale.key("ENTER"); stale.key("ESC"); stale.key("DOWN"); stale.key("?");
  let sourceHelp = stale.render(80, 24);
  for (let i = 0; i < 3; i++) { stale.key("PGDN"); sourceHelp += stale.render(80, 24); }
  assert.match(sourceHelp, /Source text is read-only; it is shown only when linked/);
  assert.doesNotMatch(sourceHelp, /s opens the linked source text/);
});

test("native wrapper waits for custom overlay resolution and suppresses stale or aborted handoffs", async () => {
  async function run(stale: boolean, abort = false) {
    let current = true;
    const controller = new AbortController();
    let resolveCustom!: () => void;
    let component: { handleInput(data: string): void } | undefined;
    let doneCalled = false;
    const events: string[] = [];
    const ctx = { mode: "tui", ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => { handleInput(data: string): void }, _options: unknown) => {
      component = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, { matches: (data: string, action: string) => ({ "tui.select.cancel": data === "ESC" }[action] ?? false) }, () => { doneCalled = true; events.push("closed"); });
      await new Promise<void>((resolve) => { resolveCustom = resolve; });
    } } };
    const opened = openMemoryInspector(ctx as never, {
      load: async () => page([{ id: "actual-id", title: "label", body: "body" }]),
      isCurrent: () => current,
      ...(abort ? { signal: controller.signal } : {}),
      onAction: async (request) => { events.push(`action:${request.selectedId}`); },
    });
    await tick(); component!.handleInput("a");
    assert.equal(doneCalled, true);
    assert.deepEqual(events, ["closed"], "action waits until custom() resolves");
    if (stale) current = false;
    if (abort) controller.abort();
    resolveCustom(); await opened;
    return events;
  }
  assert.deepEqual(await run(false), ["closed", "action:actual-id"]);
  assert.deepEqual(await run(true), ["closed"]);
  assert.deepEqual(await run(false, true), ["closed"]);
});

test("open inspector configures a live overlay with the identical allocated row limit", async () => {
  const tui: { terminal: { rows: number; columns: number }; requestRender(): void } = { terminal: { rows: 30, columns: 100 }, requestRender() {} };
  let component: { render(width: number): string[]; dispose?(): void } | undefined;
  let receivedOptions: { overlay?: boolean; overlayOptions?: () => { width?: unknown; maxHeight?: number; margin?: number } } | undefined;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => typeof component, options: typeof receivedOptions) => {
        receivedOptions = options;
        component = factory(tui, theme, { getKeys: (action: string) => ({ "tui.select.up": ["up"], "tui.select.down": ["down"], "tui.select.confirm": ["enter"], "tui.select.cancel": ["escape"] }[action] ?? []), matches: () => false }, () => {});
        const overlay = receivedOptions?.overlayOptions?.();
        assert.equal(receivedOptions?.overlay, true);
        assert.equal(overlay?.width, "90%");
        assert.equal(overlay?.margin, 1);
        for (const terminalRows of [1, 2, 3, 30, 60]) {
          tui.terminal.rows = terminalRows;
          const layout: { width?: unknown; maxHeight?: number; margin?: number } | undefined = receivedOptions?.overlayOptions?.();
          assert.equal(layout?.maxHeight, memoryInspectorViewportRows(terminalRows));
          assert.ok(component !== undefined);
          assert.ok(component.render(80).length <= (layout?.maxHeight ?? 0));
        }
      },
    },
  };
  await openMemoryInspector(ctx as never, { load: async () => page([]), isCurrent: () => true });
  component?.dispose?.();
});
