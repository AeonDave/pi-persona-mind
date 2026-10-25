/**
 * Shared conservative planning estimate for injected context. It is deliberately not presented as
 * a provider tokenizer: unusual byte-pair splits can differ. UTF-8 bytes / 3 is simple, stable,
 * and errs high for ordinary English while treating non-ASCII content by its actual byte cost.
 */

const encoder = new TextEncoder();
export const DEFAULT_MEMORY_CONTEXT_TOKENS = 2_400;

export function estimateTokens(text: string | readonly string[]): number {
	const blocks = typeof text === "string" ? [text] : text;
	return blocks.reduce((total, block, index) => total + Math.ceil(encoder.encode(block).byteLength / 3) + (index === 0 ? 0 : 1), 0);
}

export interface ContextBudgetCandidate<T> {
	value: T;
	/** High-priority context is considered before ordinary candidates but still obeys the hard cap. */
	pinned?: boolean;
}

export interface FitContextOptions<T> {
	maxTokens: number;
	/** Complete, already-rendered blocks that share the same total context budget. */
	fixedBlocks?: readonly string[];
	/** Render a complete fenced block and an omission disclosure for the selected whole items. */
	render(items: readonly T[], omitted: number): string;
}

export interface FitContextResult<T> {
	items: T[];
	omitted: number;
	text: string;
	estimatedTokens: number;
	overBudget: boolean;
}

/**
 * Select complete entries in priority order. Pinned entries are considered first, but still obey
 * the hard cap. The render callback owns XML/JSON/trust fences and receives the omission count, so
 * the final wrapper/footer is measured too. If fixed blocks alone exceed the cap, overBudget says so.
 */
export function fitContextItems<T>(
	candidates: readonly ContextBudgetCandidate<T>[],
	options: FitContextOptions<T>,
): FitContextResult<T> {
	const maxTokens = Number.isNaN(options.maxTokens) ? 0 : Math.max(0, options.maxTokens);
	const selectedIndexes = new Set<number>();
	const valuesFor = (indexes: ReadonlySet<number>): T[] => candidates.flatMap((candidate, index) => indexes.has(index) ? [candidate.value] : []);
	const measure = (indexes: ReadonlySet<number>, omitted: number): { text: string; tokens: number } => {
		const text = options.render(valuesFor(indexes), omitted);
		return { text, tokens: estimateTokens([...(options.fixedBlocks ?? []), text]) };
	};

	const fitOrder = candidates.map((_, index) => index).sort((a, b) => Number(!candidates[a]?.pinned) - Number(!candidates[b]?.pinned) || a - b);
	for (const index of fitOrder) {
		if (selectedIndexes.has(index)) continue;
		const trial = new Set(selectedIndexes);
		trial.add(index);
		// Reserve room for the largest possible omission count: later candidates may also be omitted.
		const omitted = candidates.length - trial.size;
		if (measure(trial, omitted).tokens <= maxTokens) selectedIndexes.add(index);
	}

	const items = valuesFor(selectedIndexes);
	const omitted = candidates.length - selectedIndexes.size;
	const final = measure(selectedIndexes, omitted);
	return {
		items,
		omitted,
		text: final.text,
		estimatedTokens: final.tokens,
		overBudget: final.tokens > maxTokens,
	};
}
