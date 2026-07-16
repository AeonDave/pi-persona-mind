/**
 * Content scanner — gates every write into the mind, and (belt-and-braces) is a signal on read.
 *
 * A memory is injected back into the supervisor's system prompt, and a sub-agent may be the one
 * writing it, so stored text is an untrusted escalation surface: a leaked credential would persist
 * on disk, and stored "ignore your instructions…" would re-enter the prompt. This scanner rejects
 * the two worst classes before anything is persisted — secrets/credentials and prompt-injection /
 * role-hijack phrasing — plus invisible unicode used to smuggle either past a human reviewer.
 *
 * It is intentionally conservative and pattern-based (no LLM): cheap, deterministic, cross-OS.
 */

export interface ScanResult {
	ok: boolean;
	reason?: string;
}

interface Rule {
	re: RegExp;
	reason: string;
}

// Invisible / format control characters: zero-width spaces & joiners (U+200B-200D), bidi marks and
// overrides (U+200E-200F, U+202A-202E), word joiner & invisible math ops (U+2060-2064), bidi
// isolates (U+2066-2069), and BOM/ZWNBSP (U+FEFF) — the "Trojan Source"-style hiding set.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

const SECRET_RULES: Rule[] = [
	{ re: /\bsk-ant-[A-Za-z0-9_-]{16,}/, reason: "possible secret: Anthropic API key" },
	{ re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, reason: "possible secret: OpenAI API key" },
	{ re: /\bAKIA[0-9A-Z]{16}\b/, reason: "possible secret: AWS access key id" },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, reason: "possible secret: GitHub token" },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, reason: "possible secret: Slack token" },
	{ re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, reason: "possible secret: private key block" },
	{ re: /\bBearer\s+[A-Za-z0-9._-]{16,}/, reason: "possible secret: bearer token / credential" },
	{ re: /\b(?:password|passwd|pwd|secret|api[_-]?key|token|access[_-]?token)\s*[=:]\s*\S{8,}/i, reason: "possible secret: inline credential assignment" },
];

const INJECTION_RULES: Rule[] = [
	{ re: /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|the)\b[^.\n]{0,20}\b(?:instructions?|prompts?|messages?|rules?)\b/i, reason: "possible prompt-injection: override instruction" },
	{ re: /\b(?:disregard|ignore|override)\b[^.\n]{0,30}\bsystem\s+prompt\b/i, reason: "possible prompt-injection: target the system prompt" },
	{ re: /\byou\s+are\s+now\s+(?:a\b|an\b|the\b|no\s+longer\b)/i, reason: "possible role-hijack: identity reassignment" },
	{ re: /\b(?:new|updated)\s+(?:system\s+)?(?:instructions?|directives?)\s*:/i, reason: "possible prompt-injection: injected directives" },
];

/**
 * Scan a candidate memory/backlog text. Returns `{ ok: true }` when it looks safe to store, or
 * `{ ok: false, reason }` naming the first problem found (order: invisible chars, secrets,
 * injection). Empty/whitespace text is treated as OK here — non-emptiness is the caller's concern.
 */
export function scanContent(text: string): ScanResult {
	if (INVISIBLE.test(text)) return { ok: false, reason: "invisible unicode / hidden characters detected" };
	for (const rule of SECRET_RULES) if (rule.re.test(text)) return { ok: false, reason: rule.reason };
	for (const rule of INJECTION_RULES) if (rule.re.test(text)) return { ok: false, reason: rule.reason };
	return { ok: true };
}
