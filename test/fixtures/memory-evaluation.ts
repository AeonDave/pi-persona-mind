import type { MemoryEntry, MemoryKind } from "../../src/core/memory.ts";

export type MemoryEvaluationTier = "persona" | "project" | "working";
export type MemoryEvaluationFact = MemoryEntry & { tier: MemoryEvaluationTier };

export interface MemoryEvaluationCase {
	id: string;
	query: string;
	/** Empty only for the explicit no-shared-vocabulary abstention case. */
	relevantIds: readonly string[];
	why: string;
}

export const MEMORY_EVALUATION_NOW = Date.parse("2026-10-25T00:00:00.000Z");
const DAY = 86_400_000;

function fact(
	id: string,
	kind: MemoryKind,
	text: string,
	tags: readonly string[],
	tier: MemoryEvaluationTier,
	lastSeenDaysAgo: number,
): MemoryEvaluationFact {
	const lastSeenAt = new Date(MEMORY_EVALUATION_NOW - lastSeenDaysAgo * DAY).toISOString();
	const entry: MemoryEvaluationFact = {
		id,
		kind,
		text,
		tags: [...tags],
		recordedAt: new Date(MEMORY_EVALUATION_NOW - Math.max(lastSeenDaysAgo, 2) * DAY).toISOString(),
		lastSeenAt,
		tier,
	};
	if (tier !== "persona") entry.persona = "elite";
	if (tier === "working") entry.expiresAt = new Date(MEMORY_EVALUATION_NOW + DAY).toISOString();
	return entry;
}

/** Synthetic fixtures. Every positive match is explainable by text, a hand-authored tag, or a path. */
export const MEMORY_EVALUATION_FACTS: readonly MemoryEvaluationFact[] = [
	fact("provider-pin", "invariant", "An explicitly provider-qualified model is strict by default and does not change billing providers.", ["provider pin", "strict fallback"], "persona", 80),
	fact("strict-recovery", "invariant", "Strategy recovery permits one main-model retry for provider or unknown-model failures only when user-authorized.", ["retry policy", "main model"], "persona", 72),
	fact("retry-exception", "gotcha", "Do not retry provider errors except for an unknown-model migration under explicit user authorization.", ["retry exception", "explicit user authorization"], "persona", 68),
	fact("retry-old", "note", "Retry any provider failure on the supervisor model regardless of policy.", ["retry policy", "legacy"], "persona", 240),
	fact("idle-window", "invariant", "The idle window resets on every event; tokens and streamed output count as startup progress.", ["idle timeout", "startup progress"], "persona", 40),
	fact("idle-old", "note", "An idle timeout is 300 seconds and each output chunk counts as completion.", ["idle timeout"], "project", 210),
	fact("wallclock-cap", "convention", "PI_PERSONA_AGENT_MAX_MS is an opt-in hard wall-clock cap and never resets.", ["agent max ms", "wall clock"], "persona", 38),
	fact("startup-current", "invariant", "PI_PERSONA_AGENT_STARTUP_MS kills a child that makes zero progress; first real output cancels the deadline.", ["startup deadline", "zero progress"], "persona", 3),
	fact("startup-old", "note", "The startup timeout is 60 seconds and resets after every event.", ["startup deadline", "startup timeout", "legacy"], "project", 170),
	fact("mcp-oauth", "gotcha", "A headless MCP leg can stall in pi-mcp-adapter while interactive OAuth remains unresolved.", ["startup hang", "mcp oauth"], "working", 4),
	fact("inject-path", "convention", "src/core/inject.ts renders complete memory entries inside the persona-mind trust fence.", ["memory injection", "whole entries"], "project", 18),
	fact("service-path", "rationale", "src/core/service.ts assembles persona, durable project, working, and backlog context.", ["context assembly", "service boundary"], "project", 22),
	fact("scope-path", "invariant", "src/core/scope.ts derives canonical project identity and collision-safe persona store paths.", ["project identity", "scope paths"], "project", 14),
	fact("memory-path", "note", "src/core/memory.ts ranks recall and leaves lastSeenAt unchanged on reads.", ["recall ranking", "read only"], "project", 16),
	fact("design-contract", "rationale", "docs/DESIGN.md requires the loaded memory-owner contract before any storage read.", ["design contract", "memory owner"], "project", 12),
	fact("project-isolation", "invariant", "Project durable memory belongs to one canonical repository and must never leak into other projects.", ["project owner", "repository isolation"], "project", 10),
	fact("session-branch", "invariant", "Session notes replay only on the active Pi branch and preserve their origin session ID.", ["branch notes", "session memory"], "persona", 45),
	fact("branch-exception", "gotcha", "Do not replay a note after a branch fork unless it exists on the active branch.", ["active branch", "except fork"], "persona", 32),
	fact("runtime-version", "convention", "The host baseline is Pi 1.4.0 and Node 22.19 or newer; historical host adapters are removed.", ["runtime version", "no legacy host"], "persona", 26),
	fact("promotion-order", "invariant", "Promotion writes the durable destination before removing STM, so interruption can leave a duplicate but never lose the source.", ["promotion order", "durable first"], "persona", 20),
	fact("project-schema-current", "note", "Project-long memory is durable, project STM expires, and durable project facts retain persona attribution.", ["project schema", "durable project"], "project", 2),
	fact("project-schema-old", "note", "Project memories are all short-lived and automatically expire after 48 hours.", ["project schema", "legacy"], "project", 100),
	fact("owner-current", "invariant", "The loaded memory-owner contract is authoritative; the saved Persona selection is not runtime identity.", ["persona selection", "loaded owner"], "persona", 1),
	fact("owner-old", "note", "Use saved Persona settings to choose the active memory owner.", ["persona selection", "saved owner"], "persona", 190),
	fact("capture-origin", "gotcha", "Only direct-user text is a capture request; quoted worker output remains reference material.", ["capture origin", "untrusted worker output"], "persona", 8),
	fact("wake-contract", "invariant", "Wakes are display-only and must never send a user message or trigger a model turn.", ["wake behavior", "no wake turn"], "persona", 6),
	fact("backlog-order", "convention", "Taken backlog work and due open items precede ordinary open work in the rendered context.", ["backlog order", "due priority"], "project", 7),
	fact("retrieval-contract", "rationale", "Retrieval is deterministic lexical and path ranking; tags are explicit bridges, not proof of semantic quality.", ["retrieval limits", "no embeddings"], "persona", 5),
	fact("no-synonym", "note", "Compaction preserves the active branch and latest summary for later reading.", ["active branch", "compaction"], "project", 9),
	fact("irrelevant-theme", "note", "The release screenshot uses a dark theme and a 1.17.4 icon.", ["screenshot", "theme"], "project", 0),
	fact("irrelevant-mobile", "note", "The mobile app uses Playwright screenshots for navigation menus.", ["mobile", "screenshots"], "working", 0),
];

