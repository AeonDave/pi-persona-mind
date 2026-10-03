/**
 * Test-process choke point: a developer shell or CI runner may export pi-persona settings that
 * deliberately alter extension registration, capture, scope, or persistence. Clear that namespace
 * before any test module loads; individual tests can still set the variable they exercise.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) {
	if (key.toUpperCase() === "PI_AGENT_DIR" || key.toUpperCase().startsWith("PI_PERSONA_")) delete process.env[key];
}
const agentDir = mkdtempSync(join(tmpdir(), "pi-mind-test-agent-"));
process.env.PI_AGENT_DIR = agentDir;
process.once("exit", () => rmSync(agentDir, { recursive: true, force: true }));
