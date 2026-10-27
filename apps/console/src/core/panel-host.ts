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
