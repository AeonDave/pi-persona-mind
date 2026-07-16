/**
 * Deterministic, model-free capture-cue detection — the counter to the structural weakness of a
 * purely explicit memory (the agent forgets to call `remember`). Scans a user message for phrasing
 * that signals a durable preference/convention/instruction, and returns a candidate the extension
 * can surface as a gentle nudge on turn_end ("that looked worth remembering — memory remember?").
 *
 * No LLM, no network: just cues. It is deliberately a NUDGE source, not an auto-writer, so a false
 * positive costs nothing more than a one-line hint the agent can ignore.
 */

import type { MemoryKind } from "./memory.ts";

export interface CaptureCue {
	/** The cued sentence (trimmed, length-capped) — quoted back in the nudge. */
	snippet: string;
	/** The suggested memory kind for the candidate. */
	kind: MemoryKind;
	/** Durable cues suggest long-term. */
	term: "long";
}

interface CuePattern {
	re: RegExp;
	kind: MemoryKind;
}

// Ordered by specificity: the first match wins and picks the kind.
const CUES: CuePattern[] = [
	{ re: /\b(?:always|never)\b/i, kind: "convention" },
	{ re: /\b(?:i\s+prefer|i'd\s+prefer|prefer\s+that|from\s+now\s+on|going\s+forward|in\s+(?:the\s+)?future)\b/i, kind: "preference" },
	{ re: /\b(?:remember\s+that|keep\s+in\s+mind|note\s+that|don'?t\s+forget|for\s+future\s+reference|make\s+sure\s+to)\b/i, kind: "note" },
	{ re: /\b(?:the\s+user\s+is|i\s+am\s+(?:on|using)|i'm\s+(?:on|using)|we\s+use|my\s+\w+\s+is)\b/i, kind: "preference" },
];

const MAX_SNIPPET = 200;

/** Split into sentences on ., !, ?, newline — coarse but enough to isolate the cued clause. */
function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** The first durable cue in `userText`, or null. Returns the cued sentence + a suggested kind. */
export function detectCaptureCue(userText: string): CaptureCue | null {
	if (typeof userText !== "string" || !userText.trim()) return null;
	for (const sentence of sentences(userText)) {
		for (const cue of CUES) {
			if (cue.re.test(sentence)) {
				const snippet = sentence.length > MAX_SNIPPET ? `${sentence.slice(0, MAX_SNIPPET - 1)}…` : sentence;
				return { snippet, kind: cue.kind, term: "long" };
			}
		}
	}
	return null;
}
