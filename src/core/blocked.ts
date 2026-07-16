/**
 * Deterministic, model-free detection of a DELEGATED leg that came back BLOCKED — the delegation-path
 * mirror of capture.ts. A blocked/unknown leg is deferred intent by definition (a thread to come back
 * to), so surfacing it as a backlog candidate turns a surrendered hand-off into captured intent before
 * it is silently lost. No LLM, no network: it keys on the SAME explicit protocol markers pi-persona's
 * PersistenceNudge uses — `[BLOCKED …]` (operator protocol) and `FLAG: UNKNOWN` (a CTF leg giving up).
 *
 * Like the capture cue, this is a NUDGE source, never an auto-writer: a false positive costs nothing
 * more than one ignorable status-line hint the supervisor can dismiss.
 */

export interface BlockedCue {
	/** The matched marker (with its inline reason, if any), trimmed and length-capped, for the nudge. */
	snippet: string;
}

// Same markers as pi-persona's SURRENDER_MARKERS; capture the bracketed reason so the nudge can echo it.
const MARKERS: readonly RegExp[] = [/\[BLOCKED\b[^\]\n]*\]?/i, /\bFLAG:\s*UNKNOWN\b/i];
const MAX_SNIPPET = 160;

/** The first blocked/unknown marker in `text`, or null when the report is clean or not a string. */
export function detectBlockedLeg(text: string): BlockedCue | null {
	if (typeof text !== "string" || !text.trim()) return null;
	for (const re of MARKERS) {
		const m = re.exec(text);
		if (m) return { snippet: m[0].trim().slice(0, MAX_SNIPPET) };
	}
	return null;
}
