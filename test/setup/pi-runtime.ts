/** Real Pi SDK harness: source loader, agent loop and tool pipeline; no cloud or user profile. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, VERSION, type AgentSession, type ExtensionFactory, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

export async function runtimeHarness(root: string, extensionPath: string, factories: ExtensionFactory[] = []) {
  assert.equal(VERSION, "1.0.0", "run against the actual minimum supported host");
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = agentDir;
  const restoreEnvironment = () => {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
  };
  let createdSession: AgentSession | undefined;
  try {
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const eventBus = createEventBus();
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: settings, eventBus,
      additionalExtensionPaths: [extensionPath], extensionFactories: factories,
      noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, [], "the public host loader accepts the extension");
    assert.equal(loader.getExtensions().extensions.length, 1 + factories.length, "the host actually loads the requested extension");
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "offline-auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "offline-models.json"),
      refreshOnCreate: false, allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "companion-offline-test", models: [{ id: "offline" }] });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey("companion-offline-test", "synthetic-not-transmitted");
    const { session } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader, settingsManager: settings,
      modelRuntime: runtime, model: faux.getModel(), sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
    });
    createdSession = session;
    const notifications: string[] = [];
    const statuses: string[] = [];
    const widgets: string[] = [];
    const ui: ExtensionUIContext = {
      select: async () => undefined, confirm: async () => false, input: async () => undefined,
      notify: (text) => { notifications.push(text); }, onTerminalInput: () => () => {},
      setStatus: (_key, text) => { statuses.push(text ?? ""); },
      setWidget: (_key, lines) => { if (Array.isArray(lines)) widgets.push(...lines); },
      setWorkingMessage: () => {}, setWorkingVisible: () => {}, setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {}, setFooter: () => {}, setHeader: () => {}, setTitle: () => {},
      custom: async <T>() => undefined as T, pasteToEditor: () => {}, setEditorText: () => {},
      getEditorText: () => "", editor: async () => undefined, addAutocompleteProvider: () => {},
      setEditorComponent: () => {}, getEditorComponent: () => undefined,
      theme: { fg: (_color: string, text: string) => text } as ExtensionUIContext["theme"],
      getAllThemes: () => [], getTheme: () => undefined,
      setTheme: () => ({ success: true }), getToolsExpanded: () => false, setToolsExpanded: () => {},
    };
    return {
      cwd, agentDir, eventBus, session, faux, ui, notifications, statuses, widgets,
      bind: () => session.bindExtensions({ mode: "rpc", uiContext: ui }),
      dispose: async () => {
        try { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
        finally {
          try { await session.abort(); }
          finally {
            try { session.dispose(); }
            finally { restoreEnvironment(); }
          }
        }
      },
    };
  } catch (error) {
    try { createdSession?.dispose(); }
    finally { restoreEnvironment(); }
    throw error;
  }
}
