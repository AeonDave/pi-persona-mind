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
 *               a custom security persona can retain legitimate findings like any other persona.
 *
 * Pattern-based, no LLM: cheap, deterministic, cross-OS. Injection patterns are filler-tolerant so
 * padding between the verb and its target cannot bypass them, and are matched against a
 * whitespace-collapsed copy too so a newline placed inside a phrase (which the render path rejoins)
 * cannot slip past the scan.
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

// Invisible / format-control characters: zero-width spaces & joiners (U+200B-200D), bidi marks and
// overrides (U+200E-200F, U+202A-202E), word joiner & invisible math ops (U+2060-2064), bidi
// isolates (U+2066-2069), BOM/ZWNBSP (U+FEFF), supplementary variation selectors
// (U+E0100-E01EF), and the Unicode Tags block (U+E0000-E007F) — the "Trojan Source" hiding set.
// Basic VS15/VS16 are intentionally not blanket-banned: ordinary emoji such as ⚠️ use them.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;
/** A basic variation selector attached to ASCII is not normal typography and is a common byte-
 * smuggling shape; the same selector after an emoji/symbol remains legitimate presentation data. */
const ASCII_VARIATION_SELECTOR = /[\u0000-\u007f][\ufe00-\ufe0f]/u;

// NUL and the remaining non-whitespace C0/C1 controls can terminate strings or alter terminal /
// transport framing. Tabs and line breaks are ordinary prose formatting and stay allowed.
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

// Override/system-prompt phrases are matched as word sequences below instead of as a regex with a
// greedy filler gap. That makes the scan linear even when an untrusted document contains megabytes
// of near-matching filler, and avoids the old fixed 120-character bypass.
const OVERRIDE_START = new Set(["ignore", "disregard", "forget", "override", "ignora", "ignorare", "dimentica", "dimenticare", "sovrascrivi", "sovrascrivere"]);
const OVERRIDE_TARGET = new Set([
	"previous", "prior", "above", "earlier", "all", "the", "these", "those", "your",
	"precedente", "precedenti", "sopra", "anteriore", "anteriori", "tutto", "tutti", "tutta", "tutte", "il", "lo", "la", "i", "gli", "le", "questo", "questa", "questi", "queste", "tuo", "tua", "tuoi", "tue",
]);
const OVERRIDE_OBJECT = new Set([
	"instruction", "instructions", "directive", "directives", "prompt", "prompts", "message", "messages", "rule", "rules",
	"istruzione", "istruzioni", "direttiva", "direttive", "messaggio", "messaggi", "regola", "regole",
]);
const SYSTEM_TARGET = new Set(["disregard", "ignore", "override", "ignora", "ignorare", "sovrascrivi", "sovrascrivere"]);
const SYSTEM_WORD = new Set(["system", "sistema"]);
const PROMPT_WORD = new Set(["prompt"]);
const DECEPTION_START = new Set(["never", "dont", "mai"]);
const DECEPTION_VERB = new Set([
	"tell", "inform", "mention", "reveal", "show", "disclose", "notify",
	"dire", "informa", "informare", "menziona", "menzionare", "rivela", "rivelare", "mostra", "mostrare", "notifica", "notificare",
]);
const USER_TARGET = new Set(["user", "utente", "allutente"]);

function hasWordSequence(text: string, groups: readonly ReadonlySet<string>[]): boolean {
	// Splitting at a full stop/newline preserves the old rule's sentence boundary. The caller passes a
	// whitespace-collapsed copy, so a newline inserted inside a phrase is still detected.
	for (const sentence of text.split(/[.\n]/)) {
		const words = sentence.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
		let group = 0;
		for (const word of words) {
			if (!groups[group]?.has(word)) continue;
			group++;
			if (group === groups.length) return true;
		}
	}
	return false;
}

const RULES: Rule[] = [
	// ── attacks on the supervisor itself — always flagged ───────────────────────
	{ re: /\byou\s+are\s+now\s+(?:a\b|an\b|the\b|no\s+longer\b)/i, reason: "possible role-hijack: identity reassignment", minScope: "all" },
	{ re: /^\s*(?:please\s+)?act\s+as\s+(?:the\s+)?system\b/i, reason: "possible role-hijack: system impersonation", minScope: "all" },
	{ re: /\b(?:new|updated)\s+(?:system\s+)?(?:instructions?|directives?)\s*:/i, reason: "possible prompt-injection: injected directives", minScope: "all" },
	// ── credential / secret leakage — blocked by default (context) ──────────────
	{ re: /\bsk-ant-[A-Za-z0-9_-]{16,}/, reason: "possible secret: Anthropic API key", minScope: "context" },
	{ re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, reason: "possible secret: OpenAI API key", minScope: "context" },
	{ re: /\bAKIA[0-9A-Z]{16}\b/, reason: "possible secret: AWS access key id", minScope: "context" },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, reason: "possible secret: GitHub token", minScope: "context" },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, reason: "possible secret: Slack token", minScope: "context" },
	{ re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, reason: "possible secret: private key block", minScope: "context" },
	{ re: /\bBearer\s+[A-Za-z0-9._-]{16,}/, reason: "possible secret: bearer token / credential", minScope: "context" },
	{ re: /\b(?:password|passwd|pwd|secret|api[_-]?key|token|access[_-]?token)\s*[=:]\s*\S{8,}/i, reason: "possible secret: inline credential assignment", minScope: "context" },
	// ── offensive-security vocabulary — opt-in only, independent of persona name ──
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
	if (ASCII_VARIATION_SELECTOR.test(text)) return { ok: false, reason: "suspicious variation selector attached to ASCII" };
	if (UNSAFE_CONTROL.test(text)) return { ok: false, reason: "unsafe control character detected" };
	// Fold compatibility-width glyphs before matching: a model reads full-width Latin as the same
	// instruction, so the trust boundary must as well. The render path also collapses whitespace;
	// scan that form so a newline-split phrase cannot re-join into an unchecked instruction.
	const normalized = text.normalize("NFKC");
	const collapsed = normalized.replace(/\s+/g, " ");
	if (hasWordSequence(collapsed, [OVERRIDE_START, OVERRIDE_TARGET, OVERRIDE_OBJECT])) {
		return { ok: false, reason: "possible prompt-injection: override instruction" };
	}
	if (
		hasWordSequence(collapsed, [SYSTEM_TARGET, SYSTEM_WORD, PROMPT_WORD]) ||
		hasWordSequence(collapsed, [SYSTEM_TARGET, PROMPT_WORD, SYSTEM_WORD])
	) {
		return { ok: false, reason: "possible prompt-injection: target the system prompt" };
	}
	// Keep this filler-unbounded like the override checks. Apostrophes are removed before tokenizing
	// so `don't` and `don’t` both become the single sentinel `dont`.
	const deceptionText = collapsed.replace(/['’]/g, "");
	if (
		hasWordSequence(deceptionText, [DECEPTION_START, DECEPTION_VERB, USER_TARGET]) ||
		hasWordSequence(deceptionText, [new Set(["do"]), new Set(["not"]), DECEPTION_VERB, USER_TARGET]) ||
		hasWordSequence(deceptionText, [new Set(["non"]), DECEPTION_VERB, USER_TARGET])
	) {
		return { ok: false, reason: "possible deception: directive to hide/conceal from the user" };
	}
	const limit = SCOPE_RANK[scope];
	for (const rule of RULES) {
		if (SCOPE_RANK[rule.minScope] > limit) continue;
		if (rule.re.test(normalized) || (collapsed !== normalized && rule.re.test(collapsed))) return { ok: false, reason: rule.reason };
	}
	return { ok: true };
}
