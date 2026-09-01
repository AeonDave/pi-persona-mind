/**
 * Deterministic, model-free capture-cue detection — the counter to the structural weakness of a
 * purely explicit memory (the agent forgets to call `remember`). Scans a user message for phrasing
 * that signals a durable preference/convention/instruction, and returns a candidate the extension
 * can either persist (only for direct, explicit user intent) or surface as a gentle candidate.
 *
 * No LLM, no network: just cues. A cue is auto-eligible only when the persistence request starts
 * the user's own sentence; instruction-shaped prose quoted inside a report remains nudge-only.
 */

import type { MemoryKind } from "./memory.ts";

export interface CaptureCue {
	/** The cued sentence (trimmed, length-capped) — quoted back in the nudge. */
	snippet: string;
	/** The suggested memory kind for the candidate. */
	kind: MemoryKind;
	/** Durable cues suggest long-term. */
	term: "long";
	/** True only for a sentence-initial EXPLICIT persist-intent phrase ("from now on", "remember
	 *  that", "for future reference") — as opposed to casual "always/never"/"I prefer" or a cue
	 *  quoted inside a report. The caller may persist only this high-confidence class. */
	strong: boolean;
	/** The durable fact with the cue phrase removed when it can be done deterministically. */
	candidate: string;
}

export type CaptureMode = "auto" | "prompt" | "off";

/** Automatic capture is limited to direct, explicit user intent. `prompt` keeps the old nudge-only
 * behaviour; `off` disables both detection and capture. Invalid values fail back to the safe,
 * useful default instead of silently disabling memory. */
export function captureMode(env: NodeJS.ProcessEnv = process.env): CaptureMode {
	const configured = env.PI_PERSONA_MIND_CAPTURE?.trim().toLowerCase();
	return configured === "prompt" || configured === "off" ? configured : "auto";
}

interface CuePattern {
	re: RegExp;
	kind: MemoryKind;
}

