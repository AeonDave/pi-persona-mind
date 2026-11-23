import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

function json(relative: string) {
	return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
}

test("the manifest qualifies Pi 1.6.0 without bundling the host or TypeBox", () => {
	const manifest = json("../package.json");
  const lock = json("../package-lock.json");
  for (const host of ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"]) assert.equal(manifest.devDependencies[`@earendil-works/${host}`], "1.6.0");
	assert.equal(manifest.engines.node, ">=22.19.0");
	assert.equal(lock.version, manifest.version);
	assert.equal(lock.packages[""].version, manifest.version);
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(manifest.peerDependencies[name], "*", `${name} is supplied by Pi`);
		assert.equal(manifest.peerDependenciesMeta[name].optional, true);
		assert.equal(manifest.dependencies?.[name], undefined);
	}
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		assert.equal(manifest.devDependencies[name], "1.6.0");
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

test("the public npm package has consistent identity, companion requirements and a shipped banner", () => {
	const manifest = json("../package.json");
	const lock = json("../package-lock.json");
	assert.equal(manifest.name, "@aeondave/pi-persona-mind");
	assert.equal(lock.name, manifest.name);
	assert.equal(lock.packages[""].name, manifest.name);
	assert.equal(manifest.author, "AeonDave");
	assert.equal(manifest.license, "MIT");
	assert.equal(manifest.publishConfig.access, "public");
	assert.equal(manifest.repository.url, "git+https://github.com/AeonDave/pi-persona-mind.git");
	assert.equal(manifest.peerDependencies["@aeondave/pi-persona"], ">=1.18.1");
	assert.equal(lock.packages[""].peerDependencies["@aeondave/pi-persona"], manifest.peerDependencies["@aeondave/pi-persona"]);
	assert.equal(manifest.peerDependenciesMeta["@aeondave/pi-persona"].optional, true);
	assert.equal(manifest.dependencies?.["@aeondave/pi-persona"], undefined, "installing Mind must not bundle another Persona runtime");
	assert.ok(manifest.files.includes("assets/banner.png"));
	assert.ok(existsSync(new URL("../assets/banner.png", import.meta.url)));
	assert.equal(manifest.pi.image, `https://raw.githubusercontent.com/AeonDave/pi-persona-mind/v${manifest.version}/assets/banner.png`);
});

test("every version statement agrees with the manifest", () => {
	const manifest = json("../package.json");
	const text = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
	const compat = text("../src/core/host-compat.ts");
	const readme = text("../README.md");
	const changelog = text("../CHANGELOG.md");
	const floor = /MIN_PI_VERSION = "([^"]+)"/.exec(compat)?.[1];
	assert.ok(floor, "host-compat.ts declares MIN_PI_VERSION");
	for (const host of ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"]) {
		assert.equal(manifest.devDependencies[`@earendil-works/${host}`], floor, `${host} pin equals MIN_PI_VERSION`);
	}
	assert.ok(readme.includes(`Mind ${manifest.version} requires **Pi ${floor}**`), "README states the manifest version and the Pi floor");
	assert.ok(changelog.includes(`## [${manifest.version}]`), "CHANGELOG has a heading for the manifest version");
	assert.ok(changelog.includes(`/releases/tag/v${manifest.version})`), "CHANGELOG heading links the manifest version tag");
	assert.ok(readme.includes(`pi-persona-mind/v${manifest.version}/assets/banner.png`), "README banner uses the manifest tag");
	assert.ok(manifest.pi.image.includes(`/v${manifest.version}/`), "manifest banner URL uses the manifest tag");
	const range = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.peerDependencies["@aeondave/pi-persona"])?.[1];
	assert.ok(range, "the pi-persona peer is a >= range");
	assert.ok(readme.includes(`pi-persona ${range}+`), "README states the pi-persona range the manifest requires");
});
