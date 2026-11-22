import type { MemoryEvaluationCase, MemoryEvaluationFact } from "./memory-evaluation.ts";

/** Independently supervisor-labelled synthetic examples, withheld during initial implementation.
 * This is a small hand-authored holdout, not an external dataset or a semantic-quality benchmark.
 */
const texts = {
	hdr: "HTTPResponseParser validates inbound headers.",
	backoff: "Request cancellation calls cancelPendingRequest before releasing resources.",
	cafe: "The café worker owns menu formatting.",
	accentExact: "The cafe directory contains migration scripts.",
	path: "The parser implementation lives at src/parser-v2.ts.",
	version: "The supported release is Node 22.19.0.",
	noisy: "The painter updates response colors.",
	negation: "Never retry failed payment authorization.",
	identifier: "release22_19_0",
};

export const HELDOUT_RETRIEVAL_FACTS: readonly MemoryEvaluationFact[] = Object.entries(texts).map(([id, text]) => ({
	id, text, kind: "note", tags: [], tier: "persona",
	recordedAt: "2026-10-24T00:00:00.000Z", lastSeenAt: "2026-10-24T00:00:00.000Z",
}));

export const HELDOUT_RETRIEVAL_CASES: readonly MemoryEvaluationCase[] = [
	{ id: "heldout-http", query: "HTTP response parser", relevantIds: ["hdr"], why: "identifier boundary versus generic response noise" },
	{ id: "heldout-cancel", query: "cancel pending request", relevantIds: ["backoff"], why: "identifier word boundaries" },
	{ id: "heldout-accent-exact", query: "café", relevantIds: ["cafe"], acceptableIds: ["accentExact"], why: "original accent outranks folded alternative" },
	{ id: "heldout-ascii-exact", query: "cafe", relevantIds: ["accentExact"], acceptableIds: ["cafe"], why: "original ASCII outranks folded alternative" },
	{ id: "heldout-path", query: "src/parser-v2.ts", relevantIds: ["path"], why: "exact path priority" },
	{ id: "heldout-version", query: "Node 22.19.0", relevantIds: ["version"], why: "exact version with shared language word" },
	{ id: "heldout-unknown", query: "GraphQL schema", relevantIds: [], why: "negative vocabulary control" },
	{ id: "heldout-negation", query: "never retry payment", relevantIds: ["negation"], why: "negation retained" },
	{ id: "heldout-numeric-neighbor", query: "22.19.1", relevantIds: [], why: "numeric identifier must not imply a neighboring version" },
];
