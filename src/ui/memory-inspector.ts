import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { InspectorItem, InspectorPage, InspectorRequest, InspectorScope, InspectorTab } from "../extension/inspector-data.ts";
import { sanitizeCardText } from "./presentation.ts";

const TABS: InspectorTab[] = ["memories", "context", "timeline"];
const TAB_LABELS: Record<InspectorTab, string> = { memories: "Memories", context: "Context", timeline: "Timeline" };
const SCOPES: InspectorScope[] = ["session", "project", "project-long", "persona", "shared"];

export interface MemoryInspectorOptions {
  load: (request: InspectorRequest) => Promise<InspectorPage>;
  isCurrent: () => boolean;
  initialTab?: InspectorTab;
  signal?: AbortSignal;
  /** Allocated overlay rows; matches the host overlay maxHeight after margins. */
  viewportHeight?: () => number;
  onAction?: (request: InspectorRequest & { selectedId?: string }) => Promise<void>;
}

type View = "list" | "detail" | "source" | "help";

export class MemoryInspectorComponent implements Component, Focusable {
  private tab: InspectorTab;
  private scope: InspectorScope = "session";
  private query = "";
  private _focused = false;
  private helpReturn: Exclude<View, "help"> = "list";
  private sourceReturn: "list" | "detail" = "list";
  private helpScroll = 0;
  private wrappedCache: { width: number; body: string; lines: string[] } | undefined;
  private page: InspectorPage | undefined;
  private selected = 0;
  private view: View = "list";
  private item: InspectorItem | undefined;
  private offsets: number[] = [0];
  private generation = 0;
  private closed = false;
  private loading = true;
  private error = "";
  private searching = false;
  private detailScroll = 0;
  private sourceScroll = 0;
  private listStart = 0;
  private readonly searchInput = new Input({ prompt: "/ " });
  private pendingAction: (InspectorRequest & { selectedId?: string }) | undefined;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.searchInput.focused = value; }
  readonly capturesViewportInput = true;
  private readonly onAbort: () => void;
  private readonly tui: TUI;
  private readonly theme: { fg(name: "accent" | "dim" | "warning" | "error" | "success", text: string): string; bold(text: string): string };
  private readonly keybindings: KeybindingsManager;
  private readonly done: (result: void) => void;
  private readonly options: MemoryInspectorOptions;

  constructor(
    tui: TUI,
    theme: { fg(name: "accent" | "dim" | "warning" | "error" | "success", text: string): string; bold(text: string): string },
    keybindings: KeybindingsManager,
    done: (result: void) => void,
    options: MemoryInspectorOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.options = options;
    this.tab = options.initialTab ?? "memories";
    this.onAbort = () => this.close();
    if (options.signal?.aborted) this.close();
    else options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (!this.closed) this.startLoad();
  }

  private isCurrent(): boolean {
    if (this.closed) return false;
    if (!this.options.isCurrent()) { this.close(); return false; }
    return true;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.options.signal?.removeEventListener("abort", this.onAbort);
    this.done();
  }

  private request(): InspectorRequest {
    return { tab: this.tab, scope: this.scope, query: this.query, offset: this.offsets.at(-1) ?? 0 };
  }

  private startLoad(): void {
    const generation = ++this.generation;
    this.loading = true;
    this.error = "";
    this.page = undefined;
    this.selected = 0;
    const req = this.request();
    // Always consume rejections: input handlers and the component factory are synchronous.
    void this.options.load(req).then((result) => {
      if (!this.isCurrent() || generation !== this.generation) return;
      this.page = result;
      this.loading = false;
      this.error = "";
      this.selected = Math.min(this.selected, Math.max(0, result.items.length - 1));
      this.tui.requestRender();
    }, (error: unknown) => {
      if (!this.isCurrent() || generation !== this.generation) return;
      this.loading = false;
      this.error = error instanceof Error ? error.message : "Unable to load inspector data";
      this.tui.requestRender();
    }).catch(() => { /* Keep the custom UI path free of unhandled callback failures. */ });
  }

  private resetAndLoad(): void { this.offsets = [0]; this.view = "list"; this.item = undefined; this.startLoad(); }

  private switchTab(): void {
    this.tab = TABS[(TABS.indexOf(this.tab) + 1) % TABS.length]!;
    this.query = "";
    this.searchInput.setValue("");
    this.resetAndLoad();
  }

  handleInput(data: string): void {
    if (!this.isCurrent()) return;
    if (matchesKey(data, "f10")) { this.close(); return; }
    if (this.searching) {
      if (this.keybindings.matches(data, "tui.select.cancel")) { this.searching = false; this.tui.requestRender(); return; }
      if (this.keybindings.matches(data, "tui.select.confirm")) {
        this.query = sanitizeCardText(this.searchInput.getValue());
        this.searching = false;
        this.resetAndLoad();
        this.tui.requestRender();
        return;
      }
      this.searchInput.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.view === "source") this.view = this.sourceReturn;
      else if (this.view === "detail") this.view = "list";
      else if (this.view === "help") this.view = this.helpReturn;
      else this.close();
      this.tui.requestRender(); return;
    }
    if (this.view !== "list") {
      if (data === "a" && this.tab === "memories" && this.view === "detail" && this.options.onAction) {
        this.pendingAction = { ...this.request(), ...(this.item ? { selectedId: this.item.id } : {}) };
        this.close();
        return;
      }
      const currentScroll = this.view === "source" ? this.sourceScroll : this.view === "help" ? this.helpScroll : this.detailScroll;
      const viewportRows = this.options.viewportHeight?.() ?? this.tui.terminal?.rows ?? 1;
      const delta = Math.max(1, viewportRows - 4);
      if (this.keybindings.matches(data, "tui.select.up")) this.setDetailScroll(Math.max(0, currentScroll - 1));
      else if (this.keybindings.matches(data, "tui.select.down")) this.setDetailScroll(currentScroll + 1);
      else if (this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.altScreen.pageUp")) this.setDetailScroll(Math.max(0, currentScroll - delta));
      else if (this.keybindings.matches(data, "tui.select.pageDown") || this.keybindings.matches(data, "tui.altScreen.pageDown")) this.setDetailScroll(currentScroll + delta);
      else if (data === "s" && this.view === "detail" && this.item?.source) {
        this.sourceReturn = "detail"; this.view = "source"; this.sourceScroll = 0;
      } else if (data === "?" && this.view !== "help") {
        this.helpReturn = this.view; this.helpScroll = 0; this.view = "help";
      }
      this.tui.requestRender(); return;
    }
    if (data === "a" && this.tab === "memories" && this.options.onAction) {
      const selected = this.page?.items[this.selected];
      this.pendingAction = { ...this.request(), ...(selected ? { selectedId: selected.id } : {}) };
      this.close();
      return;
    }
    if (matchesKey(data, "tab")) this.switchTab();
    else if (matchesKey(data, "shift+tab")) {
      this.tab = TABS[(TABS.indexOf(this.tab) + TABS.length - 1) % TABS.length]!;
      this.query = ""; this.searchInput.setValue(""); this.resetAndLoad();
    }
    else if (this.keybindings.matches(data, "tui.select.up") && this.page) this.selected = Math.max(0, this.selected - 1);
    else if (this.keybindings.matches(data, "tui.select.down") && this.page) this.selected = Math.max(0, Math.min(this.page.items.length - 1, this.selected + 1));
    else if ((this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.altScreen.pageUp")) && this.page) this.selected = Math.max(0, this.selected - Math.max(1, (this.tui.terminal?.rows ?? 1) - 5));
    else if ((this.keybindings.matches(data, "tui.select.pageDown") || this.keybindings.matches(data, "tui.altScreen.pageDown")) && this.page) this.selected = Math.max(0, Math.min(this.page.items.length - 1, this.selected + Math.max(1, (this.tui.terminal?.rows ?? 1) - 5)));
    else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.item = this.page?.items[this.selected]; if (this.item) { this.view = "detail"; this.detailScroll = 0; }
    } else if (matchesKey(data, "left") && this.tab === "memories") {
      this.scope = SCOPES[(SCOPES.indexOf(this.scope) + SCOPES.length - 1) % SCOPES.length]!; this.resetAndLoad();
    } else if (matchesKey(data, "right") && this.tab === "memories") {
      this.scope = SCOPES[(SCOPES.indexOf(this.scope) + 1) % SCOPES.length]!; this.resetAndLoad();
    } else if (data === "/" && this.tab !== "context") {
      this.searchInput.setValue(this.query); this.searching = true;
    } else if (data === "?") {
      this.helpReturn = "list"; this.helpScroll = 0; this.view = "help";
    } else if (data === "s" && this.page?.items[this.selected]?.source) {
      this.item = this.page.items[this.selected]; this.sourceReturn = "list"; this.view = "source"; this.sourceScroll = 0;
    } else if (data === "n" && this.page?.nextOffset !== undefined) {
      this.offsets.push(this.page.nextOffset); this.startLoad();
    } else if (data === "p" && this.offsets.length > 1) {
      this.offsets.pop(); this.startLoad();
    } else if (data === "r") this.startLoad();
    this.tui.requestRender();
  }

  private setDetailScroll(offset: number): void {
    if (this.view === "source") this.sourceScroll = offset;
    else if (this.view === "help") this.helpScroll = offset;
    else this.detailScroll = offset;
  }

  render(width: number, height?: number): string[] {
    if (!this.isCurrent() || width <= 0) return [];
    const outerWidth = Math.max(1, Math.floor(width));
    const outerRows = Math.max(1, Math.floor(height ?? this.options.viewportHeight?.() ?? this.tui.terminal?.rows ?? 1));
    // Match Persona's F9 frame, but degrade safely when the terminal cannot fit its chrome.
    if (outerWidth < 5 || outerRows < 3) return this.renderContent(outerWidth, outerRows);
    // F9 combines one column of Text padding with one column inside the frame.
    const gutter = " ".repeat(outerWidth >= 7 ? 2 : 1);
    const innerWidth = outerWidth - 2 - gutter.length * 2;
    const border = (text: string) => this.theme.fg("accent", text);
    const body = this.renderContent(innerWidth, outerRows - 2).map((line) =>
      `${border("│")}${gutter}${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))}${gutter}${border("│")}`);
    return [border(`┌${"─".repeat(outerWidth - 2)}┐`), ...body, border(`└${"─".repeat(outerWidth - 2)}┘`)];
  }

  private renderContent(safeWidth: number, rows: number): string[] {
    const t = this.theme;
    const oneLine = (value: string) => sanitizeCardText(value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    const fit = (value: string) => truncateToWidth(value, safeWidth, "…");
    const dim = (value: string) => t.fg("dim", fit(value));
    const accent = (value: string) => t.fg("accent", fit(value));
    const key = (action: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel" | "tui.select.pageUp" | "tui.select.pageDown") => {
      const names = this.keybindings.getKeys(action);
      return names.length ? names.map((name) => name.replace(/^pageUp$/i, "PgUp").replace(/^pageDown$/i, "PgDn").replace(/^escape$/i, "Esc").replace(/^return$/i, "Enter").replace(/(^|[+])([a-z])/g, (_match, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`)).join("/") : "unbound";
    };
    const pair = (left: "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown", right: "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown") => {
      const first = key(left);
      const second = key(right);
      return first === "unbound" || second === "unbound" ? "unbound" : `${first}/${second}`;
    };
    const selected = this.page?.items[this.selected];
    const status = this.loading ? dim("Loading…") : this.error ? t.fg("error", fit(oneLine(this.error))) : undefined;
    const result: string[] = [];
    const footer = (parts: string[]) => wrapTextWithAnsi(parts.join(" · "), safeWidth).map(dim);
    if (this.view === "list") {
      const compactItems = this.page?.items ?? [];
      const scopeNames: Record<InspectorScope, string> = { session: "Session", project: "Working", "project-long": "Project", persona: "Persona", shared: "Shared" };
      const activeScope = this.tab === "memories" ? accent(t.bold(scopeNames[this.scope])) : accent(t.bold(TAB_LABELS[this.tab]));
      if (this.searching) {
        this.searchInput.focused = this.focused;
        if (rows >= 3) result.push(accent(t.bold("Memory inspector")));
        if (rows >= 7) result.push("");
        if (rows >= 4) result.push(this.tab === "memories" ? `${dim("Scope: ")}${activeScope}` : activeScope);
        result.push(this.searchInput.render(safeWidth)[0] ?? "/");
        if (rows >= 7) result.push("");
        if (rows >= 2) result.push(dim(`${key("tui.select.confirm")} apply · ${key("tui.select.cancel")} cancel`));
        return result.slice(0, rows).map(fit);
      }
      if (rows <= 4) {
        const compact = compactItems[this.selected];
        const selection = compact ? accent(`▸ ${oneLine(compact.title)}`) : this.loading ? dim("Loading…") : this.error ? t.fg("error", fit(oneLine(this.error))) : dim("No items");
        if (rows === 1) result.push(this.tab === "memories" ? `${activeScope} · ${selection}` : selection);
        else { result.push(activeScope); result.push(selection); }
        return result.slice(0, rows).map(fit);
      }
      if (rows <= 9) {
        result.push(accent(t.bold("Memory inspector")));
        result.push(this.tab === "memories" ? `${dim("Scope: ")}${activeScope}` : activeScope);
        const compact = compactItems[this.selected];
        if (compact) result.push(accent(`▸ ${oneLine(compact.title)}`));
        else if (this.loading) result.push(dim("Loading…"));
        else if (this.error) result.push(t.fg("error", fit(oneLine(this.error))));
        else result.push(dim("No items"));
        if (rows >= 6 && compactItems.length) result.push(dim(`${(this.page?.offset ?? 0) + this.selected + 1} selected · ${(this.page?.offset ?? 0) + 1}-${(this.page?.offset ?? 0) + compactItems.length} of ${this.page?.total ?? 0}`));
        if (rows >= 7) result.push(dim(`${pair("tui.select.up", "tui.select.down")} select · ${key("tui.select.confirm")} open · ${key("tui.select.cancel")}/F10 close`));
        return result.slice(0, rows).map(fit);
      }
      result.push(accent(t.bold("Memory inspector")));
      result.push(TABS.map((tab) => tab === this.tab ? accent(t.bold(`[${TAB_LABELS[tab]}]`)) : dim(TAB_LABELS[tab])).join(dim("  ")));
      if (this.tab === "memories") {
        const scopeStrip = safeWidth >= 72 ? ` · ${SCOPES.map((scope) => scope === this.scope ? accent(t.bold(`[${scopeNames[scope]}]`)) : dim(scopeNames[scope])).join(dim("  "))}` : "";
        result.push(`${dim("Scope: ")}${activeScope}${scopeStrip}`);
      } else result.push(dim(`Search: ${this.query ? oneLine(this.query) : "none"} · Tab switch clears search`));
      if (this.searching) {
        this.searchInput.focused = this.focused;
        result.push(this.searchInput.render(safeWidth)[0] ?? "/");
      } else if (this.tab === "memories") result.push(dim(`Search: ${this.query ? oneLine(this.query) : "none"} · Tab switch clears search`));
      const items = this.page?.items ?? [];
      const total = this.page?.total ?? 0;
      const offset = this.page?.offset ?? 0;
      const current = items.length ? `${offset + Math.min(this.selected + 1, items.length)} selected · ${offset + 1}-${offset + items.length} of ${total}` : `0 selected · 0 of ${total}`;
      if (status) result.push(status);
      result.push(dim(current));
      if (this.page?.notice) result.push(dim("Coverage notice · ? help"));
      if (!this.loading && !this.error && items.length === 0) result.push(dim("No items on this page."));
      const optional: string[] = [];
      if (this.tab === "memories") optional.push("←/→ scope");
      if (this.tab !== "context") optional.push("/ search");
      if (this.tab === "memories" && this.options.onAction) optional.push("a actions");
      if (selected?.source) optional.push("s source");
      if (this.page?.nextOffset !== undefined || this.offsets.length > 1) optional.push("n/p result pages");
      const footers = this.searching
        ? footer([`${key("tui.select.confirm")} apply`, `${key("tui.select.cancel")} cancel`])
        : [footer(["Tab / Shift+Tab tabs", ...optional.slice(0, 2)]), footer([`${pair("tui.select.up", "tui.select.down")} select`, `${key("tui.select.confirm")} open`, ...optional.slice(2, 4)]), footer(["? help", `${key("tui.select.cancel")}/F10 close`, ...optional.slice(4)])].flat();
      // Spend whitespace only when at least one record still fits. Match F9's
      // title/content/footer separation rather than crowding the frame chrome.
      const spaced = rows - result.length - footers.length >= 4;
      if (spaced) { result.splice(1, 0, ""); result.push(""); }
      const capacity = Math.max(0, rows - result.length - footers.length - Number(spaced));
      const maxStart = Math.max(0, items.length - capacity);
      this.listStart = Math.min(this.listStart, maxStart);
      if (this.selected < this.listStart) this.listStart = this.selected;
      else if (capacity > 0 && this.selected >= this.listStart + capacity) this.listStart = this.selected - capacity + 1;
      for (let i = this.listStart; i < Math.min(items.length, this.listStart + capacity); i++) {
        const entry = items[i]!;
        const marker = entry.source ? "  [source]" : "";
        const line = `${i === this.selected ? "▸ " : "  "}${oneLine(entry.title)}`;
        const rendered = i === this.selected ? `${accent(line)}${marker ? dim(marker) : ""}` : `${fit(line)}${marker ? dim(marker) : ""}`;
        result.push(truncateToWidth(rendered, safeWidth));
      }
      if (spaced) result.push("");
      result.push(...footers);
    } else {
      let breadcrumb: string;
      if (this.view === "help") breadcrumb = `Memory inspector › ${TAB_LABELS[this.tab]} › Help`;
      else {
        const prefix = `Memory inspector › ${TAB_LABELS[this.tab]} › `;
        const suffix = this.view === "source" ? " › Source" : "";
        const titleWidth = Math.max(1, safeWidth - visibleWidth(prefix) - visibleWidth(suffix));
        breadcrumb = `${prefix}${truncateToWidth(oneLine(this.item?.title ?? "Detail"), titleWidth, "…")}${suffix}`;
      }
      result.push(accent(t.bold(breadcrumb)));
      let body: string;
      const missingSource = this.view === "detail" && !this.item?.source;
      if (this.view === "help") {
        const actions = this.tab === "memories" && this.options.onAction ? "a runs the explicit memory action (closes this view first)." : "No explicit action is available in this view.";
        const helpItem = this.helpReturn === "list" ? selected : this.item;
        const sourceHelp = helpItem?.source ? `s opens the linked source text; ${key("tui.select.cancel")} returns to the view that opened it.` : "Source text is read-only; it is shown only when linked to a record.";
        body = [
          "Navigation: In the list, Tab / Shift+Tab switch tabs; switching tabs clears the search query. ← / → changes memory scope in the Memories list only.",
          `${key("tui.select.up")} / ${key("tui.select.down")} moves selection within a list; ${key("tui.select.confirm")} opens the selected record. In detail/source/help, the arrow keys scroll the current text instead.`,
          "n / p moves to the next / previous result page only when available. / starts search in Memories and Timeline; Context has no search.",
          `${sourceHelp} ${actions}`,
          "Records and linked sources are read-only here. A linked source is a reference, not independent verification. Explicit actions are separate from reading; the cancel key goes back, F10 closes.",
          "Scope names: Session is session-only; Working is API project (working memory); Project is API project-long; Persona and Shared are wider durable scopes.",
          this.page?.notice || "No additional coverage notice.",
        ].join("\n\n");
      } else if (this.view === "source") body = this.item?.source?.body ?? "";
      else body = this.item?.body ?? "";
      let wrapped: string[];
      if (this.wrappedCache?.width === safeWidth && this.wrappedCache.body === body) wrapped = this.wrappedCache.lines;
      else { wrapped = wrapTextWithAnsi(sanitizeCardText(body), safeWidth); this.wrappedCache = { width: safeWidth, body, lines: wrapped }; }
      const displayWrapped = [...wrapped];
      const missingSourceIndex = missingSource ? displayWrapped.push("", "Source unavailable for this item.") - 1 : -1;
      const actions = this.view === "detail" && this.tab === "memories" && this.options.onAction ? ["a actions"] : [];
      const pageKeys = `${pair("tui.select.pageUp", "tui.select.pageDown")} page`;
      const footers = safeWidth < 20
        ? [dim(`↑↓ scroll/${key("tui.select.cancel")}`)]
        : safeWidth < 32
          ? footer([`${pair("tui.select.up", "tui.select.down")} scroll`, `${key("tui.select.cancel")} back`])
        : [
          ...footer([`${pair("tui.select.up", "tui.select.down")} scroll`, pageKeys]),
          ...footer([...(this.view === "detail" && this.item?.source ? ["s source"] : []), ...actions, `${key("tui.select.cancel")} back`, "F10 close"]),
        ];
      const scroll = this.view === "source" ? this.sourceScroll : this.view === "help" ? this.helpScroll : this.detailScroll;
      const indicatorRows = scroll > 0 ? 2 : 1;
      const spaced = rows - result.length - footers.length - indicatorRows >= 3;
      if (spaced) result.push("");
      const capacity = Math.max(0, rows - result.length - footers.length - indicatorRows - Number(spaced));
      const maxStart = Math.max(0, displayWrapped.length - capacity);
      const start = Math.min(scroll, maxStart);
      this.setDetailScroll(start);
      if (start > 0) result.push(dim(`▲ ${start} lines above`));
      result.push(...displayWrapped.slice(start, start + capacity).map((line, index) => start + index === missingSourceIndex ? t.fg("warning", fit(line)) : this.view === "help" ? dim(line) : fit(line)));
      if (start + capacity < displayWrapped.length) result.push(dim(`▼ ${displayWrapped.length - start - capacity} lines below`));
      if (spaced) result.push("");
      result.push(...footers);
    }
    return result.slice(0, rows).map(fit);
  }

  takeAction(): (InspectorRequest & { selectedId?: string }) | undefined {
    const action = this.pendingAction;
    this.pendingAction = undefined;
    return action;
  }

  invalidate(): void {}
  dispose(): void { this.options.signal?.removeEventListener("abort", this.onAbort); this.closed = true; this.generation++; }
}

export function createMemoryInspectorComponent(
  tui: TUI,
  theme: { fg(name: "accent" | "dim" | "warning" | "error" | "success", text: string): string; bold(text: string): string },
  keybindings: KeybindingsManager,
  done: (result: void) => void,
  options: MemoryInspectorOptions,
): MemoryInspectorComponent {
  return new MemoryInspectorComponent(tui, theme, keybindings, done, options);
}

/** Match F9's 90% overlay, preserving margins and the same outer row limit in render and host. */
export function memoryInspectorViewportRows(terminalRows: number): number {
  return Math.max(1, Math.min(Math.floor(terminalRows * 0.9), Math.floor(terminalRows) - 2));
}

export async function openMemoryInspector(
  ctx: ExtensionContext,
  options: MemoryInspectorOptions,
): Promise<void> {
  if (ctx.mode !== "tui") { ctx.ui.notify("Memory inspector requires interactive mode", "warning"); return; }
  if (options.signal?.aborted || !options.isCurrent()) return;
  try {
    let overlayTui: TUI | undefined;
    let component: MemoryInspectorComponent | undefined;
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
      overlayTui = tui;
      component = new MemoryInspectorComponent(tui, theme, keybindings, done, {
        ...options,
        viewportHeight: () => memoryInspectorViewportRows(tui.terminal?.rows ?? 1),
      });
      return component;
    }, {
      overlay: true,
      overlayOptions: () => {
        const rows = overlayTui?.terminal?.rows ?? 1;
        return { width: "90%", maxHeight: memoryInspectorViewportRows(rows), margin: 1 };
      },
    });
    const action = component?.takeAction();
    if (action && !options.signal?.aborted && options.isCurrent() && options.onAction) await options.onAction(action);
  } catch (error) {
    if (!options.signal?.aborted && options.isCurrent()) ctx.ui.notify(`Memory inspector closed: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
  }
}
