/** Reproducible offline lexical retrieval and bounded-injection evaluation. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_MEMORY_CONTEXT_TOKENS, estimateTokens } from "../src/core/context-budget.ts";
import { diagnoseTokenReference } from "./token-diagnostic.ts";
import { renderMind } from "../src/core/inject.ts";
import type { MemoryEntry } from "../src/core/memory.ts";
import { rankMemoryEntries } from "../src/core/retrieval.ts";
import {
	MEMORY_EVALUATION_CASES,
	MEMORY_EVALUATION_FACTS,
	MEMORY_EVALUATION_NOW,
	type MemoryEvaluationCase,
	type MemoryEvaluationFact,
} from "../test/fixtures/memory-evaluation.ts";

interface MethodMetrics {
	hitAt1: number;
	hitAt3: number;
	mrr: number;
	judgedCases: number;
	abstentionCases: number;
	abstentionCorrect: number;
}

interface SentinelCaseOutcome {
	caseId: string;
	pairId: string;
	category: NonNullable<MemoryEvaluationCase["sentinel"]>["category"];
	expectedId: string;
	rank: number | null;
	injected: boolean;
	contrastId?: string;
	contrastRank?: number | null;
	contrastInjected?: boolean;
	passed: boolean;
}

interface SentinelGroupOutcome {
	pairId: string;
	category: NonNullable<MemoryEvaluationCase["sentinel"]>["category"];
	caseIds: string[];
	passed: boolean;
}

export interface MemoryEvaluationReport {
	evaluation: "synthetic deterministic lexical retrieval";
	facts: number;
	cases: number;
	methods: { substringBaseline: MethodMetrics; ranked: MethodMetrics };
	sentinels: { cases: SentinelCaseOutcome[]; groups: SentinelGroupOutcome[]; passedCases: number; totalCases: number; allPassed: boolean };
	injection: { maxCharacters: number; maxEstimatedTokens: number; tokenBudget: number; withinBudget: boolean };
	tokenReference: ReturnType<typeof diagnoseTokenReference>;
	limits: string[];
}

type RankFunction = (entries: readonly MemoryEvaluationFact[], query: string) => readonly MemoryEntry[];

function priorSubstringBaseline(entries: readonly MemoryEvaluationFact[], query: string): MemoryEntry[] {
	const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	if (terms.length === 0) return [];
	return entries
		.filter((entry) => terms.every((term) => entry.text.toLowerCase().includes(term)))
		.slice()
		.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || (a.id < b.id ? -1 : 1));
}

function rankedMethod(entries: readonly MemoryEvaluationFact[], query: string): MemoryEntry[] {
	return rankMemoryEntries(entries, query).filter((ranked) => ranked.score > 0).map((ranked) => ranked.entry);
}

function scoreMethod(cases: readonly MemoryEvaluationCase[], entries: readonly MemoryEvaluationFact[], rank: RankFunction): MethodMetrics {
	const judged = cases.filter((item) => item.relevantIds.length > 0);
	let hitAt1 = 0;
	let hitAt3 = 0;
	let reciprocalRankTotal = 0;
	for (const item of judged) {
		const results = rank(entries, item.query);
		const firstRelevant = results.findIndex((entry) => item.relevantIds.includes(entry.id));
		if (firstRelevant === 0) hitAt1++;
		if (firstRelevant >= 0 && firstRelevant < 3) hitAt3++;
		if (firstRelevant >= 0) reciprocalRankTotal += 1 / (firstRelevant + 1);
	}
	const abstentionCases = cases.filter((item) => item.relevantIds.length === 0);
	const abstentionCorrect = abstentionCases.filter((item) => rank(entries, item.query).length === 0).length;
	const rate = (value: number, denominator: number): number => denominator === 0 ? 0 : Number((value / denominator).toFixed(3));
	return {
		hitAt1: rate(hitAt1, judged.length),
		hitAt3: rate(hitAt3, judged.length),
		mrr: rate(reciprocalRankTotal, judged.length),
		judgedCases: judged.length,
		abstentionCases: abstentionCases.length,
		abstentionCorrect,
	};
}

function renderFixtureMemory(entries: readonly MemoryEvaluationFact[], item: MemoryEvaluationCase): string {
	const split = (tier: MemoryEvaluationFact["tier"]): MemoryEvaluationFact[] => entries.filter((entry) => entry.tier === tier);
	return renderMind({
		persona: "elite",
		ltm: split("persona"),
		projectLtm: split("project"),
		stm: split("working"),
		backlog: [],
		now: MEMORY_EVALUATION_NOW,
		query: item.query,
		budget: { ltm: 8, projectLtm: 4, stm: 5, backlog: 0, tokens: DEFAULT_MEMORY_CONTEXT_TOKENS },
	});
}

function evaluateSentinels(cases: readonly MemoryEvaluationCase[], entries: readonly MemoryEvaluationFact[]): MemoryEvaluationReport["sentinels"] {
	const byId = new Map(cases.map((item) => [item.id, item]));
	if (byId.size !== cases.length) throw new Error("Memory evaluation case IDs must be unique");
	const sentinelCases = cases.filter((item) => item.sentinel !== undefined);
	for (const item of sentinelCases) {
		const sentinel = item.sentinel;
		if (!sentinel || !item.relevantIds.includes(sentinel.expectedId)) throw new Error(`Invalid sentinel expectation for ${item.id}`);
		if (sentinel.pairWith !== undefined) {
			const paired = byId.get(sentinel.pairWith);
			if (paired?.sentinel?.pairWith !== item.id || paired.sentinel.pairId !== sentinel.pairId || paired.sentinel.category !== sentinel.category) {
				throw new Error(`Sentinel pair ${sentinel.pairId} is incomplete or inconsistent`);
			}
		}
	}

	const outcomes: SentinelCaseOutcome[] = sentinelCases.map((item) => {
		const sentinel = item.sentinel;
		if (!sentinel) throw new Error(`Missing sentinel expectation for ${item.id}`);
		const ranked = rankMemoryEntries(entries, item.query).filter((result) => result.score > 0);
		const rankIndex = ranked.findIndex((result) => result.entry.id === sentinel.expectedId);
		const fact = entries.find((entry) => entry.id === sentinel.expectedId);
		const block = renderFixtureMemory(entries, item);
		const rank = rankIndex < 0 ? null : rankIndex + 1;
		const injected = fact !== undefined && block.includes(fact.text);
		const paired = sentinel.pairWith === undefined ? undefined : byId.get(sentinel.pairWith);
		const contrastId = paired?.sentinel?.expectedId;
		const contrastIndex = contrastId === undefined ? -1 : ranked.findIndex((result) => result.entry.id === contrastId);
		const contrastRank = contrastId === undefined ? undefined : contrastIndex < 0 ? null : contrastIndex + 1;
		const contrastFact = contrastId === undefined ? undefined : entries.find((entry) => entry.id === contrastId);
		const contrastInjected = contrastId === undefined ? undefined : contrastFact !== undefined && block.includes(contrastFact.text);
		const pairRanksCorrect = contrastRank === undefined || (contrastRank !== null && rank !== null && rank < contrastRank);
		const contrastOutcome = contrastId === undefined ? {} : {
			contrastId,
			contrastRank: contrastRank ?? null,
			contrastInjected: contrastInjected ?? false,
		};
		return {
			caseId: item.id,
			pairId: sentinel.pairId,
			category: sentinel.category,
			expectedId: sentinel.expectedId,
			rank,
			injected,
			...contrastOutcome,
			passed: rank === 1 && injected && pairRanksCorrect,
		};
	});
	const groups = new Map<string, SentinelCaseOutcome[]>();
	for (const outcome of outcomes) groups.set(outcome.pairId, [...(groups.get(outcome.pairId) ?? []), outcome]);
	const groupOutcomes: SentinelGroupOutcome[] = [...groups].map(([pairId, grouped]) => ({
		pairId,
		category: grouped[0]?.category ?? "provenance",
		caseIds: grouped.map((outcome) => outcome.caseId),
		passed: grouped.length > 0 && grouped.every((outcome) => outcome.passed),
	}));
	const passedCases = outcomes.filter((outcome) => outcome.passed).length;
	return { cases: outcomes, groups: groupOutcomes, passedCases, totalCases: outcomes.length, allPassed: outcomes.length > 0 && passedCases === outcomes.length };
}

export function evaluateMemoryFixture(
	entries: readonly MemoryEvaluationFact[] = MEMORY_EVALUATION_FACTS,
	cases: readonly MemoryEvaluationCase[] = MEMORY_EVALUATION_CASES,
): MemoryEvaluationReport {
	let maxCharacters = 0;
	let maxEstimatedTokens = 0;
	for (const item of cases) {
		const block = renderFixtureMemory(entries, item);
		maxCharacters = Math.max(maxCharacters, block.length);
		maxEstimatedTokens = Math.max(maxEstimatedTokens, estimateTokens(block));
	}
	return {
		evaluation: "synthetic deterministic lexical retrieval",
		facts: entries.length,
		cases: cases.length,
		methods: {
			substringBaseline: scoreMethod(cases, entries, priorSubstringBaseline),
			ranked: scoreMethod(cases, entries, rankedMethod),
		},
		sentinels: evaluateSentinels(cases, entries),
		injection: {
			maxCharacters,
			maxEstimatedTokens,
			tokenBudget: DEFAULT_MEMORY_CONTEXT_TOKENS,
			withinBudget: maxEstimatedTokens <= DEFAULT_MEMORY_CONTEXT_TOKENS,
		},
		tokenReference: diagnoseTokenReference(),
		limits: [
			"Hand-authored synthetic data; this is not model-driven semantic-quality evaluation.",
			"Tags are explicit lexical bridges; no synonym table or embedding service is used.",
			"Estimated tokens use UTF-8 bytes divided by three, not a provider tokenizer.",
			"Published cl100k_base vector counts are reference data, not current-model tokenizer or billing counts; source literals were transcribed and not locally tokenizer-verified.",
			"Eight vectors include ASCII, whitespace, a control character, and one emoji; they do not establish broad multilingual coverage.",
			"Injection measurements cover the bounded memory block only, not session notes or provider cost.",
		],
	};
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(JSON.stringify(evaluateMemoryFixture(), null, 2));
}
