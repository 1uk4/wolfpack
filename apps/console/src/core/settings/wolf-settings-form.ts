/**
 * Pure logic of the Settings page form: which input a dotted key gets, the changed-keys-only payload for PUT, wolfd's 400 message
 * split per key, and the 429 retry delay. Browser-safe, no I/O.
 */
export type FieldKind = { kind: "number" | "boolean" | "textarea" | "text" } | { kind: "enum"; options: string[] };

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const NUMBERS = new Set(["subagents.maxRunning", "compaction.startAt", "compaction.reserveTokens", "compaction.keepRecentTokens", "memory.consolidation.threshold", "memory.consolidation.poolTarget"]);

export function fieldKind(key: string): FieldKind {
	if (key.startsWith("prompts.")) return { kind: "textarea" };
	if (key === "compaction.enabled") return { kind: "boolean" };
	if (NUMBERS.has(key)) return { kind: "number" };
	if (key === "memory.consolidation.trigger") return { kind: "enum", options: ["threshold", "timer", "hybrid", "manual"] };
	if (key.endsWith(".thinking")) return { kind: "enum", options: THINKING };
	return { kind: "text" };
}

export function getAt(config: Record<string, unknown>, key: string): unknown {
	let cur: unknown = config;
	for (const seg of key.split(".")) {
		if (!cur || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

/** A draft: the raw text typed, a boolean from a checkbox, or null = clear the key. Absent = untouched. */
export type Draft = string | boolean | null;

export function buildPayload(config: Record<string, unknown>, drafts: Record<string, Draft>): { set: Record<string, unknown>; invalid: Record<string, string> } {
	const set: Record<string, unknown> = {};
	const invalid: Record<string, string> = {};
	for (const [key, draft] of Object.entries(drafts)) {
		const current = getAt(config, key);
		if (draft === null) {
			if (current !== undefined) set[key] = null;
			continue;
		}
		let value: unknown = draft;
		if (typeof draft === "string" && fieldKind(key).kind === "number") {
			const n = Number(draft.trim());
			if (draft.trim() === "" || !Number.isFinite(n)) {
				invalid[key] = "must be a number";
				continue;
			}
			value = n;
		}
		if (value !== current) set[key] = value;
	}
	return { set, invalid };
}

/** wolfd's 400 message is "path: message; path: message". */
export function parseIssues(message: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of message.split("; ")) {
		const i = part.indexOf(": ");
		if (i > 0) out[part.slice(0, i)] = part.slice(i + 2);
	}
	return out;
}

/** `details.retryAfterSeconds` may arrive as a string. */
export function retryAfterSeconds(details: Record<string, unknown> | undefined): number {
	const n = Number(details?.retryAfterSeconds);
	return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
}
