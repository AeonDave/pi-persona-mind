import assert from "node:assert/strict";
import {
	createExtensionRuntime, ExtensionRunner, SessionManager,
	type BeforeAgentStartEvent, type BuildSystemPromptOptions, type Extension, type ModelRegistry,
} from "@earendil-works/pi-coding-agent";

/** Exercise Pi's shared options, returned override handling and live systemPrompt getter. */
export async function preparePrompt(
	handler: (event: unknown, context: unknown) => unknown,
	prompt: string,
	context: { cwd: string },
	options: Omit<BuildSystemPromptOptions, "cwd"> = {},
) {
	let event: BeforeAgentStartEvent | undefined;
	const extension = {
		path: "<inline:mind-test>",
		handlers: new Map([["before_agent_start", [async (input: unknown) => {
			event = input as BeforeAgentStartEvent;
			return handler(event, context);
		}]]]),
	} as Extension;
	const runner = new ExtensionRunner([extension], createExtensionRuntime(), context.cwd, SessionManager.inMemory(context.cwd), {} as ModelRegistry);
	const errors: string[] = [];
	runner.onError((error) => errors.push(error.error));
	const { systemPromptOptions } = await runner.emitBeforeAgentStart(
		{ messageType: "user", prompt },
		{ cwd: context.cwd, customPrompt: "BASE", ...options },
	);
	assert.deepEqual(errors, []);
	assert.ok(event);
	const observed = event;
	return { systemPromptOptions, get systemPrompt() { return observed.systemPrompt; } };
}
