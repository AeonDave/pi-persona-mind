/** Load a packed/extracted extension outside the checkout through the real minimum Pi SDK. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runtimeHarness } from "../test/setup/pi-runtime.ts";

if (!process.argv[2]) throw new Error("Usage: node --import tsx scripts/qualify-package.ts <extracted-package>/src/index.ts");
const root = await mkdtemp(join(tmpdir(), "mind-packed-qualification-"));
let h: Awaited<ReturnType<typeof runtimeHarness>> | undefined;
try {
  h = await runtimeHarness(root, resolve(process.argv[2]));
  await h.bind();
  h.session.setActiveToolsByName(["memory", "backlog"]);
  h.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("memory", { action: "remember", term: "long", kind: "preference", text: "The user prefers reviewable changes." }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("memory", { action: "recall", query: "reviewable" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("backlog", { action: "add", text: "Review the qualified package.", dueInSeconds: 0.0001 }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Qualified."),
  ]);
  await h.session.prompt("Store and check the verified preference.", { source: "interactive" });
  const results = h.session.messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => !result.isError), JSON.stringify(results));
  const receipt = results[0]!.details;
  assert.ok(receipt !== null && typeof receipt === "object" && "ok" in receipt);
  assert.equal(receipt.ok, true);
  assert.match(JSON.stringify(results[1]!.content), /reviewable changes/);
  const wakes = h.session.sessionManager.getEntries().filter((item) => item.type === "custom" && item.customType === "pi-persona-mind-wake");
  assert.equal(wakes.length, 1, "the packed extension delivers the newly overdue alarm through Pi's real tool-result hook");
  assert.match(JSON.stringify(wakes[0]), /Review the qualified package/);
  assert.equal(h.faux.state.callCount, 4, "the reminder itself adds no model call");
  console.log("PASS: extracted Mind package loaded in Pi 1.0; memory saved/recalled and newly due wake displayed once without a model turn.");
} finally {
  try { await h?.dispose(); }
  finally { await rm(root, { recursive: true, force: true }); }
}
