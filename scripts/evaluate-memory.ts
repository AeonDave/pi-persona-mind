/** Reproducible offline lexical retrieval and bounded-injection evaluation. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_MEMORY_CONTEXT_TOKENS, estimateTokens } from "../src/core/context-budget.ts";
import { diagnoseTokenReference } from "./token-diagnostic.ts";
import { renderMind } from "../src/core/inject.ts";
import type { MemoryEntry } from "../src/core/memory.ts";
import { rankMemoryEntries } from "../src/core/retrieval.ts";
import { rankMemoryEntries as priorLexicalRank } from "../test/fixtures/pre-normalization-retrieval.ts";
import { renderMind as priorRenderMind } from "../test/fixtures/pre-normalization-inject.ts";
import { HELDOUT_RETRIEVAL_CASES, HELDOUT_RETRIEVAL_FACTS } from "../test/fixtures/retrieval-heldout.ts";
import {
	MEMORY_EVALUATION_CASES,
	MEMORY_EVALUATION_FACTS,
	MEMORY_EVALUATION_NOW,
	NORMALIZATION_EVALUATION_CASES,
	NORMALIZATION_EVALUATION_FACTS,
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
	/** Counts every top-three result outside relevantIds, ignoring acceptableIds. */
	strictFalsePositiveResultsAt3: number;
	/** Label-aware count: weaker acceptable alternatives are excluded. */
	falsePositiveResultsAt3: number;
	negativeQueriesWithResults: number;
}

interface NormalizationMethodMetrics extends MethodMetrics {
	injectedRelevantCases: number;
	injectedNonRelevantFacts: number;
}

