/** Small real-process driver for cross-process store and optimizer tests. */
import { access, writeFile } from "node:fs/promises";
import { selectAutoInputPage } from "../../src/core/auto-optimize.ts";
import { resolveScope } from "../../src/core/scope.ts";
import { MindService, type RememberInput } from "../../src/core/service.ts";

interface Request {
	action: "remember" | "recall" | "auto-input-project-long" | "compete";
	agentDir: string;
	workspace: string;
	persona: string;
	remember?: RememberInput;
	query?: string;
	readScope?: "long" | "short" | "both" | "project" | "persona" | "shared";
	sourceId?: string;
	replacement?: string;
	stagedFile?: string;
	releaseFile?: string;
}

function requestFromArgs(): Request {
	const raw = process.argv[2];
	if (!raw) throw new Error("memory process request is missing");
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("memory process request is invalid");
	const request = value as Partial<Request>;
	if (!request.agentDir || !request.workspace || !request.persona || !request.action) throw new Error("memory process scope is incomplete");
	return request as Request;
}

async function waitForRelease(path: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		try { await access(path); return; }
		catch { if (Date.now() >= deadline) throw new Error("optimizer release barrier timed out"); }
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

async function run(request: Request): Promise<unknown> {
	const scope = resolveScope(request.agentDir, request.workspace, { persona: request.persona });
	const service = new MindService(scope);
	if (request.action === "remember") {
		if (!request.remember) throw new Error("remember input is missing");
		return service.remember(request.remember);
	}
	if (request.action === "recall") return service.recall(request.query ?? "", request.readScope ?? "both", 100);
	const optimizer = service.createOptimizer();
	if (request.action === "auto-input-project-long") {
		const inspection = await optimizer.inspect("project-long");
		if (!inspection.ok) return inspection;
		const selected = selectAutoInputPage(inspection, request.persona);
		return { ok: true, entries: selected.input?.entries ?? [], eligibleCount: selected.eligibleCount };
	}
	if (!request.sourceId || !request.replacement || !request.stagedFile || !request.releaseFile) throw new Error("optimizer race inputs are incomplete");
	const inspection = await optimizer.inspect("project-long");
	if (!inspection.ok) throw new Error(inspection.reason);
	const source = inspection.entries.find((entry) => entry.id === request.sourceId);
	if (!source) throw new Error("optimizer race source is not visible to this persona");
	const plan = await optimizer.preview({
		target: "project-long",
		fingerprint: inspection.fingerprint,
		operations: [{ sourceIds: [source.id], kind: source.kind, text: request.replacement }],
	});
	if (!plan.ok) throw new Error(plan.reason);
	await writeFile(request.stagedFile, JSON.stringify({ planId: plan.planId }), "utf8");
	await waitForRelease(request.releaseFile);
	const applied = await optimizer.apply(plan.planId);
	const final = await optimizer.inspect("project-long");
	return { applied, final };
}

try {
	process.stdout.write(`${JSON.stringify(await run(requestFromArgs()))}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exitCode = 1;
}
