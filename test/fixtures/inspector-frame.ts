import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { InspectorFrame } from "../../src/ui/inspector-frame.ts";

// Test-only structural provider. Persona owns production layout and frame rendering.
export const frame: InspectorFrame = {
  viewportRows: (rows) => Math.max(1, Math.min(Math.floor(rows * 0.9), Math.floor(rows) - 2)),
  layout(width, height) {
    width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
    const framed = width >= 5 && height >= 3;
    const gutter = framed ? width >= 7 ? 2 : 1 : 0;
    return { width, height, contentWidth: framed ? width - 2 - 2 * gutter : width, contentRows: framed ? height - 2 : height, gutter, framed };
  },
  render(lines, layout, border) {
    const body = lines.slice(0, layout.contentRows).map((line) => truncateToWidth(line, layout.contentWidth, "…"));
    if (!layout.framed) return body;
    const gap = " ".repeat(layout.gutter);
    return [border(`┌${"─".repeat(layout.width - 2)}┐`), ...body.map((line) => `${border("│")}${gap}${line}${" ".repeat(Math.max(0, layout.contentWidth - visibleWidth(line)))}${gap}${border("│")}`), border(`└${"─".repeat(layout.width - 2)}┘`)];
  },
};
