export interface TokenReferenceProvenance {
	encoding: string;
	implementation: string;
	implementationVersion: string;
	sourceCommitterDate: string;
	sourceURL: string;
	sourceFileSHA256: string;
	licenseURL: string;
	generationMethod: string;
	sourceAssertionTests: readonly string[];
}

export interface TokenReferenceVector {
	id: string;
	text: string;
	expectedTokenIds: readonly number[];
	expectedTokenCount: number;
	textSHA256: string;
	expectedTokenIDsSHA256: string;
}

export interface TokenReferenceFixture {
	provenance: TokenReferenceProvenance;
	vectors: readonly TokenReferenceVector[];
}

const SOURCE_PIN = "79dc2c0533685b893616c78160b5d9e40876e724";
const SOURCE_BASE = `https://raw.githubusercontent.com/openai/tiktoken/${SOURCE_PIN}`;

/** Transcribed published assertions only; no tokenizer package is installed or executed locally. */
export const TOKEN_REFERENCE_FIXTURE: TokenReferenceFixture = {
	provenance: {
		encoding: "cl100k_base",
		implementation: "openai/tiktoken",
		implementationVersion: SOURCE_PIN,
		sourceCommitterDate: "2026-11-08T08:48:19Z",
		sourceURL: `${SOURCE_BASE}/tests/test_encoding.py`,
		sourceFileSHA256: "6d81f28bb3c2877a3b02f2520047939c70640fe0104994c97a15a9b493ae6ca7",
		licenseURL: `${SOURCE_BASE}/LICENSE`,
		generationMethod: "transcribed published literal assertions; not locally tokenized",
		sourceAssertionTests: ["test_simple", "test_simple_regex", "test_basic_encode", "test_encode_surrogate_pairs"],
	},
	vectors: [
		{
			id: "hello-world",
			text: "hello world",
			expectedTokenIds: [15339, 1917],
			expectedTokenCount: 2,
			textSHA256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
			expectedTokenIDsSHA256: "6d28190f6bbe32fc1af7e302f93481b7f305461cb2cd700118d3f2c5658b41e2",
		},
		{
			id: "rer",
			text: "rer",
			expectedTokenIds: [38149],
			expectedTokenCount: 1,
			textSHA256: "07b8fbe890349c656939ab13f49c10aadc91a1e1501ba15478157ea877132759",
			expectedTokenIDsSHA256: "4f5fe5cb4830837082ee9eb6e0eb6f206825dcdba0ef4cd14c0c270334f802fa",
		},
		{
			id: "apostrophe-rer",
			text: "'rer",
			expectedTokenIds: [2351, 81],
			expectedTokenCount: 2,
			textSHA256: "1d7bc2ebd569f358187a6c3235833cb85f8378a550675335e40a49acae6a45c6",
			expectedTokenIDsSHA256: "1e6abd3bfe7960de3247543ae5c2573cd6d3a577931fea3eaed193bb9e0e67b9",
		},
		{
			id: "today-newline-space",
			text: "today\n ",
			expectedTokenIds: [31213, 198, 220],
			expectedTokenCount: 3,
			textSHA256: "b7a561ce2353d5bd5ab7f3cfe5bedae77e196cca59466ea3a872cc1b411b8d1c",
			expectedTokenIDsSHA256: "5ca32eb7ba3fb49cb5edf92dd4bfdda42ceea26309faf722f90d11eaa05f4b7d",
		},
		{
			id: "today-newline-space-newline",
			text: "today\n \n",
			expectedTokenIds: [31213, 27907],
			expectedTokenCount: 2,
			textSHA256: "f54156a1365c08cad2f1555fbda9c87b2233722dabbf3d30f3983aaec5fa646a",
			expectedTokenIDsSHA256: "67788ec0efb2a88c43587dd4e3480fea4e72a6aafeeb939e0eb0b9e41148176a",
		},
		{
			id: "today-newline-two-spaces-newline",
			text: "today\n  \n",
			expectedTokenIds: [31213, 14211],
			expectedTokenCount: 2,
			textSHA256: "d1852b8aac2b4cecca8a226c6cde04729e39d1f8baaefd2e5002d68997e6fbf1",
			expectedTokenIDsSHA256: "db60ed7be0c97a03ee1ab8453c1a078c06c82042d9336644f77cda96c0e2648f",
		},
		{
			id: "control-u0085",
			text: " \u00850",
			expectedTokenIds: [220, 126, 227, 15],
			expectedTokenCount: 4,
			textSHA256: "d67cf4832f617f146a29b5eda535498d6423e304fad2d80fbc451dc5483d86a0",
			expectedTokenIDsSHA256: "8b316bc16bf913fc8e37206c07f5674606d86ff95d9cf9e3120f061439f3030a",
		},
		{
			id: "thumbs-up",
			text: "👍",
			expectedTokenIds: [9468, 239, 235],
			expectedTokenCount: 3,
			textSHA256: "5d57d39e6b7d8ea050980e6665bb1da357db14249d74e122f7d4e8cc2253beff",
			expectedTokenIDsSHA256: "608f56d665689c4c0c13280d5d725f9006c2a72d1203bce9fb60a4b09fe95a9e",
		},
	],
};
