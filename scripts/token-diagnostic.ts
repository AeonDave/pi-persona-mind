import { createHash } from "node:crypto";

import { estimateTokens } from "../src/core/context-budget.ts";
import { TOKEN_REFERENCE_FIXTURE, type TokenReferenceFixture } from "../test/fixtures/token-reference.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const GENERATION_METHOD = "transcribed published literal assertions; not locally tokenized";

export interface TokenReferenceVectorDiagnostic {
	id: string;
	text: string;
	utf8Bytes: number;
	referenceTokenIds: readonly number[];
	referenceTokenCount: number;
	estimatedTokens: number;
	/** Estimate minus published reference count; negative values are underestimates. */
	signedDifference: number;
	underestimates: boolean;
}

export interface TokenReferenceDiagnostic {
	encoding: string;
	provenance: TokenReferenceFixture["provenance"];
	verification: string;
	interpretation: string;
	languagePolicy: string;
	vectors: TokenReferenceVectorDiagnostic[];
	errorSummary: {
		vectorCount: number;
		underestimateCount: number;
		totalAbsoluteDifference: number;
		maxAbsoluteDifference: number;
		meanAbsoluteDifference: number;
	};
}

function invalid(message: string): never {
	throw new Error(`Invalid token reference fixture: ${message}`);
}

function requireText(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) invalid(`${field} is missing`);
}

function requireHttpsURL(value: unknown, field: string): asserts value is string {
	requireText(value, field);
	try {
		if (new URL(value).protocol !== "https:") invalid(`${field} must use HTTPS`);
	} catch {
		invalid(`${field} must be a valid HTTPS URL`);
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Validate committed facts only; this performs no source/network access or tokenizer execution. */
export function validateTokenReferenceFixture(fixture: TokenReferenceFixture): void {
	if (typeof fixture !== "object" || fixture === null) invalid("fixture is missing");
	const provenance = fixture.provenance;
	if (typeof provenance !== "object" || provenance === null) invalid("provenance is missing");
	requireText(provenance.encoding, "provenance.encoding");
	requireText(provenance.implementation, "provenance.implementation");
	requireText(provenance.implementationVersion, "provenance.implementationVersion");
	if (!GIT_SHA_PATTERN.test(provenance.implementationVersion)) invalid("provenance.implementationVersion must be a full git SHA");
	requireText(provenance.sourceCommitterDate, "provenance.sourceCommitterDate");
	if (!Number.isFinite(Date.parse(provenance.sourceCommitterDate))) invalid("provenance.sourceCommitterDate must be a date");
	requireHttpsURL(provenance.sourceURL, "provenance.sourceURL");
	requireHttpsURL(provenance.licenseURL, "provenance.licenseURL");
	if (!SHA256_PATTERN.test(provenance.sourceFileSHA256)) invalid("provenance.sourceFileSHA256 must be a SHA-256 digest");
	if (provenance.generationMethod !== GENERATION_METHOD) invalid("provenance.generationMethod is missing or unsupported");
	if (!Array.isArray(provenance.sourceAssertionTests) || provenance.sourceAssertionTests.length === 0 || provenance.sourceAssertionTests.some((name) => typeof name !== "string" || name.trim().length === 0)) {
		invalid("provenance.sourceAssertionTests must list published assertions");
	}
	if (!provenance.sourceURL.includes(provenance.implementationVersion) || !provenance.licenseURL.includes(provenance.implementationVersion)) {
		invalid("source and license URLs must use the recorded implementation version");
	}
	if (!Array.isArray(fixture.vectors) || fixture.vectors.length === 0) invalid("vectors are missing");

	const seenIds = new Set<string>();
	for (const vector of fixture.vectors) {
		if (typeof vector !== "object" || vector === null) invalid("a vector is missing");
		requireText(vector.id, "vector.id");
		if (seenIds.has(vector.id)) invalid(`duplicate vector id ${vector.id}`);
		seenIds.add(vector.id);
		if (typeof vector.text !== "string") invalid(`${vector.id}.text is missing`);
		if (!Array.isArray(vector.expectedTokenIds) || vector.expectedTokenIds.some((id: unknown) => typeof id !== "number" || !Number.isSafeInteger(id) || id < 0)) {
			invalid(`${vector.id}.expectedTokenIds must contain non-negative integer IDs`);
		}
		if (!Number.isSafeInteger(vector.expectedTokenCount) || vector.expectedTokenCount < 0 || vector.expectedTokenCount !== vector.expectedTokenIds.length) {
			invalid(`${vector.id}.expectedTokenCount does not match the reference ID count`);
		}
		if (!SHA256_PATTERN.test(vector.textSHA256) || sha256(vector.text) !== vector.textSHA256) {
			invalid(`${vector.id}.text SHA-256 does not match its exact UTF-8 text`);
		}
		if (!SHA256_PATTERN.test(vector.expectedTokenIDsSHA256) || sha256(JSON.stringify(vector.expectedTokenIds)) !== vector.expectedTokenIDsSHA256) {
			invalid(`${vector.id}.token ID SHA-256 does not match its reference IDs`);
		}
	}
}

/** Compare the existing UTF-8-bytes/3 estimator with published IDs; never fetch or tokenize. */
export function diagnoseTokenReference(fixture: TokenReferenceFixture = TOKEN_REFERENCE_FIXTURE): TokenReferenceDiagnostic {
	validateTokenReferenceFixture(fixture);
	const encoder = new TextEncoder();
	const vectors = fixture.vectors.map((vector): TokenReferenceVectorDiagnostic => {
		const estimatedTokens = estimateTokens(vector.text);
		const referenceTokenCount = vector.expectedTokenIds.length;
		const signedDifference = estimatedTokens - referenceTokenCount;
		return {
			id: vector.id,
			text: vector.text,
			utf8Bytes: encoder.encode(vector.text).byteLength,
			referenceTokenIds: [...vector.expectedTokenIds],
			referenceTokenCount,
			estimatedTokens,
			signedDifference,
			underestimates: signedDifference < 0,
		};
	});
	const absoluteDifferences = vectors.map((vector) => Math.abs(vector.signedDifference));
	const totalAbsoluteDifference = absoluteDifferences.reduce((sum, difference) => sum + difference, 0);
	return {
		encoding: fixture.provenance.encoding,
		provenance: fixture.provenance,
		verification: "source literals transcribed; source assertions not locally executed tokenizer verification",
		interpretation: "published cl100k_base reference vectors, not current-model billing",
		languagePolicy: "all text uses the same UTF-8 bytes / 3 estimate; no language detection or per-language factor",
		vectors,
		errorSummary: {
			vectorCount: vectors.length,
			underestimateCount: vectors.filter((vector) => vector.underestimates).length,
			totalAbsoluteDifference,
			maxAbsoluteDifference: Math.max(...absoluteDifferences),
			meanAbsoluteDifference: Number((totalAbsoluteDifference / vectors.length).toFixed(3)),
		},
	};
}
