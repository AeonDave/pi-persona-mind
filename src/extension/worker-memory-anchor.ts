import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const WORKER_CONTRACT_ENTRY = "pi-persona-worker-contract";

/** The launch task and time of a Persona v1 continuation, from the current native branch. */
export function workerMemoryAnchor(manager: ExtensionContext["sessionManager"]): { query: string; timestamp: number } | undefined {
	try {
		if (!manager.getSessionFile()) return undefined;
		const branch = manager.getBranch();
		const contracts = branch.filter((entry) => entry.type === "custom" && entry.customType === WORKER_CONTRACT_ENTRY);
		const contract = contracts[0];
		if (contracts.length !== 1 || contract?.type !== "custom") return undefined;
		const data: unknown = contract.data;
		if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1
			|| !("sha256" in data) || typeof data.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(data.sha256)) return undefined;

		for (const entry of branch.slice(branch.indexOf(contract) + 1)) {
			if (entry.type === "message" && entry.message.role === "user") {
				const { content, timestamp } = entry.message;
				if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > Date.now()) return undefined;
				const query = contentText(content);
				return query.trim() ? { query, timestamp } : undefined;
			}
		}
	} catch { /* Ordinary per-turn ranking still applies when the branch is unreadable. */ }
	return undefined;
}