interface NormalizationCohort {
	facts: number;
	cases: number;
	baseline: NormalizationMethodMetrics;
	improved: NormalizationMethodMetrics;
	budget: { ltm: number; projectLtm: number; stm: number; backlog: number; tokens: number };
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
	methods: { substringBaseline: MethodMetrics; lexicalBaseline: MethodMetrics; ranked: MethodMetrics };
	normalization: { development: NormalizationCohort; heldout: NormalizationCohort };
	sentinels: { cases: SentinelCaseOutcome[]; groups: SentinelGroupOutcome[]; passedCases: number; totalCases: number; allPassed: boolean };
	sentinelBaseline: MemoryEvaluationReport["sentinels"];
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

function priorLexicalMethod(entries: readonly MemoryEvaluationFact[], query: string): MemoryEntry[] {
	return priorLexicalRank(entries, query).filter((ranked) => ranked.score > 0).map((ranked) => ranked.entry);
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
	const strictFalsePositiveResultsAt3 = cases.reduce((total, item) => total + rank(entries, item.query).slice(0, 3)
		.filter((entry) => !item.relevantIds.includes(entry.id)).length, 0);
	const falsePositiveResultsAt3 = cases.reduce((total, item) => total + rank(entries, item.query).slice(0, 3)
		.filter((entry) => !item.relevantIds.includes(entry.id) && !item.acceptableIds?.includes(entry.id)).length, 0);
	const rate = (value: number, denominator: number): number => denominator === 0 ? 0 : Number((value / denominator).toFixed(3));
	return {
		hitAt1: rate(hitAt1, judged.length),
		hitAt3: rate(hitAt3, judged.length),
		mrr: rate(reciprocalRankTotal, judged.length),
		judgedCases: judged.length,
		abstentionCases: abstentionCases.length,
		abstentionCorrect,
		strictFalsePositiveResultsAt3,
		falsePositiveResultsAt3,
		negativeQueriesWithResults: abstentionCases.length - abstentionCorrect,
	};
}

function renderFixtureMemory(entries: readonly MemoryEvaluationFact[], item: MemoryEvaluationCase,
	render: typeof renderMind = renderMind,
	budget = { ltm: 8, projectLtm: 4, stm: 5, backlog: 0, tokens: DEFAULT_MEMORY_CONTEXT_TOKENS },
): string {
	const split = (tier: MemoryEvaluationFact["tier"]): MemoryEvaluationFact[] => entries.filter((entry) => entry.tier === tier);
	return render({
		persona: "elite",
		ltm: split("persona"),
		projectLtm: split("project"),
		stm: split("working"),
		backlog: [],
		now: MEMORY_EVALUATION_NOW,
		query: item.query,
		budget,
	});
}

function evaluateNormalizationCohort(entries: readonly MemoryEvaluationFact[], cases: readonly MemoryEvaluationCase[]): NormalizationCohort {
	// Both methods see the same full corpus, scopes and constraints; only the frozen ranker differs.
	const budget = { ltm: 2, projectLtm: 2, stm: 2, backlog: 0, tokens: 400 };
	const measure = (rank: RankFunction, render: typeof renderMind): NormalizationMethodMetrics => {
		let injectedRelevantCases = 0;
		let injectedNonRelevantFacts = 0;
		for (const item of cases) {
			const block = renderFixtureMemory(entries, item, render, budget);
			if (estimateTokens(block) > budget.tokens) throw new Error("Normalization injection exceeds its common token budget");
			const injected = entries.filter((entry) => block.includes(entry.text));
			if (injected.some((entry) => item.relevantIds.includes(entry.id))) injectedRelevantCases++;
			injectedNonRelevantFacts += injected.filter((entry) => !item.relevantIds.includes(entry.id) && !item.acceptableIds?.includes(entry.id)).length;
		}
		return { ...scoreMethod(cases, entries, rank), injectedRelevantCases, injectedNonRelevantFacts };
	};
	return { facts: entries.length, cases: cases.length, baseline: measure(priorLexicalMethod, priorRenderMind), improved: measure(rankedMethod, renderMind), budget };
}

function evaluateSentinels(cases: readonly MemoryEvaluationCase[], entries: readonly MemoryEvaluationFact[],
	rankEntries: typeof priorLexicalRank = rankMemoryEntries, render: typeof renderMind = renderMind,
): MemoryEvaluationReport["sentinels"] {
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
		const ranked = rankEntries(entries, item.query).filter((result) => result.score > 0);
		const rankIndex = ranked.findIndex((result) => result.entry.id === sentinel.expectedId);
		const fact = entries.find((entry) => entry.id === sentinel.expectedId);
		const block = renderFixtureMemory(entries, item, render);
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
			lexicalBaseline: scoreMethod(cases, entries, priorLexicalMethod),
			ranked: scoreMethod(cases, entries, rankedMethod),
		},
		normalization: {
			development: evaluateNormalizationCohort(NORMALIZATION_EVALUATION_FACTS, NORMALIZATION_EVALUATION_CASES),
			heldout: evaluateNormalizationCohort(HELDOUT_RETRIEVAL_FACTS, HELDOUT_RETRIEVAL_CASES),
		},
		sentinels: evaluateSentinels(cases, entries),
		sentinelBaseline: evaluateSentinels(cases, entries, priorLexicalRank, priorRenderMind),
		injection: {
			maxCharacters,
			maxEstimatedTokens,
			tokenBudget: DEFAULT_MEMORY_CONTEXT_TOKENS,
			withinBudget: maxEstimatedTokens <= DEFAULT_MEMORY_CONTEXT_TOKENS,
		},
		tokenReference: diagnoseTokenReference(),
		limits: [
			"Hand-authored synthetic data; this is not model-driven semantic-quality evaluation.",
			"The held-out set was written alongside the implementation, not withheld from it; this small synthetic sample is not an external benchmark.",
			"Prior lexical ranker and renderer are frozen repository-source test fixtures; scopes and budgets are identical within each comparison.",
			"strictFalsePositiveResultsAt3 counts top-three positive-score recall rows outside relevantIds, ignoring acceptableIds; falsePositiveResultsAt3 excludes acceptableIds. Injection uses acceptable labels and can include non-relevant standing context even on a negative query; its separate count is not recall precision.",
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
