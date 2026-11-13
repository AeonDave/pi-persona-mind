import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { scanContent } from "../core/scanner.ts";
import type { ReviewEvidence } from "../core/knowledge-review.ts";

export interface ReviewEvidenceSnapshot { evidence: ReviewEvidence[]; coverage: string[]; assertFresh(): void; }
const MAX_FILES = 6;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024;
const MAX_EXCERPT_CHARS = 8_000;
const MAX_BRANCH_ENTRIES = 2_000;
const MAX_USER_MESSAGES = 12;
const MAX_USER_EACH = 2_000;
const MAX_USER_TOTAL = 6_000;
const MAX_EVIDENCE_SERIALIZED = 24_000;
const MAX_REPOSITORY_SERIALIZED = 18_000;
const ALLOWED = new Set([".md", ".mdx", ".txt", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".html", ".css", ".scss", ".sql", ".sh", ".ps1", ".py", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".xml", ".properties", ".gitignore", ".editorconfig"]);
const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const samePath = (a: string, b: string): boolean => relative(a, b) === "";
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const hiddenPath = (path: string): boolean => path.split("/").some((part) => [".git", "node_modules", "credentials", "private"].includes(part.toLowerCase()) || /^\.env/i.test(part) || /(?:private[-_.]?key|credentials?)/i.test(part));
function checkedPath(path: string): string {
	if (typeof path !== "string" || !path.trim() || path.length > 400 || isAbsolute(path) || /^[\\/]/.test(path) || /[:\u0000-\u001f\u007f-\u009f]/.test(path) || path.split(/[\\/]/).includes("..")) throw new Error("Repository evidence path must be relative and traversal-free, without colons or controls");
	const parts = path.split(/[\\/]/).filter((part) => part !== "" && part !== ".");
	// Reject Win32 aliases (trailing dots/spaces and device names) on every platform.
	if (!parts.length || parts.some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Repository evidence path has an unsupported segment");
	const normalized = parts.join("/");
	if (!scanContent(normalized).ok || hiddenPath(normalized) || !ALLOWED.has(extname(normalized).toLowerCase()) && ![".gitignore", ".editorconfig"].includes(parts.at(-1)!.toLowerCase())) throw new Error("Repository evidence path is excluded or unsupported");
	return normalized;
}
function textContent(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const item = message as { role?: unknown; content?: unknown };
	if (item.role !== "user") return null;
	if (typeof item.content === "string") return item.content;
	if (!Array.isArray(item.content)) return null;
	const texts: string[] = [];
	for (const block of item.content) {
		if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text" || typeof (block as { text?: unknown }).text !== "string") return null;
		texts.push((block as { text: string }).text);
	}
	return texts.join("\n");
}
function branchDigest(branch: readonly SessionEntry[]): string {
	// Bind the bounded active-branch membership/order and full native user text, not tool/assistant payloads.
	return digest(JSON.stringify([branch.length, branch.slice(-MAX_BRANCH_ENTRIES).map((entry) => [entry.id, entry.parentId, entry.type, entry.type === "message" ? digest(textContent(entry.message) ?? "") : null])]));
}

// Keep all descriptor IO in this bounded synchronous reader, also used at the synchronous apply boundary.
// O_NOFOLLOW protects the final component on POSIX; Node does not provide that guarantee on Windows.
// Pre/post component identities, canonical paths and descriptor stats detect observed swaps, not a
// transaction against external writers (including an ancestor swapped out and back between checks).
function readRepositoryFile(root: string, path: string, remaining: number, check: () => void): { bytes: Uint8Array } | { omitted: string } {
	const fullPath = resolve(root, path);
	const rel = relative(root, fullPath);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Repository evidence path escapes project root");
	const inspect = (): BigIntStats[] => {
		const stats: BigIntStats[] = [];
		let cursor = root;
		const parts = path.split("/");
		for (let i = 0; i <= parts.length; i++) {
			if (i > 0) cursor = resolve(cursor, parts[i - 1]!);
			check();
			const stat = lstatSync(cursor, { bigint: true });
			if (stat.isSymbolicLink()) throw new Error("Repository evidence symlink components are not allowed");
			if (i < parts.length ? !stat.isDirectory() : !stat.isFile()) throw new Error("Repository evidence path is not a regular file or directory");
			stats.push(stat);
		}
		check();
		if (!samePath(realpathSync(fullPath), fullPath)) throw new Error("Repository evidence canonical path changed");
		return stats;
	};
	const before = inspect();
	const initial = before.at(-1)!;
	if (initial.size > BigInt(MAX_FILE_BYTES)) return { omitted: "file exceeds 32 KiB limit" };
	if (initial.size > BigInt(remaining)) return { omitted: "64 KiB total raw-byte limit reached" };
	const verifyPath = (): void => {
		const after = inspect();
		if (!after.every((stat, i) => sameIdentity(stat, before[i]!)) || !sameFile(initial, after.at(-1)!)) throw new Error("Repository evidence path or file changed during read");
	};
	const posixFlags = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
	check();
	const fd = openSync(fullPath, constants.O_RDONLY | posixFlags);
	try {
		check();
		const opened = fstatSync(fd, { bigint: true });
		if (!opened.isFile() || !sameFile(initial, opened)) throw new Error("Repository evidence descriptor changed before read");
		verifyPath();
		const buffer = new Uint8Array(Number(initial.size) + 1);
		let count = 0;
		while (count < buffer.length) {
			check();
			const read = readSync(fd, buffer, count, buffer.length - count, count);
			if (read === 0) break;
			count += read;
		}
		check();
		if (count !== Number(initial.size) || !sameFile(opened, fstatSync(fd, { bigint: true }))) throw new Error("Repository evidence file changed during read");
		verifyPath();
		check();
		return { bytes: buffer.slice(0, count) };
	} finally { closeSync(fd); }
}

export async function collectReviewEvidence(ctx: ExtensionContext, paths: readonly string[], isCurrent: () => boolean): Promise<ReviewEvidenceSnapshot> {
	if (!Array.isArray(paths) || paths.length > MAX_FILES) throw new Error("Select at most six explicit repository files");
	const repositoryRequested = paths.length > 0;
	const check = (): void => {
		if (!isCurrent()) throw new Error("Review evidence owner or lifecycle changed; evidence revoked");
		if (repositoryRequested && !ctx.isProjectTrusted()) throw new Error("Repository evidence requires project trust; evidence revoked");
		if (!isCurrent()) throw new Error("Review evidence owner or lifecycle changed; evidence revoked");
	};
	check();
	const selected = paths.map(checkedPath);
	const seen = new Set(selected.map((path) => process.platform === "win32" ? path.toLowerCase() : path));
	if (seen.size !== selected.length) throw new Error("Duplicate repository evidence path");
	check();
	const root = await realpath(ctx.cwd);
	check(); // No subsequent IO if ownership/trust was revoked across the async boundary.
	const rootStat = lstatSync(root, { bigint: true });
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Review project root changed; evidence revoked");
	const checkRoot = (): void => {
		check();
		if (!samePath(realpathSync(ctx.cwd), root)) throw new Error("Review project root changed; evidence revoked");
		check();
		if (!sameIdentity(rootStat, lstatSync(root, { bigint: true }))) throw new Error("Review project root changed; evidence revoked");
	};
	const coverage: string[] = [];
	const evidence: ReviewEvidence[] = [];
	const repoRefs: { path: string; digest: string }[] = [];
	let totalBytes = 0;
	for (const path of selected) {
		checkRoot();
		const result = readRepositoryFile(root, path, MAX_TOTAL_BYTES - totalBytes, check);
		if ("omitted" in result) { coverage.push(`${path}: omitted (${result.omitted})`); continue; }
		const { bytes } = result;
		totalBytes += bytes.length;
		if (bytes.includes(0) || [...bytes.slice(0, Math.min(bytes.length, 4096))].filter((byte) => byte < 9 || byte > 13 && byte < 32).length > 2) {
			coverage.push(`${path}: withheld (unsupported binary or unreadable content)`); continue;
		}
		let raw: string;
		try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
		catch { coverage.push(`${path}: withheld (invalid UTF-8 text)`); continue; }
		const fullDigest = digest(bytes);
		if (!scanContent(raw).ok) { coverage.push(`${path}: withheld (unsafe content detected)`); continue; }
		// A final newline terminates a line; it does not create a fictitious extra source line.
		const lines = raw === "" ? [] : raw.replace(/\r?\n$/, "").split(/\r?\n/);
		const id = `repo-${repoRefs.length + 1}`;
		let fitted: ReviewEvidence | undefined;
		for (let i = 0; i < lines.length; i++) {
			const text = `${fitted ? fitted.text + "\n" : ""}${i + 1}: ${lines[i]}`;
			const item: ReviewEvidence = { id, kind: "repository", label: `${path}:1-${i + 1}`, text, digest: fullDigest };
			if (text.length > MAX_EXCERPT_CHARS || JSON.stringify([...evidence, item]).length > MAX_REPOSITORY_SERIALIZED) break;
			fitted = item;
		}
		if (!fitted) { coverage.push(`${path}: omitted (admitted 0/${lines.length} lines; no whole source line fits the excerpt/evidence budget)`); continue; }
		if (!scanContent(fitted.text).ok) { coverage.push(`${path}: withheld (unsafe excerpt detected)`); continue; }
		const lineCount = fitted.text.split("\n").length;
		evidence.push(fitted);
		repoRefs.push({ path, digest: fullDigest });
		coverage.push(`${path}: admitted ${lineCount}/${lines.length} lines (1-${lineCount}); full-file SHA-256 recorded${lineCount < lines.length ? "; clipped (whole-line excerpt/evidence budget)" : "; complete file"}.`);
	}

	check();
	const branch = ctx.sessionManager.getBranch();
	check();
	const nativeDigest = branchDigest(branch);
	const branchLength = branch.length;
	const branchAnchor = branch.at(-1)?.id;
	const recent = branch.slice(-MAX_BRANCH_ENTRIES);
	if (branch.length > recent.length) coverage.push(`Native branch limited to newest ${MAX_BRANCH_ENTRIES} entries; earlier history not checked.`);
	let userTotal = 0;
	let userCount = 0;
	const omitted = { long: 0, aggregate: 0, count: 0, serialized: 0, unsafe: 0 };
	for (let i = recent.length - 1; i >= 0; i--) {
		const entry = recent[i]!;
		if (entry.type !== "message") continue;
		const text = textContent(entry.message);
		if (text === null || !text.trim()) continue;
		if (text.length > MAX_USER_EACH) { omitted.long++; continue; }
		if (userCount >= MAX_USER_MESSAGES) { omitted.count++; continue; }
		if (text.length + userTotal > MAX_USER_TOTAL) { omitted.aggregate++; continue; }
		if (!scanContent(text).ok) { omitted.unsafe++; continue; }
		// Native IDs are labels only, never authority or paths; omit unsafe/oversized labels too.
		if (entry.id.length > 200 || !scanContent(entry.id).ok) { omitted.unsafe++; continue; }
		const item: ReviewEvidence = { id: `user-${userCount + 1}`, kind: "user-message", label: `active native branch user-role entry ${entry.id} (whole message; authorship unverified)`, text, digest: digest(text) };
		if (JSON.stringify([...evidence, item]).length > MAX_EVIDENCE_SERIALIZED) { omitted.serialized++; continue; }
		evidence.push(item);
		userTotal += text.length; userCount++;
	}
	if (omitted.long) coverage.push(`${omitted.long} whole native user message(s) omitted (exceeds 2000 characters each); no partial intent supplied.`);
	if (omitted.aggregate) coverage.push(`${omitted.aggregate} whole native user message(s) omitted (6000-character aggregate limit); no partial intent supplied.`);
	if (omitted.count) coverage.push(`${omitted.count} whole native user message(s) omitted (12-message limit).`);
	if (omitted.serialized) coverage.push(`${omitted.serialized} whole native user message(s) omitted (serialized review evidence budget).`);
	if (omitted.unsafe) coverage.push("Unsafe native user-role text or labels withheld (content safety filter); actual text omitted.");
	coverage.push(`Native evidence: newest qualifying whole user-role messages only; authorship unverified; scope is active branch; ${userCount} messages / ${userTotal} characters admitted. Assistant, tool, custom, image, and reasoning content excluded.`);
	const assertFresh = (): void => {
		checkRoot();
		for (const ref of repoRefs) {
			checkRoot();
			try {
				const result = readRepositoryFile(root, ref.path, MAX_FILE_BYTES, check);
				if (!("bytes" in result) || digest(result.bytes) !== ref.digest) throw new Error();
			} catch { throw new Error(`Review evidence changed, revoked or unreadable: ${ref.path}`); }
		}
		check();
		const current = ctx.sessionManager.getBranch();
		check();
		// Review reports/previews legitimately append native entries. Bind the captured prefix and
		// anchor, not the current leaf. isCurrent separately fences host branch-navigation events.
		if (current.length < branchLength || current[branchLength - 1]?.id !== branchAnchor || branchDigest(current.slice(0, branchLength)) !== nativeDigest) throw new Error("Review native evidence or active branch changed or was revoked");
		checkRoot();
	};
	checkRoot();
	return { evidence, coverage, assertFresh };
}
