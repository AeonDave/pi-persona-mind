import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createCodemodeExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runtimeHarness } from "./setup/pi-runtime.ts";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("real Pi 1.0 codemode: only relayed blocked output nudges the supervisor", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-native-codemode-"));
  let h: Awaited<ReturnType<typeof runtimeHarness>> | undefined;
  const nested: string[] = [];
  const reporter: ExtensionFactory = (pi) => {
    pi.registerTool({ name: "delegate", label: "Offline report", description: "Return a deterministic test report",
      parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "[BLOCKED: offline fixture]" }], details: {} }) });
    pi.on("tool_result", (event) => { if (event.parentToolCallId) nested.push(event.parentToolCallId); });
  };
  try {
    h = await runtimeHarness(root, entry, [createCodemodeExtension(), reporter]);
    await h.bind();
    h.session.setActiveToolsByName(["codemode", "delegate"]);
    h.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: 'await tools.delegate({}); text("No report relayed.");' }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Discarded."),
    ]);
    await h.session.prompt("Run the discard script.");
    assert.equal(nested.length, 1, "the real host emitted a nested parent ID");
    assert.ok(!h.statuses.some((text) => text.includes("backlog add")), "discarded nested output stays quiet");
    const results = h.session.messages.filter((message) => message.role === "toolResult");
    assert.match(JSON.stringify(results), /No report relayed/);
    assert.doesNotMatch(JSON.stringify(results), /\[BLOCKED/);
    h.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: 'text(await tools.delegate({}));' }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Relayed."),
    ]);
    await h.session.prompt("Run the relay script.");
    assert.equal(nested.length, 2);
    assert.ok(h.statuses.some((text) => text.includes("backlog add")), "the visible relay nudges through the same host pipeline");
  } finally {
    await h?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi 1.0: user capture persists before the model and reloads into a fresh session", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-pi-runtime-"));
  let h: Awaited<ReturnType<typeof runtimeHarness>> | undefined;
  try {
    h = await runtimeHarness(root, entry);
    await h.bind();
    assert.ok(h.session.getAllTools().some((tool) => tool.name === "memory"));
    assert.ok(h.session.getAllTools().some((tool) => tool.name === "backlog"));
    let injected = "";
    h.faux.setResponses([(context) => {
      injected = JSON.stringify(context.messages.filter((message) => message.role === "system"));
      return fauxAssistantMessage("Captured.");
    }]);
    await h.session.prompt("Remember that I prefer small, reviewable changes.", { source: "interactive" });
    assert.match(injected, /small, reviewable changes/);
    assert.match(injected, /persona-mind/);
    const session = h.session;
    const recall = await session.extensionRunner!.createToolContext("native-recall", undefined)
      .executeTool("memory", { action: "recall", query: "reviewable" });
    assert.match(JSON.stringify(recall.result.content), /small, reviewable changes/);
    await h.dispose();
    h = await runtimeHarness(root, entry);
    await h.bind();
    h.faux.setResponses([(context) => {
      assert.match(JSON.stringify(context.messages.filter((message) => message.role === "system")), /small, reviewable changes/);
      return fauxAssistantMessage("Still remembered.");
    }]);
    await h.session.prompt("What conventions apply?", { source: "interactive" });
    assert.equal(h.faux.state.callCount, 1, "resurfacing itself adds no model call");
  } finally {
    await h?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi 1.0: memory tools execute through the agent loop and workers remain read-only", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-pi-worker-"));
  const previousLeg = process.env.PI_PERSONA_LEG;
  let h: Awaited<ReturnType<typeof runtimeHarness>> | undefined;
  try {
    h = await runtimeHarness(root, entry);
    await h.bind();
    h.session.setActiveToolsByName(["memory"]);
    h.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("memory", { action: "remember", term: "long", kind: "preference", text: "The user prefers blue widgets." }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Saved."),
    ]);
    await h.session.prompt("Save the verified preference.", { source: "interactive" });
    const results = h.session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 1);
    assert.match(JSON.stringify(results[0]), /blue widgets/);
    await h.dispose();
    process.env.PI_PERSONA_LEG = "1";
    h = await runtimeHarness(root, entry);
    await h.bind();
    assert.ok(!h.session.getAllTools().some((tool) => tool.name === "memory" || tool.name === "backlog"));
    h.faux.setResponses([(context) => {
      assert.match(JSON.stringify(context.messages.filter((message) => message.role === "system")), /blue widgets/);
      return fauxAssistantMessage("Lean read-only mind.");
    }]);
    await h.session.prompt("Check the inherited preference.");
  } finally {
    await h?.dispose();
    if (previousLeg === undefined) delete process.env.PI_PERSONA_LEG;
    else process.env.PI_PERSONA_LEG = previousLeg;
    await rm(root, { recursive: true, force: true });
  }
});
