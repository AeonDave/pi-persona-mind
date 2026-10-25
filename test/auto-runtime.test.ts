/** Actual Pi lifecycle/tool pipeline; only the worker transport is an offline protocol fixture. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { MindService } from "../src/core/service.ts";
import { resolveScope } from "../src/core/scope.ts";
import type { MindWorkerResult } from "../src/extension/mind-worker.ts";
import { runtimeHarness } from "./setup/pi-runtime.ts";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const notes = ["Use concise release notes.", "Release notes should be concise and include verified test results."];
const replacement = "Use concise release notes that include verified test results.";
type Harness = Awaited<ReturnType<typeof runtimeHarness>>;
type Result = MindWorkerResult;

function workerFixture() {
	const requests: Array<{ task: string; finish: (result: Result) => void }> = [];
	let cancellations = 0;
	const factory: ExtensionFactory = (pi) => {
		pi.events.on("pi-persona:mind-worker:v1", (raw: unknown) => {
			const request = raw as { task: string; respond: (reply: unknown) => void };
			let finish!: (result: Result) => void;
			const completion = new Promise<Result>((resolve) => { finish = resolve; });
			requests.push({ task: request.task, finish });
			request.respond({ ok: true, runId: `mind-test-${requests.length}`, model: "offline/current", thinking: "high", completion,
				cancel: () => { cancellations++; finish({ status: "stopped", ok: false, output: "" }); } });
		});
	};
	return { factory, requests, cancellations: () => cancellations };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
	const end = Date.now() + 8_000;
	while (!predicate()) {
		assert.ok(Date.now() < end, `Timed out: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
function cards(h: Harness) {
	return h.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "pi-persona-mind-result");
}
function usageMessage(input: number, output: number, cacheRead = 0) {
	const message = fauxAssistantMessage("Acknowledged.");
	message.usage = { ...message.usage, input, output, cacheRead, totalTokens: input + output + cacheRead };
	return message;
}
async function seed(h: Harness) {
	const scope = resolveScope(h.agentDir, h.cwd, { persona: null });
	const mind = new MindService(scope);
	for (const text of notes) await mind.remember({ term: "long", kind: "convention", text });
	return scope;
}

test("native automatic optimization coalesces saves, preserves history and applies without another supervisor turn", { timeout: 20_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "mind-auto-native-save-"));
	let h: Harness | undefined;
	const worker = workerFixture();
	try {
		h = await runtimeHarness(root, entry, [worker.factory]);
		await h.bind();
		h.session.setActiveToolsByName(["memory"]);
		h.faux.setResponses([
			fauxAssistantMessage(notes.map((text) => fauxToolCall("memory", { action: "remember", term: "long", kind: "convention", text })), { stopReason: "toolUse" }),
			fauxAssistantMessage("Saved both verified facts."),
		]);
		await h.session.prompt("Save these verified release conventions.");
		assert.equal(worker.requests.length, 0, "a running turn never starts maintenance");
		await until(() => worker.requests.length === 1, "settled save triggers one worker");
		const scope = resolveScope(h.agentDir, h.cwd, { persona: null });
		const before = JSON.parse(await readFile(scope.paths.ltm, "utf8"));
		assert.equal(before.entries.length, 2, "the worker cannot mutate stores");
		const payload = JSON.parse(worker.requests[0]!.task.split("\n").at(-1)!);
		assert.equal(payload.entries.length, 2);
		assert.match(worker.requests[0]!.task, /Return exactly one JSON object/);
		worker.requests[0]!.finish({ status: "done", ok: true, output: JSON.stringify({ operations: [{ sourceIds: payload.entries.map((e: { id: string }) => e.id), kind: "convention", text: replacement }] }), resultRef: "result:offline" });
		await until(() => JSON.stringify(cards(h!)).includes("Mind automatic result"), "automatic parent apply");
		const after = JSON.parse(await readFile(scope.paths.ltm, "utf8"));
		assert.equal(after.entries.length, 1);
		assert.equal(after.entries[0].text, replacement);
		assert.equal(after.entries[0].derivedFrom.length, 2);
		const history = JSON.stringify(cards(h));
		assert.ok(history.indexOf("Mind automatic proposal") < history.indexOf("Mind automatic result"));
		assert.ok(notes.every((text) => history.includes(text)), "full source evidence survives replacement");
		assert.match(history, /result:offline/);
		assert.equal(h.faux.state.callCount, 2, "maintenance never wakes the main model");
	} finally { await h?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("native optimizer requires one million main input tokens and a dirty store, then foreground input cancels its worker", { timeout: 20_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "mind-auto-native-tokens-"));
	let h: Harness | undefined;
	const worker = workerFixture();
	const boundaries: TurnEndEvent[] = [];
	const observe: ExtensionFactory = (pi) => { pi.on("turn_end", (event) => { boundaries.push(event); }); };
	const realDateNow = Date.now;
	let clockOffset = 0;
	try {
		Date.now = () => realDateNow() + clockOffset;
		h = await runtimeHarness(root, entry, [worker.factory, observe]);
		await h.bind();
		h.session.setActiveToolsByName(["memory"]);
		h.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("memory", { action: "remember", term: "long", kind: "convention", text: "The first optimizer batch keeps verified release evidence." }),
				fauxToolCall("memory", { action: "remember", term: "long", kind: "convention", text: "Release evidence remains scoped to this persona." }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("Saved both verified facts."),
		]);
		await h.session.prompt("Save these verified release conventions.");
		await until(() => worker.requests.length === 1, "the first dirty batch bypasses the token floor");
		worker.requests[0]!.finish({ status: "done", ok: true, output: JSON.stringify({ operations: [] }), resultRef: "result:first" });
		await until(() => JSON.stringify(cards(h!)).includes("bounded review found no safe consolidation"), "first review receipt settles");

		// Move beyond the safety cooldown without waiting five minutes in real time. The later
		// review still needs dirty memory and one million main input tokens.
		clockOffset = 5 * 60_000 + 1;
		const scope = resolveScope(h.agentDir, h.cwd, { persona: null });
		const start = boundaries.length;
		h.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("memory", { action: "remember", term: "long", kind: "convention", text: "A second fact waits for the main input budget." }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Saved the additional fact."),
		]);
		await h.session.prompt("Save one more verified convention.");
		assert.equal(worker.requests.length, 1, "a new dirty record alone cannot start another review");
		const before = await readFile(scope.paths.ltm, "utf8");
		const countedInput = boundaries.slice(start).reduce((total, event) => event.message.role === "assistant" ? total + event.message.usage.input : total, 0);
		assert.ok(countedInput < 999_999, "the ordinary memory-save turn stays below the floor");
		const base = boundaries.at(-1)!;
		const to999999: TurnEndEvent = { ...base, messageEntryId: "accounting-fixture-999999", message: usageMessage(999_999 - countedInput, 500_000, 600_000) };
		await h.session.extensionRunner!.emitBoundary(to999999, () => to999999.context);
		await h.session.extensionRunner!.emitBoundary(to999999, () => to999999.context);
		await h.session.extensionRunner!.emit({ type: "agent_settled", aborted: false });
		assert.equal(worker.requests.length, 1, "output, cache reads and a duplicate event do not reach the input floor");
		const finalInput: TurnEndEvent = { ...to999999, messageEntryId: "accounting-fixture-1000000", message: usageMessage(1, 0, 600_000) };
		await h.session.extensionRunner!.emitBoundary(finalInput, () => finalInput.context);
		await h.session.extensionRunner!.emit({ type: "agent_settled", aborted: false });
		await until(() => worker.requests.length === 2, "one million main input tokens plus dirty memory and cooldown admit the review");
		h.faux.setResponses([usageMessage(0, 0)]);
		await h.session.prompt("Resume foreground work.");
		assert.equal(worker.cancellations(), 1, "new input cancels the active Mind worker");
		assert.equal(await readFile(scope.paths.ltm, "utf8"), before, "a cancelled proposal cannot replace memory");
		assert.doesNotMatch(JSON.stringify(cards(h)), /Mind automatic proposal/);
	} finally { Date.now = realDateNow; await h?.dispose(); await rm(root, { recursive: true, force: true }); }
});
