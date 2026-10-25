/** The extension targets the current Pi contract; this is a floor check, not a compatibility layer. */
export const MIN_PI_VERSION = "1.4.0";

export function isSupportedPiVersion(version: string): boolean {
	const parsed = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
	if (!parsed) return false;
	const parts = parsed.slice(1, 4).map(Number);
	if (parts.some((part) => !Number.isSafeInteger(part))) return false;
	const [major, minor, patch] = parts as [number, number, number];
	if (major !== 1) return major > 1;
	if (minor !== 4) return minor > 4;
	return patch > 0 || parsed[4] === undefined;
}
