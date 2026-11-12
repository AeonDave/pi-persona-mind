/** Lazy adapter for Persona's one versioned card-frame implementation. */
import type { EntryRenderOptions, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { compactVisibleText, sanitizeCardText } from "./presentation.ts";

export const CARD_FRAME_EVENT = "pi-persona:card-frame:v1";

export type CardFrameState = "neutral" | "success" | "attention" | "error";

export interface CardFramePreview {
	text: string;
	truncated: boolean;
}

export interface CardFramePresentation {
	title: string;
	state: CardFrameState;
	full: string;
	preview: (width: number) => CardFramePreview;
	metadata?: string;
	markdown?: boolean;
}

export interface CardFrameContext {
	expanded: boolean;
	theme: Theme;
	outputPad: number;
	detailHint: () => string;
}

export type CardFrameFactory = (presentation: CardFramePresentation, context: CardFrameContext) => Component;

export interface CardFrameProviderResponse {
	version: 1;
	provider: "pi-persona";
	createCard: CardFrameFactory;
}

export interface CardFrameQuery {
	version: 1;
	respond: (response: CardFrameProviderResponse) => void;
}

export interface CardFrameEventBus {
	emit(event: string, data: unknown): void;
}

export interface MindCardUI {
	renderCard: CardFrameRenderer;
	/** Read from Pi's current effective settings for every entry-render invocation. */
	outputPad: () => 0 | 1;
}

export type CardFrameRenderer = (presentation: CardFramePresentation, context: CardFrameContext) => Component;

const MAX_COLLAPSED_CARD_LINES = 3;
const CARD_HINT_ID = "app.tools.expand";
const CARD_HINT_DESCRIPTION = "to expand";

function plainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function validFactory(value: unknown): CardFrameFactory | undefined {
	if (!plainObject(value)) return undefined;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== 3 || keys.some((key) => key !== "version" && key !== "provider" && key !== "createCard")) return undefined;
	if (value.version !== 1 || value.provider !== "pi-persona" || typeof value.createCard !== "function") return undefined;
	return value.createCard as CardFrameFactory;
}

function isComponent(value: unknown): value is Component {
	return !!value && typeof value === "object"
		&& typeof (value as { render?: unknown }).render === "function"
		&& typeof (value as { invalidate?: unknown }).invalidate === "function";
}

/** No second styling system: if Persona is absent or unsafe, show complete sanitized plaintext. */
function plaintextFallback(presentation: CardFramePresentation): Component {
	const title = sanitizeCardText(presentation.title).trim();
	const safeFull = sanitizeCardText(presentation.full);
	const full = safeFull.length > 0 ? safeFull : "(no output)";
	return new Text(title ? `${title}\n${full}` : full, 0, 0);
}

function queryFactory(events: CardFrameEventBus): CardFrameFactory | undefined {
	let synchronous = true;
	let responseCount = 0;
	let factory: CardFrameFactory | undefined;
	const query: CardFrameQuery = {
		version: 1,
		respond(response) {
			if (!synchronous) return;
			const candidate = validFactory(response);
			if (!candidate) return;
			responseCount++;
			factory = candidate;
		},
	};
	try {
		events.emit(CARD_FRAME_EVENT, query);
	} catch {
		return undefined;
	} finally {
		synchronous = false;
	}
	return responseCount === 1 ? factory : undefined;
}

/**
 * Bind one UI adapter to one extension instance. The shared factory lookup is intentionally fresh
 * for every render so extension load order, reload and provider replacement are observed.
 */
export function createMindCardUI(pi: Pick<ExtensionAPI, "events" | "getSettings">): MindCardUI {
	const renderCard: CardFrameRenderer = (presentation, context) => {
		const fallback = () => plaintextFallback(presentation);
		try {
			const factory = queryFactory(pi.events);
			if (!factory) return fallback();
			const component = factory(presentation, context);
			return isComponent(component) ? component : fallback();
		} catch {
			return fallback();
		}
	};
	return {
		renderCard,
		outputPad: () => {
			try {
				return pi.getSettings().outputPad === 0 ? 0 : 1;
			} catch {
				return 1;
			}
		},
	};
}

/** Build the shared-frame presentation without changing the persisted/history payload. */
export function cardFramePresentation(title: string, full: string, compactSummary?: string): CardFramePresentation {
	const previewSource = compactSummary ?? full;
	return {
		title,
		state: "neutral",
		full,
		preview(width) {
			const previewWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 96;
			const preview = compactVisibleText(previewSource, {
				maxLines: MAX_COLLAPSED_CARD_LINES,
				maxLineChars: previewWidth,
			});
			return { text: preview.text, truncated: compactSummary !== undefined || preview.truncated };
		},
	};
}

export function cardFrameDetailHint(keyHint: EntryRenderOptions["keyHint"]): () => string {
	return () => keyHint(CARD_HINT_ID, CARD_HINT_DESCRIPTION);
}
