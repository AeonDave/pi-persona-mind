/** The extension targets current Pi only; this is a floor check, not a compatibility layer. */
export const MIN_PI_VERSION = "1.5.2";

export function isSupportedPiVersion(version: string): boolean {
	const parsed = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
	if (!parsed) return false;
	const parts = parsed.slice(1, 4).map(Number);
	if (parts.some((part) => !Number.isSafeInteger(part))) return false;
	const current = parts as [number, number, number];
	const minimum = [1, 5, 2] as const;
	for (let i = 0; i < minimum.length; i++) {
		if (current[i]! > minimum[i]!) return true;
		if (current[i]! < minimum[i]!) return false;
	}
	return parsed[4] === undefined;
}
