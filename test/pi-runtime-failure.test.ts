import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeHarness } from "./setup/pi-runtime.ts";

test("a failed host load restores the isolated agent-dir environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "companion-failed-load-"));
  const original = process.env.PI_AGENT_DIR;
  try {
    await assert.rejects(runtimeHarness(root, join(root, "absent.ts")));
    assert.equal(process.env.PI_AGENT_DIR, original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
