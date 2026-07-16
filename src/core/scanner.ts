/**
 * Content scanner — gates every write into the mind, and re-runs on load before injection.
 *
 * A memory is injected back into the supervisor's system prompt, and a sub-agent (or another
 * process) may be the one writing it, so stored text is an untrusted escalation surface. The
 * scanner rejects, in tiers, the classes that are genuinely dangerous as PERSISTED, RE-INJECTED
 * facts:
 *
 *   - "all"     (fires in every scope): the attacks on the supervisor itself — prompt-injection /
 *               role-hijack, deception directives ("don't tell the user"), and invisible unicode
 *               used to smuggle them. These are never a legitimate fact to store.
 *   - "context" (the default): adds credential/secret leakage — blocking a raw key from being
 *               persisted into a shared, re-injected store.
 *   - "strict"  (opt-in): adds high-false-positive offensive-security vocabulary. OFF by default so
 *               it never flags an `elite` pentest persona's legitimate notes.
 *
 * Pattern-based, no LLM: cheap, deterministic, cross-OS. Injection patterns are filler-tolerant so
 * padding between the verb and its target cannot bypass them.
 */

export type ScanScope = "all" | "context" | "strict";
const SCOPE_RANK: Record<ScanScope, number> = { all: 0, context: 1, strict: 2 };

export interface ScanResult {
	ok: boolean;
	reason?: string;
}

interface Rule {
	re: RegExp;
	reason: string;
	minScope: ScanScope;
}

// Invisible / format control characters: zero-width spaces & joiners (U+200B-200D), bidi marks and
// overrides (U+200E-200F, U+202A-202E), word joiner & invisible math ops (U+2060-2064), bidi
// isolates (U+2066-2069), and BOM/ZWNBSP (U+FEFF) — the "Trojan Source"-style hiding set.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

// A filler gap that tolerates padding words/punctuation (bounded to avoid catastrophic backtracking).
const GAP = "[^.\\n]{0,120}?";

const RULES: Rule[] = [
	// ── attacks on the supervisor itself — always flagged ───────────────────────
	{ re: new RegExp(`\\b(?:ignore|disregard|forget|override)\\b${GAP}\\b(?:previous|prior|above|earlier|all|the)\\b${GAP}\\b(?:instructions?|prompts?|messages?|rules?)\\b`, "i"), reason: "possible prompt-injection: override instruction", minScope: "all" },
	{ re: new RegExp(`\\b(?:disregard|ignore|override)\\b${GAP}\\bsystem\\s+prompt\\b`, "i"), reason: "possible prompt-injection: target the system prompt", minScope: "all" },
	{ re: /\byou\s+are\s+now\s+(?:a\b|an\b|the\b|no\s+longer\b)/i, reason: "possible role-hijack: identity reassignment", minScope: "all" },
	{ re: /\b(?:new|updated)\s+(?:system\s+)?(?:instructions?|directives?)\s*:/i, reason: "possible prompt-injection: injected directives", minScope: "all" },
	{ re: /\b(?:do\s+not|don't|never)\b[^.\n]{0,30}\b(?:tell|inform|mention\s+to|reveal\s+to|show)\b[^.\n]{0,20}\b(?:the\s+)?user\b/i, reason: "possible deception: directive to hide/conceal from the user", minScope: "all" },
	// ── credential / secret leakage — blocked by default (context) ──────────────
	{ re: /\bsk-ant-[A-Za-z0-9_-]{16,}/, reason: "possible secret: Anthropic API key", minScope: "context" },
	{ re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, reason: "possible secret: OpenAI API key", minScope: "context" },
	{ re: /\bAKIA[0-9A-Z]{16}\b/, reason: "possible secret: AWS access key id", minScope: "context" },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, reason: "possible secret: GitHub token", minScope: "context" },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, reason: "possible secret: Slack token", minScope: "context" },
	{ re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, reason: "possible secret: private key block", minScope: "context" },
	{ re: /\bBearer\s+[A-Za-z0-9._-]{16,}/, reason: "possible secret: bearer token / credential", minScope: "context" },
	{ re: /\b(?:password|passwd|pwd|secret|api[_-]?key|token|access[_-]?token)\s*[=:]\s*\S{8,}/i, reason: "possible secret: inline credential assignment", minScope: "context" },
	// ── offensive-security vocabulary — opt-in only, never fires on `elite` by default ──
	{ re: /\b(?:cobalt\s+strike|sliver|havoc|mythic|meterpreter)\b[^.\n]{0,30}\b(?:beacon|implant|payload|c2)\b/i, reason: "offensive-security tooling (strict scope)", minScope: "strict" },
	{ re: /\bauthorized_keys\b[^.\n]{0,40}\b(?:append|echo|>>|backdoor|persist)/i, reason: "SSH-key persistence (strict scope)", minScope: "strict" },
];

/**
 * Scan a candidate memory/backlog text at the given scope (default "context"). Returns
 * `{ ok: true }` when safe to store/inject, or `{ ok: false, reason }` naming the first problem
 * found. Empty/whitespace is treated as OK here — non-emptiness is the caller's concern.
 */
export function scanContent(text: string, scope: ScanScope = "context"): ScanResult {
	if (INVISIBLE.test(text)) return { ok: false, reason: "invisible unicode / hidden characters detected" };
	const limit = SCOPE_RANK[scope];
	for (const rule of RULES) {
		if (SCOPE_RANK[rule.minScope] > limit) continue;
		if (rule.re.test(text)) return { ok: false, reason: rule.reason };
	}
	return { ok: true };
}