export const MEMORY_EVALUATION_CASES: readonly MemoryEvaluationCase[] = [
	{ id: "provider-pin", query: "provider qualified model strict billing providers", relevantIds: ["provider-pin"], why: "known terms" },
	{ id: "strict-recovery", query: "strategy recovery main model user authorized", relevantIds: ["strict-recovery"], why: "known terms over older retry guidance" },
	{ id: "retry-exception", query: "do not retry provider errors except unknown model explicit authorization", relevantIds: ["retry-exception"], why: "negation and exception retention" },
	{ id: "idle-window", query: "idle timeout every event tokens streamed output progress", relevantIds: ["idle-window"], why: "known terms over an obsolete value" },
	{ id: "wallclock-cap", query: "hard wall clock cap never resets", relevantIds: ["wallclock-cap"], why: "known terms" },
	{ id: "startup-current", query: "startup deadline zero progress first real output", relevantIds: ["startup-current"], why: "known terms and current rule" },
	{ id: "mcp-oauth", query: "headless startup hang mcp oauth", relevantIds: ["mcp-oauth"], why: "explicit tag bridge" },
	{ id: "inject-path", query: "src/core/inject.ts whole entries trust fence", relevantIds: ["inject-path"], why: "exact repository path" },
	{ id: "service-path", query: "src/core/service.ts context assembly backlog", relevantIds: ["service-path"], why: "exact repository path" },
	{ id: "scope-path", query: "src/core/scope.ts project identity collision safe", relevantIds: ["scope-path"], why: "exact repository path" },
	{ id: "memory-path", query: "src/core/memory.ts recall ranking lastSeenAt", relevantIds: ["memory-path"], why: "exact repository path" },
	{ id: "design-contract", query: "docs/DESIGN.md loaded memory owner contract", relevantIds: ["design-contract"], why: "exact documentation path" },
	{ id: "project-isolation", query: "project owner repository isolation", relevantIds: ["project-isolation"], why: "explicit tag bridge" },
	{ id: "session-branch", query: "branch notes session memory origin session id", relevantIds: ["session-branch"], why: "explicit tag bridge" },
	{ id: "branch-exception", query: "do not replay note after branch fork unless active branch", relevantIds: ["branch-exception"], why: "negation and exception retention" },
	{ id: "runtime-version", query: "Pi 1.4.0 Node 22.19 no historical host adapters", relevantIds: ["runtime-version"], why: "known terms" },
	{ id: "promotion-order", query: "promotion durable destination before removing STM", relevantIds: ["promotion-order"], why: "known terms" },
	{ id: "project-schema-current", query: "current project schema durable persona attribution", relevantIds: ["project-schema-current"], why: "temporal correction with shared tags" },
	{ id: "owner-current", query: "loaded owner persona selection saved runtime identity", relevantIds: ["owner-current"], why: "temporal correction with shared tags" },
	{ id: "capture-origin", query: "direct user capture quoted worker output", relevantIds: ["capture-origin"], why: "source and trust boundary" },
	{ id: "wake-contract", query: "wakes display only no model turn", relevantIds: ["wake-contract"], why: "negative behavior invariant" },
	{ id: "backlog-order", query: "taken backlog due priority ordinary open work", relevantIds: ["backlog-order"], why: "explicit tag bridge" },
	{ id: "retrieval-contract", query: "retrieval limits tags paths no embeddings", relevantIds: ["retrieval-contract"], why: "explicit tag bridge" },
	{ id: "startup-old", query: "startup timeout 60 seconds", relevantIds: ["startup-old"], why: "historical value remains explicitly findable" },
	{ id: "idle-current", query: "current idle timeout events tokens", relevantIds: ["idle-window"], why: "temporal correction over recent obsolete detail" },
	{ id: "owner-current-again", query: "loaded persona selection active owner", relevantIds: ["owner-current"], why: "temporal correction over saved selection" },
	{ id: "recent-noise", query: "provider retry policy strict explicit user authorization", relevantIds: ["retry-exception"], why: "relevant older fact outranks recent unrelated notes" },
	{ id: "unlabeled-synonym-abstention", query: "resume conversation brownout", relevantIds: [], why: "no shared vocabulary or synonym tag; abstention is correct" },
];
