import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runtimeHarness } from "./setup/pi-runtime.ts";

test("native Pi keeps Mind inactive without a loaded companion, including direct programmatic calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-missing-companion-"));
  let h: Awaited<ReturnType<typeof runtimeHarness>> | undefined;
  try {
    h = await runtimeHarness(root, fileURLToPath(new URL("../src/index.ts", import.meta.url)), [], { companion: false });
    await h.bind();
    let system = "";
    h.faux.setResponses([(context) => { system = JSON.stringify(context.messages.filter((message) => message.role === "system")); return fauxAssistantMessage("Acknowledged."); }]);
    await h.session.prompt("Remember that the missing companion must not save this fact.", { source: "interactive" });
    assert.doesNotMatch(system, /<persona-mind|<session-notes>/);
    assert.ok(!h.session.getActiveToolNames().includes("memory"));
    assert.ok(!h.session.getActiveToolNames().includes("backlog"));
    const context = h.session.extensionRunner!.createToolContext("missing-companion-probe", undefined);
    const outcome = await context.executeTool("memory", { action: "remember", term: "long", kind: "note", text: "Programmatic writes also require the companion." });
    assert.ok(outcome.isError || (outcome.result?.details as { ok?: boolean } | undefined)?.ok === false, JSON.stringify(outcome));
    await h.session.prompt("/persona-mind reset workspace");
    assert.equal(existsSync(join(h.agentDir, "persona-mind")), false, "inactive extension created no memory/import/lock directories");
    assert.ok(h.notifications.some((message) => /pi-persona/i.test(message) && /inactive|requires|unavailable/i.test(message)));
  } finally {
    await h?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
