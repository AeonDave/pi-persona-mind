/** Deterministic lexical and repository-path ranking; tags are the only explicit semantic bridge. */

import type { MemoryEntry, MemoryKind } from "./memory.ts";

const QUERY_MAX_CHARS = 512;
const STOP_WORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "into", "is", "it", "of", "on", "or", "the", "this", "to", "use", "what", "when", "where", "which", "with",
]);
const NEGATION_AND_EXCEPTION = new Set(["except", "never", "no", "not", "only", "unless", "without"]);
const KIND_PRIORITY: Record<MemoryKind, number> = { objective: -1, invariant: 0, preference: 1, convention: 2, rationale: 3, gotcha: 4, note: 5 };

export interface RetrievalSource {
	text: string;
	tags?: readonly string[];
	id?: string;
}

export interface RetrievalRank<T> {
	entry: T;
	score: number;
	textTerms: string[];
	tagTerms: string[];
	pathMatches: string[];
	/** Matched query terms that used a weaker identifier/vowel-accent bridge. */
	normalizedTerms: string[];
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

const TOKEN_SEGMENTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[vV]?\d+(?:\.\d+)+(?:-[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*)?(?:\+[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*)?|[\p{L}\p{N}]+/gu;
const EAST_ASIAN_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN = /^\p{Script=Latin}+$/u;

function words(value: string): string[] {
	const segments = value.normalize("NFC").match(TOKEN_SEGMENTS) ?? [];
	const result: string[] = [];
	for (const segment of segments) {
		if (!EAST_ASIAN_START.test(segment)) { result.push(segment); continue; }
		const chars = [...segment];
		if (chars.length < 2) { result.push(segment); continue; }
		for (let index = 0; index < chars.length - 1; index++) result.push(`${chars[index]}${chars[index + 1]}`);
	}
	return result;
}

/** Fold vowel diacritics only: consonants such as ñ stay distinct (año must not match ano). */
function foldVowels(value: string): string {
	if (/^[\x00-\x7f]*$/.test(value)) return value;
	return value.normalize("NFD").replace(/([aeiouy])[\u0300-\u036f]+/g, "$1").normalize("NFC");
}

function components(word: string): string[] {
	// Numeric identifiers/hashes/versions are exact atoms, never word-expansion sources.
	if (/\p{N}/u.test(word) || /^[a-f\d]{8,}$/i.test(word)) return [word.toLowerCase()];
	if (/^[\x00-\x7f]*$/.test(word)) {
		return word.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").toLowerCase().split(" ");
	}
	return word.replace(/(\p{Ll})(\p{Lu})/gu, (match, a: string, b: string) => LATIN.test(match) ? `${a} ${b}` : match)
		.replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, (match, a: string, b: string) => LATIN.test(match) ? `${a} ${b}` : match)
		.split(" ").map((part) => foldVowels(part.toLowerCase()));
}

interface QueryTerm { original: string; components: readonly string[] }

function queryTerms(query: string): QueryTerm[] {
	const seen = new Set<string>();
	const result: QueryTerm[] = [];
	for (const word of words(query.slice(0, QUERY_MAX_CHARS))) {
		const term = word.toLowerCase();
		if (STOP_WORDS.has(term) && !NEGATION_AND_EXCEPTION.has(term)) continue;
		if (seen.has(term)) continue;
		seen.add(term);
		result.push({ original: term, components: components(word) });
	}
	return result;
}

function queryPaths(query: string): string[] {
	const matches = query.slice(0, QUERY_MAX_CHARS).match(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g) ?? [];
	return [...new Set(matches.map((path) => path.replace(/\\/g, "/").toLowerCase()))];
}

function entryPathMatches(entry: RetrievalSource, paths: readonly string[]): string[] {
	if (paths.length === 0) return [];
	const content = `${entry.text} ${(entry.tags ?? []).join(" ")}`.replace(/\\/g, "/").toLowerCase();
	return paths.filter((path) => content.includes(path));
}

function vocabulary(value: string): { exact: ReadonlySet<string>; normalized: ReadonlySet<string> } {
	const exact = new Set<string>();
	const normalized = new Set<string>();
	for (const word of new Set(words(value))) {
		exact.add(word.toLowerCase());
		for (const part of components(word)) normalized.add(part);
	}
	return { exact, normalized };
}

function rankItem<T extends RetrievalSource>(entry: T, terms: readonly QueryTerm[], paths: readonly string[]): RetrievalRank<T> {
	if (terms.length === 0) {
		const pathMatches = entryPathMatches(entry, paths);
		return { entry, score: pathMatches.length * 12, textTerms: [], tagTerms: [], pathMatches, normalizedTerms: [] };
	}
	const textWords = vocabulary(entry.text);
	const tagWords = vocabulary((entry.tags ?? []).join(" "));
	const textTerms: string[] = [];
	const tagTerms: string[] = [];
	const normalizedTerms: string[] = [];
	let lexicalScore = 0;
	for (const { original, components: parts } of terms) {
		const negation = NEGATION_AND_EXCEPTION.has(original);
		if (textWords.exact.has(original)) { textTerms.push(original); lexicalScore += negation ? 4 : 3; }
		else if (tagWords.exact.has(original)) { tagTerms.push(original); lexicalScore += negation ? 3 : 2; }
		else if (parts.every((part) => textWords.normalized.has(part))) {
			textTerms.push(original); normalizedTerms.push(original); lexicalScore += 1;
		} else if (parts.every((part) => tagWords.normalized.has(part))) {
			tagTerms.push(original); normalizedTerms.push(original); lexicalScore += 0.75;
		}
	}
	const pathMatches = entryPathMatches(entry, paths);
	const score = lexicalScore + pathMatches.length * 12;
	return { entry, score, textTerms, tagTerms, pathMatches, normalizedTerms };
}

/** Rank generic text/tag entries; optional ties are resolved by the supplied domain comparator. */
export function rankRetrievalEntries<T extends RetrievalSource>(
	entries: readonly T[],
	query: string,
	tieBreak?: (a: T, b: T) => number,
): RetrievalRank<T>[] {
	const terms = queryTerms(query);
	const paths = queryPaths(query);
	return entries.map((entry) => rankItem(entry, terms, paths)).sort((a, b) => {
		if (a.score !== b.score) return b.score - a.score;
		const tie = tieBreak?.(a.entry, b.entry) ?? 0;
		if (tie !== 0) return tie;
		return compareStrings(a.entry.id ?? "", b.entry.id ?? "");
	});
}

function dateTie(a: Pick<MemoryEntry, "lastSeenAt">, b: Pick<MemoryEntry, "lastSeenAt">): number {
	const aTime = Date.parse(a.lastSeenAt);
	const bTime = Date.parse(b.lastSeenAt);
	const aValid = Number.isFinite(aTime) ? aTime : Number.NEGATIVE_INFINITY;
	const bValid = Number.isFinite(bTime) ? bTime : Number.NEGATIVE_INFINITY;
	return bValid - aValid;
}

/**
 * Rank durable/working facts for a task or explicit recall. There is no stemming, synonym table,
 * embedding, or learned score: lexical matches and hand-authored tags explain every positive rank.
 */
export function rankMemoryEntries(entries: readonly MemoryEntry[], query: string): RetrievalRank<MemoryEntry>[] {
	return rankRetrievalEntries(entries, query, (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || dateTie(a, b));
}
