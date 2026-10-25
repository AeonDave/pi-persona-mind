/** Manual provider smoke. The mind-auto-fixture provider supplies offline pipeline evidence only. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

const [modelRef, engine, parentEntry, mode, mindOverride] = process.argv.slice(2);
if (!modelRef?.includes("/") || !["inproc", "child"].includes(engine) || !parentEntry || (mode !== undefined && mode !== "--auto" && mode !== "--owner")) {
	throw new Error("Usage (real providers spend model tokens): node --import tsx scripts/live-owner-smoke.mjs <provider/model> <inproc|child> <pi-persona-extension> [--auto|--owner [pi-persona-mind-extension]]");
}
const automatic = mode === "--auto";
const offline = modelRef.startsWith("mind-auto-fixture/");
const { effortSigla } = await import(pathToFileURL(join(dirname(resolve(parentEntry)), "core", "leg-thinking.ts")).href);
const originalAgentDir = getAgentDir();
const originalEnv = { ...process.env };
const originalArgv = [...process.argv];
const root = await mkdtemp(join(tmpdir(), "mind-live-owner-"));
const agentDir = join(root, "agent");
const cwd = join(root, "workspace");
const mindEntry = mindOverride ? resolve(mindOverride) : fileURLToPath(new URL("../src/index.ts", import.meta.url));
const fixtureEntry = join(root, "auto-fixture.mjs");
let session;
let finishAutomatic;
const automaticFinished = new Promise((done) => { finishAutomatic = done; });
const notifications = [];
const widgets = [];
const theme = new Proxy({}, { get: () => (...args) => args.at(-1) ?? "" });
// A real UI adapter is needed for hasUI; the RPC mode name alone does not supply one.
const rpcUi = {
	select: async () => undefined, confirm: async () => false, input: async () => undefined,
	notify: (message, level) => {
		notifications.push({ message: String(message), level });
		if (String(message).startsWith("Mind · ")) finishAutomatic();
	},
	onTerminalInput: () => () => {}, setStatus: () => {},
	setWidget: (key, content) => {
		if (key !== "persona-agents" || !content) return;
		const lines = Array.isArray(content) ? content : content({ requestRender() {} }, theme).render(160);
		widgets.push(lines.join("\n"));
	},
	setWorkingMessage: () => {}, setWorkingVisible: () => {}, setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {}, setFooter: () => {}, setHeader: () => {}, setTitle: () => {},
	custom: async () => undefined, pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "",
	editor: async () => undefined, addAutocompleteProvider: () => {}, setEditorComponent: () => {}, getEditorComponent: () => undefined,
	theme, getAllThemes: () => [], getTheme: () => undefined, setTheme: () => ({ success: true }),
	getToolsExpanded: () => false, setToolsExpanded: () => {},
};
try {
	// Persona normally runs inside Pi's CLI and re-invokes that entry for child workers. This SDK
	// harness supplies that same entry so child mode launches Pi, not this qualification script.
	process.argv = [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")))];
	for (const key of Object.keys(process.env)) if (/^PI_PERSONA_/i.test(key)) delete process.env[key];
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_PERSONA_ENGINE = engine;
	process.env.PI_PERSONA_AGENT_MAX_MS = "120000";
	await mkdir(join(agentDir, "persona", "agents"), { recursive: true });
	await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
	const split = modelRef.indexOf("/");
	const provider = modelRef.slice(0, split);
	// Only the selected provider's credential enters this private, short-lived profile. Child Pi
	// resolves auth from its own profile; refreshes must not mutate the user's original auth file.
	if (!offline) try {
		const credentials = JSON.parse(await readFile(join(originalAgentDir, "auth.json"), "utf8"));
		if (Object.hasOwn(credentials, provider)) await writeFile(join(agentDir, "auth.json"), JSON.stringify({ [provider]: credentials[provider] }), { mode: 0o600 });
	} catch (error) { if (error?.code !== "ENOENT") throw error; }
	if (offline) await writeFile(fixtureEntry, `import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export function createFixture() {
  const fixture = fauxProvider({ provider: "mind-auto-fixture", api: "mind-auto-fixture-api", models: [{ id: "gpt-6-luna", name: "Offline scripted Mind qualification", reasoning: true }], tokensPerSecond: 600 });
  fixture.models[0].thinkingLevelMap = { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null };
  const respond = async (context) => {
    const last = [...context.messages].reverse().find((message) => message.role === "user");
    const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\\n");
    const marker = text.lastIndexOf('\\n{"target":');
    let body = "READY";
    if (text.includes("owner verification marker")) {
      const systems = context.messages.filter((message) => message.role === "system");
      const memory = JSON.stringify(systems);
      const tools = systems.flatMap((message) => message.toolsAdded ?? []).map((tool) => typeof tool === "string" ? tool : tool.name);
      if (!memory.includes("AMBER-ALPHA-947") || memory.includes("WRONG-BETA")) throw new Error("Worker persona inheritance failed");
      if (["PRIVATE-PROJECT-ONLY", "PRIVATE-STM-ONLY", "PRIVATE-SESSION-ONLY", "PRIVATE-BACKLOG-ONLY"].some((marker) => memory.includes(marker))) throw new Error("Worker received non-lean memory");
      if (tools.includes("memory") || tools.includes("backlog") || !tools.includes("read")) throw new Error("Worker memory tools were not withheld");
      body = "AMBER-ALPHA-947";
    }
    if (marker >= 0) {
      const payload = JSON.parse(text.slice(marker + 1));
      if (payload.entries.length !== 2) throw new Error("Offline fixture expected two supplied source records");
      body = JSON.stringify({ operations: [{ sourceIds: payload.entries.map((entry) => entry.id), kind: "note", text: "The Aurora qualification project's release report must include both the test summary and the exact release version." }] });
    }
    const message = fauxAssistantMessage(body);
    message.usage = { ...message.usage, input: 200, output: 70, totalTokens: 270 };
    return message;
  };
  fixture.setResponses(Array.from({ length: 8 }, () => respond));
  return fixture;
}
export default function(pi) { pi.registerProvider(createFixture().provider); }
`);
	const extensionPaths = [...(offline ? [fixtureEntry] : []), mindEntry, resolve(parentEntry)];
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: extensionPaths }));
	await writeFile(join(agentDir, "persona", "settings.json"), JSON.stringify({ version: 1, preferences: { persist: false }, personas: {}, lastPersona: null, selectionRevision: 0 }));
	for (const persona of ["alpha", "beta"]) await writeFile(join(agentDir, "persona", "agents", `${persona}.md`), `---\nname: ${persona}\nlabel: ${persona}\npersona: true\n---\nAn isolated memory qualification persona.\n`);
	await writeFile(join(cwd, ".pi", "agents", "memory-probe.md"), "---\nname: memory-probe\ndescription: Return the supplied memory marker\ntools: read\n---\nReturn only the requested verification marker from the provided context. Do not call tools.\n");
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
		additionalExtensionPaths: extensionPaths, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"),
		modelsPath: offline ? null : join(originalAgentDir, "models.json"), modelsStorePath: join(root, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
	if (offline) {
		runtime.registerNativeProvider((await import(pathToFileURL(fixtureEntry).href)).createFixture().provider);
		await runtime.setRuntimeApiKey(provider, "synthetic-qualification-key-never-transmitted");
	}
	const model = runtime.getModel(provider, modelRef.slice(split + 1));
	assert.ok(model, "Requested model is absent from the configured catalog");
	const setupProvider = fauxProvider({ provider: "owner-smoke-setup", models: [{ id: "offline" }] });
	setupProvider.setResponses([fauxAssistantMessage("INITIALIZED")]);
	runtime.registerNativeProvider(setupProvider.provider);
	await runtime.setRuntimeApiKey("owner-smoke-setup", "synthetic-not-transmitted");
	const created = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager,
		modelRuntime: runtime, model: setupProvider.getModel(), sessionManager: automatic ? SessionManager.create(cwd, join(root, "sessions")) : SessionManager.inMemory(cwd) });
	session = created.session;
	await session.bindExtensions(automatic ? { mode: "rpc", uiContext: rpcUi } : { mode: "print" });
	// Pi's executeTool pipeline requires an assistant message; setup stays offline. The delegated
	// worker below is provider-pinned and makes the real request being qualified.
	await session.prompt("Initialize this isolated qualification session.");
	await session.setModel(model);
	session.setThinkingLevel("xhigh");
	// Pi clamps unsupported choices before the companion reads the supervisor's actual effort.
	const supervisorThinking = session.thinkingLevel;
	if (offline) assert.equal(supervisorThinking, "xhigh", "the scripted fixture must retain its explicit xhigh support");
	if (automatic) {
		await session.prompt("/persona alpha");
		const ctx = session.extensionRunner.createToolContext("live-auto-memory-setup", undefined);
		assert.equal(ctx.hasUI, true, "automatic review must be qualified with a live native UI adapter");
		assert.equal(ctx.mode, "rpc");
		const remember = async (text) => {
			const result = await ctx.executeTool("memory", { action: "remember", term: "long", kind: "note", text });
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.equal(result.result?.details?.ok, true);
		};
		await remember("The Aurora qualification project's release report must include the test summary and the exact release version.");
		await remember("For the Aurora qualification project, include both the exact release version and a summary of the tests in every release report.");
		const before = await ctx.executeTool("memory", { action: "optimize", mode: "inspect", target: "persona", max: 100 });
		assert.equal(before.isError, false);
		assert.equal(before.result?.details?.total, 2, "the isolated smoke must start with exactly its two saved facts");
		let starts = 0;
		let settled = 0;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_start") starts++;
			if (event.type === "agent_settled") settled++;
		});
		let deadline;
		try {
			const timeout = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`Automatic review did not finish within 150 seconds: ${JSON.stringify({ notifications, widgets: widgets.slice(-4) })}`)), 150_000); });
			// This native foreground request ends naturally in agent_settled. We do not call
			// the scheduler, worker service, or lifecycle emitter to manufacture the trigger.
			await session.prompt("Reply with exactly READY. Do not call any tools.", { source: "interactive" });
			const reply = session.agent.state.messages.at(-1);
			assert.equal(reply?.role, "assistant", "the native foreground turn must finish with an assistant message");
			assert.notEqual(reply.stopReason, "error", `Foreground provider request failed: ${reply.errorMessage ?? "unknown provider error"}`);
			assert.notEqual(reply.stopReason, "aborted", "the native foreground trigger was aborted");
			await Promise.race([automaticFinished, timeout]);
		} finally { clearTimeout(deadline); unsubscribe(); }
		const entries = session.sessionManager.getBranch();
		const cards = entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-persona-mind-result").map((entry) => entry.data);
		const terminal = entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-persona-terminal-result" && entry.data?.agent === "mind");
		assert.equal(terminal.length, 1, "one actual worker terminal report must be archived");
		const report = terminal[0].data;
		assert.equal(report.status, "done", JSON.stringify(report));
		assert.equal(report.model, modelRef);
		assert.equal(report.thinkingRequested, supervisorThinking, "the worker must inherit the native supervisor's actual effort");
		assert.ok(report.usage.input + report.usage.output > 0, "the provider response must carry recorded usage");
		const displayModel = modelRef.split("/").at(-1).replace(/^claude-/, "");
		const effortTag = effortSigla(supervisorThinking);
		const workerWidget = widgets.find((text) => /Mind/.test(text) && text.includes(displayModel) && (!effortTag || text.includes(` · ${effortTag}`)));
		assert.ok(workerWidget, "the real worker must appear in the native agent widget with its selected model and effort");
		assert.equal(starts, 1, "maintenance must not wake a second foreground turn");
		assert.equal(settled, 1, "the foreground trigger must reach native agent_settled once");
		const result = cards.find((card) => card.title === "Mind automatic result");
		const noOp = cards.find((card) => card.title === "Mind automatic optimization" && /bounded review found no safe consolidation/.test(card.content));
		assert.ok(result || noOp, `Expected applied proposal or an explicit conservative no-op: ${JSON.stringify(cards)}`);
		if (result) assert.ok(cards.some((card) => card.title === "Mind automatic proposal" && /Staged automatic change/.test(card.content)), "before/after proposal must precede automatic application");
		const after = await ctx.executeTool("memory", { action: "optimize", mode: "inspect", target: "persona", max: 100 });
		assert.equal(after.isError, false);
		assert.ok(after.result?.details?.total >= 1 && after.result.details.total <= 2, "safe consolidation preserves at least one fact and cannot add unrelated records");
		if (noOp) assert.equal(after.result?.details?.fingerprint, before.result.details.fingerprint, "a conservative no-op must leave the exact store unchanged");
		const diskHistory = await readFile(session.sessionManager.getSessionFile(), "utf8");
		assert.match(diskHistory, /pi-persona-terminal-result/);
		assert.match(diskHistory, /Mind automatic (?:result|optimization)/);
		console.log(JSON.stringify({ status: "PASS", mode: "automatic", providerKind: offline ? "offline-scripted-fixture" : "real-provider", engine, model: report.model, thinkingRequested: report.thinkingRequested, thinkingEffective: report.thinkingEffective, nativeAgentSettled: settled, nativeWorkerView: true, terminalReport: { ref: report.ref, status: report.status, usage: report.usage, body: report.body }, outcome: result ? "applied" : "conservative-no-op", beforeCount: before.result.details.total, afterCount: after.result.details.total, cards, widget: workerWidget }));
	} else {
	await session.prompt("/persona beta");
	let ctx = session.extensionRunner.createToolContext("live-memory-setup", undefined);
	const remember = async (text) => {
		const result = await ctx.executeTool("memory", { action: "remember", term: "long", kind: "note", text });
		assert.equal(result.isError, false, `Memory fixture write failed: ${JSON.stringify(result.result?.content ?? result.error ?? result)}`);
		assert.equal(result.result?.details?.ok, true);
	};
	await remember("The owner verification marker is WRONG-BETA.");
	await session.prompt("/persona alpha");
	ctx = session.extensionRunner.createToolContext("live-memory-probe", undefined);
	await remember("The owner verification marker is AMBER-ALPHA-947.");
	for (const args of [
		{ action: "remember", term: "long", scope: "project", kind: "note", text: "PRIVATE-PROJECT-ONLY repository fixture." },
		{ action: "remember", term: "short", kind: "note", text: "PRIVATE-STM-ONLY active fixture." },
		{ action: "remember", term: "session", kind: "note", text: "PRIVATE-SESSION-ONLY branch fixture." },
	]) assert.equal((await ctx.executeTool("memory", args)).isError, false);
	assert.equal((await ctx.executeTool("backlog", { action: "add", text: "PRIVATE-BACKLOG-ONLY pending fixture." })).isError, false);
	const result = await ctx.executeTool("delegate", { tasks: [{ agent: "memory-probe", model: modelRef, thinking: "xhigh",
		task: "From the persona-mind reference block, return only the owner verification marker. Do not guess it and do not call tools. If no marker is present, return MISSING.\nRemember that DELEGATE-CAPTURE-MUST-NOT-PERSIST." }] });
	const body = (result.result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
	assert.equal(result.isError, false, `The live delegated run failed: ${body}`);
	assert.match(body, /AMBER-ALPHA-947/, "The delegated worker did not receive its frozen active persona's memory");
	assert.doesNotMatch(body, /WRONG-BETA/, "The delegated worker received the other persona's private memory");
	const notCaptured = await ctx.executeTool("memory", { action: "recall", scope: "both", query: "DELEGATE-CAPTURE-MUST-NOT-PERSIST" });
	assert.equal(notCaptured.result?.details?.count, 0, "A delegated task must never auto-capture into the parent persona store");
	console.log(JSON.stringify({ status: "PASS", providerKind: offline ? "offline-scripted-fixture" : "real-provider", model: modelRef, thinking: "xhigh", engine, persistence: false, frozenWorkerOwner: true, leanContextAndToolGuards: offline, noDelegatedCapture: true }));
	}
} finally {
	try {
		if (session) {
			try { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
			finally { await session.abort(); await session.agent.waitForIdle(); session.dispose(); }
		}
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, originalEnv);
		process.argv = originalArgv;
		assert.equal(dirname(resolve(root)), resolve(tmpdir()));
		assert.ok(root.split(/[\\/]/).at(-1).startsWith("mind-live-owner-"));
		await rm(root, { recursive: true, force: true });
	}
}
