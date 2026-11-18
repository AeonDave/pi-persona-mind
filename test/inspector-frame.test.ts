import assert from "node:assert/strict";
import { test } from "node:test";
import { INSPECTOR_FRAME_EVENT, queryInspectorFrame } from "../src/ui/inspector-frame.ts";

const frame = { viewportRows() { return 12; }, layout() { return {}; }, render() { return []; } };
const response = { version: 1, provider: "pi-persona", frame };
test("inspector adapter resolves a fresh, structurally valid provider on every open", () => {
  let calls = 0;
  const events = { emit(event: string, data: unknown) {
    calls++; assert.equal(event, INSPECTOR_FRAME_EVENT);
    const query = data as { version: number; respond(value: unknown): void };
    assert.equal(query.version, 1); query.respond(response);
  } };
  assert.equal(queryInspectorFrame(events), frame);
  assert.equal(queryInspectorFrame(events), frame);
  assert.equal(calls, 2);
});
test("inspector adapter rejects missing, invalid, ambiguous, throwing and late providers", async () => {
  for (const values of [[], [{ ...response, version: 2 }], [{ ...response, provider: "other" }], [{ ...response, frame: {} }], [response, response]]) {
    assert.equal(queryInspectorFrame({ emit(_event, data) { for (const value of values) (data as { respond(value: unknown): void }).respond(value); } }), undefined);
  }
  assert.equal(queryInspectorFrame({ emit() { throw new Error("unavailable"); } }), undefined);
  let late: ((response: unknown) => void) | undefined;
  assert.equal(queryInspectorFrame({ emit(_event, data) { late = (data as { respond(value: unknown): void }).respond; } }), undefined);
  late?.(response);
});
