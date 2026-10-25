/** Reproducible offline lexical retrieval and bounded-injection evaluation. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_MEMORY_CONTEXT_TOKENS, estimateTokens } from "../src/core/context-budget.ts";
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

export interface MemoryEvaluationReport {
	evaluation: "synthetic deterministic lexical retrieval";
	facts: number;
	cases: number;
	methods: { substringBaseline: MethodMetrics; ranked: MethodMetrics };
	injection: { maxCharacters: number; maxEstimatedTokens: number; tokenBudget: number; withinBudget: boolean };
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

function scoreMethod(cases: readonly MemoryEvaluationCase[], rank: RankFunction): MethodMetrics {
	const judged = cases.filter((item) => item.relevantIds.length > 0);
	let hitAt1 = 0;
	let hitAt3 = 0;
	let reciprocalRankTotal = 0;
	for (const item of judged) {
		const results = rank(MEMORY_EVALUATION_FACTS, item.query);
		const firstRelevant = results.findIndex((entry) => item.relevantIds.includes(entry.id));
		if (firstRelevant === 0) hitAt1++;
		if (firstRelevant >= 0 && firstRelevant < 3) hitAt3++;
		if (firstRelevant >= 0) reciprocalRankTotal += 1 / (firstRelevant + 1);
	}
	const abstentionCases = cases.filter((item) => item.relevantIds.length === 0);
	const abstentionCorrect = abstentionCases.filter((item) => rank(MEMORY_EVALUATION_FACTS, item.query).length === 0).length;
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

export function evaluateMemoryFixture(): MemoryEvaluationReport {
	const split = (tier: MemoryEvaluationFact["tier"]): MemoryEvaluationFact[] => MEMORY_EVALUATION_FACTS.filter((entry) => entry.tier === tier);
	let maxCharacters = 0;
	let maxEstimatedTokens = 0;
	for (const item of MEMORY_EVALUATION_CASES) {
		const block = renderMind({
			persona: "elite",
			ltm: split("persona"),
			projectLtm: split("project"),
			stm: split("working"),
			backlog: [],
			now: MEMORY_EVALUATION_NOW,
			query: item.query,
			budget: { ltm: 8, projectLtm: 4, stm: 5, backlog: 0, tokens: DEFAULT_MEMORY_CONTEXT_TOKENS },
		});
		maxCharacters = Math.max(maxCharacters, block.length);
		maxEstimatedTokens = Math.max(maxEstimatedTokens, estimateTokens(block));
	}
	return {
		evaluation: "synthetic deterministic lexical retrieval",
		facts: MEMORY_EVALUATION_FACTS.length,
		cases: MEMORY_EVALUATION_CASES.length,
		methods: {
			substringBaseline: scoreMethod(MEMORY_EVALUATION_CASES, priorSubstringBaseline),
			ranked: scoreMethod(MEMORY_EVALUATION_CASES, rankedMethod),
		},
		injection: {
			maxCharacters,
			maxEstimatedTokens,
			tokenBudget: DEFAULT_MEMORY_CONTEXT_TOKENS,
			withinBudget: maxEstimatedTokens <= DEFAULT_MEMORY_CONTEXT_TOKENS,
		},
		limits: [
			"Hand-authored synthetic data; this is not model-driven semantic-quality evaluation.",
			"Tags are explicit lexical bridges; no synonym table or embedding service is used.",
			"Estimated tokens use UTF-8 bytes divided by three, not a provider tokenizer.",
			"Injection measurements cover the bounded memory block only, not session notes or provider cost.",
		],
	};
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(JSON.stringify(evaluateMemoryFixture(), null, 2));
}
