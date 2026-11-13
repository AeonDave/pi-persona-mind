import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = process.cwd();

test("test preload pins the SDK agent directory and cleans up its sandbox", () => {
	const output = execFileSync(process.execPath, [
		"--import", "tsx",
		"--import", "./test/setup/hermetic-env.ts",
		"--input-type=module",
		"-e",
		'import { getAgentDir } from "@earendil-works/pi-coding-agent"; console.log(JSON.stringify({ sdkDir: getAgentDir(), projectDir: process.env.PI_AGENT_DIR }));',
	], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PI_AGENT_DIR: path.join(REPO_ROOT, "poisoned-project-agent-dir"),
			PI_CODING_AGENT_DIR: path.join(REPO_ROOT, "poisoned-sdk-agent-dir"),
		},
		encoding: "utf8",
	});
	const { sdkDir, projectDir } = JSON.parse(output.trim()) as { sdkDir: string; projectDir: string };
	assert.equal(sdkDir, projectDir, "the SDK and pi-persona alias must use the same sandbox");
	assert.ok(sdkDir.startsWith(os.tmpdir()), `expected a temp sandbox, got ${sdkDir}`);
	assert.notEqual(sdkDir, path.join(REPO_ROOT, "poisoned-sdk-agent-dir"));
	assert.equal(existsSync(sdkDir), false, `sandbox must be removed on exit: ${sdkDir}`);
});
