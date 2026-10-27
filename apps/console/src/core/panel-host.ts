/** Pure model of the console's switchable right-panel host: persisted per-thread selection. */

export const RIGHT_PANEL_KEY = "lh.right-panel.v1";
export const DEFAULT_PANEL_ID = "memory";

/** Stored shape: { [threadId]: panelId }. Anything malformed reads as empty. */
export function parseSelections(raw: string | null | undefined): Record<string, string> {
	if (!raw) return {};
	try {
		const v: unknown = JSON.parse(raw);
		if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
		const out: Record<string, string> = {};
		for (const [k, id] of Object.entries(v)) if (typeof id === "string" && id !== "") out[k] = id;
		return out;
	} catch {
		return {};
	}
}

export const serializeSelections = (s: Record<string, string>): string => JSON.stringify(s);

/** The panel to show: the stored choice if it is still available, else the first available one. */
export function resolveSelected(stored: string | undefined, availableIds: readonly string[]): string | null {
	if (stored && availableIds.includes(stored)) return stored;
	if (availableIds.includes(DEFAULT_PANEL_ID)) return DEFAULT_PANEL_ID;
	return availableIds[0] ?? null;
}

export const MAX_SELECTIONS = 50;

/**
 * Record `id` as the thread's panel. Only non-default choices are kept (the default is what an absent entry
 * resolves to), the touched thread moves to the end, and only the `cap` most recent threads survive.
 */
export function withSelection(stored: Record<string, string>, threadId: string, id: string, cap = MAX_SELECTIONS): Record<string, string> {
	const { [threadId]: _drop, ...rest } = stored;
	const next = id === DEFAULT_PANEL_ID ? rest : { ...rest, [threadId]: id };
	const keys = Object.keys(next);
	return keys.length <= cap ? next : Object.fromEntries(keys.slice(keys.length - cap).map((k) => [k, next[k]!]));
}