// Ordered by specificity: the first match wins and picks the kind.
const CUES: CuePattern[] = [
	{ re: /\b(?:architectural\s+decision|durable\s+decision|permanent\s+convention|stable\s+invariant|decisione\s+architetturale|decisione\s+durevole|convenzione\s+permanente|invariante\s+stabile)\b/i, kind: "rationale" },
	{ re: /\b(?:always|never)\b/i, kind: "convention" },
	{ re: /\b(?:i\s+prefer|i'd\s+prefer|prefer\s+that|from\s+now\s+on|going\s+forward|in\s+(?:the\s+)?future|preferisco|preferirei|da\s+ora\s+in\s+poi|da\s+questo\s+momento|d['’]ora\s+in\s+poi|in\s+futuro|per\s+il\s+futuro)\b/i, kind: "preference" },
	{ re: /\b(?:remember(?:\s+that)?|keep\s+in\s+mind|note\s+that|don'?t\s+forget|for\s+future\s+reference|commit\s+(?:this\s+)?to\s+memory|ricorda(?:ti)?(?:\s+(?:che|di))?|tieni\s+(?:a\s+mente|presente)|nota\s+che|non\s+dimentica(?:re|rti)|memorizza|segnati|conserva\s+in\s+memoria|salva(?:lo)?\s+(?:in|nella)\s+memoria)\b/i, kind: "note" },
	{ re: /\b(?:the\s+user\s+is|i\s+am\s+(?:on|using)|i'm\s+(?:on|using)|we\s+use|my\s+\w+\s+is|io\s+uso|uso\s+\w+|usiamo)\b/i, kind: "preference" },
];

const MAX_SNIPPET = 200;

const DIRECT_DECISION_OWNER = /^\s*(?:we\b|i\b|this\s+project\b|for\s+this\s+project\b|abbiamo\b|ho\b|questo\s+progetto\b|per\s+questo\s+progetto\b)/i;
const DURABLE_WORD = /\b(?:durable|permanent|stable|durevole|permanente|stabile)\b/i;
const DECISION_WORD = /\b(?:architectural\s+decision|decision|convention|invariant|decisione\s+architetturale|decisione|convenzione|invariante)\b/i;
const DECISION_ACTION = /\b(?:decided|chosen|chose|adopted|established|made|set|abbiamo\s+(?:deciso|scelto|adottato|stabilito|definito)|ho\s+(?:deciso|scelto|adottato|stabilito|definito))\b/i;
const REPORTED_DECISION = /^\s*(?:i\s+(?:saw|noticed|read|heard|observed|found|learned)\b|ho\s+(?:visto|notato|letto|sentito|osservato|scoperto|appreso)\b|mi\s+sono\s+accort[oa]\b)/i;

function isDirectDurableDecision(sentence: string): boolean {
	return !REPORTED_DECISION.test(sentence) && DIRECT_DECISION_OWNER.test(sentence) && DECISION_ACTION.test(sentence) && DURABLE_WORD.test(sentence) && DECISION_WORD.test(sentence);
}

/** Split into sentences on ., !, ?, newline — coarse but enough to isolate the cued clause. */
function sentences(text: string): string[] {
	// Foreign/quoted material is data, not the user's own persistence request. Parse Markdown fences
	// linearly so an unclosed fence also consumes the rest; a regex that requires a closing ``` would
	// turn malformed pasted code into durable memory. Four-space/tab-indented code is data too.
	let fence: { char: "`" | "~"; width: number } | undefined;
	const prose: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker?.[0] === fence.char && marker.length >= fence.width) fence = undefined;
			continue;
		}
		if (marker) {
			fence = { char: marker[0] as "`" | "~", width: marker.length };
			continue;
		}
		if (/^(?: {4,}|\t)/.test(line) || /^\s*>/.test(line)) continue;
		prose.push(line);
	}
	return prose
		.join("\n")
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

const CUE_PREFIXES: readonly { re: RegExp; explicit: boolean }[] = [
	{ re: /^\s*(?:please\s+)?(?:remember(?:\s+that)?|keep\s+in\s+mind(?:\s+that)?|don'?t\s+forget(?:\s+that)?|for\s+future\s+reference|commit\s+(?:this\s+)?to\s+memory(?:\s+that)?)\s*[,;:\-]?\s*(.+)$/i, explicit: true },
	{ re: /^\s*(?:i\s+(?:want|need)\s+you\s+to\s+remember(?:\s+that)?)\s*[,;:\-]?\s*(.+)$/i, explicit: true },
	{ re: /^\s*(?:from\s+now\s+on|going\s+forward|in\s+the\s+future)\s*[,;:\-]?\s*(.+)$/i, explicit: true },
	{ re: /^\s*(?:per\s+favore\s+)?(?:ricorda(?:ti)?(?:\s+(?:che|di))?|tieni\s+(?:a\s+mente|presente)(?:\s+che)?|non\s+dimentica(?:re|rti)(?:\s+che)?|memorizza(?:\s+che)?|segnati(?:\s+che)?|conserva\s+in\s+memoria(?:\s+che)?|salva(?:lo)?\s+(?:in|nella)\s+memoria(?:\s+che)?)\s*[,;:\-]?\s*(.+)$/i, explicit: true },
	{ re: /^\s*(?:voglio\s+che\s+tu\s+ricordi(?:\s+che)?)\s*[,;:\-]?\s*(.+)$/i, explicit: true },
	{ re: /^\s*(?:da\s+ora\s+in\s+poi|da\s+questo\s+momento|d['’]ora\s+in\s+poi|in\s+futuro|per\s+il\s+futuro)\s*[,;:\-]?\s*(.+)$/i, explicit: true },
	{ re: /^\s*(?:i(?:'d)?\s+prefer|prefer\s+that|preferisco|preferirei)\s*[,;:\-]?\s*(.+)$/i, explicit: false },
	{ re: /^\s*(?:note\s+that|nota\s+che)\s*[,;:\-]?\s*(.+)$/i, explicit: false },
];

function candidateFor(sentence: string): { text: string; explicit: boolean } {
	// A Markdown/list marker is presentation owned by the user, not part of the requested fact.
	// Block quotes were already excluded by `sentences`, so accepting a bullet here does not turn
	// quoted foreign material into an automatic write.
	const direct = sentence.replace(/^\s*(?:(?:[-+*])\s+(?:\[[ xX]\]\s+)?|(?:\d+[.)])\s+)/, "");
	if (isDirectDurableDecision(direct)) {
		const colon = direct.indexOf(":");
		const afterColon = colon >= 0 ? direct.slice(colon + 1).trim() : "";
		const text = afterColon || direct;
		return { text, explicit: /[\p{L}\p{N}]/u.test(text) };
	}
	const withoutAlways = direct.replace(/^\s*(?:always|never)\s+/i, "");
	for (const prefix of CUE_PREFIXES) {
		const match = prefix.re.exec(direct) ?? (withoutAlways !== direct ? prefix.re.exec(withoutAlways) : null);
		const candidate = match?.[1]?.trim();
		if (candidate) {
			const text = candidate;
			return { text, explicit: prefix.explicit && /[\p{L}\p{N}]/u.test(text) };
		}
	}
	return { text: direct, explicit: false };
}

/** Every durable cue in direct user prose, capped so a hostile/accidental wall of cues cannot turn
 * one input into an unbounded write burst. */
export function detectCaptureCues(userText: string): CaptureCue[] {
	if (typeof userText !== "string" || !userText.trim()) return [];
	const found: CaptureCue[] = [];
	for (const sentence of sentences(userText)) {
		for (const cue of CUES) {
			if (!cue.re.test(sentence)) continue;
			const snippet = sentence.length > MAX_SNIPPET ? `${sentence.slice(0, MAX_SNIPPET - 1)}…` : sentence;
			const candidate = candidateFor(sentence);
			found.push({ snippet, kind: cue.kind, term: "long", strong: candidate.explicit, candidate: candidate.text });
			break;
		}
		if (found.length >= 4) break;
	}
	return found;
}

/** The first durable cue in `userText`, or null. Returns the cued sentence + a suggested kind. */
export function detectCaptureCue(userText: string): CaptureCue | null {
	return detectCaptureCues(userText)[0] ?? null;
}
