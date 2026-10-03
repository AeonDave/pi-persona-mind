import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function json(relative: string) {
	return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
}

test("the manifest qualifies Pi 1.0 without bundling the host or TypeBox", () => {
	const manifest = json("../package.json");
  const lock = json("../package-lock.json");
  for (const host of ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"]) assert.equal(manifest.devDependencies[`@earendil-works/${host}`], "1.0.0");
	assert.equal(manifest.engines.node, ">=22.19.0");
	assert.equal(lock.version, manifest.version);
	assert.equal(lock.packages[""].version, manifest.version);
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(manifest.peerDependencies[name], "*", `${name} is supplied by Pi`);
		assert.equal(manifest.peerDependenciesMeta[name].optional, true);
		assert.equal(manifest.dependencies?.[name], undefined);
	}
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		assert.equal(manifest.devDependencies[name], "1.0.0");
	}
	assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
	assert.ok(manifest.files.includes("src"));
	assert.ok(manifest.files.includes("docs/DESIGN.md"));
	assert.ok(!manifest.files.includes("docs"), "do not ship draft documents recursively");
});

test("CI uses pinned actions and least-privilege checkout", () => {
	const workflow = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
	const actions = [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s]+)/g)];
	assert.ok(actions.length >= 2);
	for (const action of actions) assert.match(action[1]!, /^[a-f0-9]{40}$/);
	assert.match(workflow, /permissions:\s*\n\s+contents: read/);
	assert.match(workflow, /persist-credentials: false/);
	assert.match(workflow, /npm audit --audit-level=low/);
});
