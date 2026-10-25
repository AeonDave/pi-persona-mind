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
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

const TOKEN_SEGMENTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu;
const EAST_ASIAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function words(value: string): string[] {
	const segments = value.toLowerCase().match(TOKEN_SEGMENTS) ?? [];
	return segments.flatMap((segment) => {
		const chars = [...segment];
		if (chars.length < 2 || !EAST_ASIAN.test(chars[0] ?? "")) return [segment];
		const bigrams: string[] = [];
		for (let index = 0; index < chars.length - 1; index++) bigrams.push(`${chars[index]}${chars[index + 1]}`);
		return bigrams;
	});
}

function queryTerms(query: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const term of words(query.slice(0, QUERY_MAX_CHARS))) {
		if (STOP_WORDS.has(term) && !NEGATION_AND_EXCEPTION.has(term)) continue;
		if (seen.has(term)) continue;
		seen.add(term);
		result.push(term);
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

function rankItem<T extends RetrievalSource>(entry: T, query: string): RetrievalRank<T> {
	const terms = queryTerms(query);
	const textWords = new Set(words(entry.text));
	const tagWords = new Set((entry.tags ?? []).flatMap(words));
	const textTerms = terms.filter((term) => textWords.has(term));
	const tagTerms = terms.filter((term) => !textWords.has(term) && tagWords.has(term));
	const pathMatches = entryPathMatches(entry, queryPaths(query));
	const textScore = textTerms.reduce((sum, term) => sum + (NEGATION_AND_EXCEPTION.has(term) ? 4 : 3), 0);
	const tagScore = tagTerms.reduce((sum, term) => sum + (NEGATION_AND_EXCEPTION.has(term) ? 3 : 2), 0);
	const score = textScore + tagScore + pathMatches.length * 12;
	return { entry, score, textTerms, tagTerms, pathMatches };
}

/** Rank generic text/tag entries; optional ties are resolved by the supplied domain comparator. */
export function rankRetrievalEntries<T extends RetrievalSource>(
	entries: readonly T[],
	query: string,
	tieBreak?: (a: T, b: T) => number,
): RetrievalRank<T>[] {
	return entries.map((entry) => rankItem(entry, query)).sort((a, b) => {
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
