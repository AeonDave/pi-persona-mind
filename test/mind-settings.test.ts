import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resetMindSettings, resolveMindSettings } from "../src/core/mind-settings.ts";

async function fixture(run: (root: string, path: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "ppm-prefs-"));
	await mkdir(join(root, "persona"));
	try { await run(root, join(root, "persona", "settings.json")); }
	finally { await rm(root, { recursive: true, force: true }); }
}
const saved = (mindCapture: "auto" | "off" | "prompt", mindNudge: boolean) => JSON.stringify({ version: 1, preferences: { mindCapture, mindNudge }, personas: {}, lastPersona: "irrelevant" });

test("Mind preferences are session snapshots; resetting a child never refreshes its parent", async () => fixture(async (root, path) => {
	await writeFile(path, saved("off", false));
	assert.deepEqual(resolveMindSettings(root, {}, "parent"), { mindCapture: "off", mindNudge: false });
	await writeFile(path, saved("prompt", true));
	resetMindSettings("child");
	assert.deepEqual(resolveMindSettings(root, {}, "parent"), { mindCapture: "off", mindNudge: false });
	assert.deepEqual(resolveMindSettings(root, {}, "child"), { mindCapture: "prompt", mindNudge: true });
	resetMindSettings("parent");
	assert.deepEqual(resolveMindSettings(root, {}, "parent"), { mindCapture: "prompt", mindNudge: true });
}));

test("Mind canonical preferences accept BOM/CRLF and environment overrides without rewriting settings", async () => fixture(async (root, path) => {
	const raw = `\ufeff${saved("prompt", true)}\r\n`;
	await writeFile(path, raw);
	assert.deepEqual(resolveMindSettings(root, {}, "saved"), { mindCapture: "prompt", mindNudge: true });
	assert.deepEqual(resolveMindSettings(root, { PI_PERSONA_MIND_CAPTURE: "invalid", PI_PERSONA_MIND_NUDGE: "off" }, "env"), { mindCapture: "auto", mindNudge: false });
	assert.equal(await readFile(path, "utf8"), raw);
}));

test("malformed, oversized, foreign-version and invalid UTF8 settings use safe Mind defaults only", async () => fixture(async (root, path) => {
	const invalid = ["{", JSON.stringify({ version: 999, preferences: { mindCapture: "off" } }), JSON.stringify({ version: 1, preferences: { mindCapture: ["off"] } }), " ".repeat(1024 * 1024 + 1), Buffer.from([0xc3, 0x28])];
	for (let i = 0; i < invalid.length; i++) {
		await writeFile(path, invalid[i]!);
		assert.deepEqual(resolveMindSettings(root, {}, `bad-${i}`), { mindCapture: "auto", mindNudge: true });
	}
}));

test("absent canonical preferences ignore retired selection files and their override", async () => fixture(async (root) => {
	await writeFile(join(root, "persona", "state.json"), saved("off", false));
	assert.deepEqual(resolveMindSettings(root, { PI_PERSONA_STATE_FILE: join(root, "persona", "state.json") }, "absent"), { mindCapture: "auto", mindNudge: true });
}));
