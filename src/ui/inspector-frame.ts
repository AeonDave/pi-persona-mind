/** Structural adapter to Persona's shared, stateless inspector frame. */
export const INSPECTOR_FRAME_EVENT = "pi-persona:inspector-frame:v1";

export interface InspectorLayout {
  width: number;
  height: number;
  contentWidth: number;
  contentRows: number;
  gutter: number;
  framed: boolean;
}

export interface InspectorFrame {
  viewportRows(terminalRows: number): number;
  layout(width: number, height: number): InspectorLayout;
  render(lines: readonly string[], layout: InspectorLayout, border: (text: string) => string): string[];
}

export interface InspectorFrameEventBus { emit(event: string, data: unknown): void; }

function validFrame(response: unknown): InspectorFrame | undefined {
  if (!response || typeof response !== "object") return undefined;
  const value = response as Record<string, unknown>;
  if (value.version !== 1 || value.provider !== "pi-persona" || !value.frame || typeof value.frame !== "object") return undefined;
  const frame = value.frame as Record<string, unknown>;
  return typeof frame.viewportRows === "function" && typeof frame.layout === "function" && typeof frame.render === "function"
    ? value.frame as InspectorFrame : undefined;
}

/** Resolve on each opening; late and ambiguous providers cannot select a renderer. */
export function queryInspectorFrame(events: InspectorFrameEventBus): InspectorFrame | undefined {
  let synchronous = true;
  let count = 0;
  let frame: InspectorFrame | undefined;
  try {
    events.emit(INSPECTOR_FRAME_EVENT, { version: 1, respond(response: unknown) {
      if (!synchronous) return;
      const candidate = validFrame(response);
      if (candidate) { count++; frame = candidate; }
    } });
  } catch { return undefined; }
  finally { synchronous = false; }
  return count === 1 ? frame : undefined;
}
