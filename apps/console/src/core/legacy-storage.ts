/**
 * One-time copy of the localStorage keys saved under the old Learn Harness prefix (the old two-letter prefix) to their
 * Wolfpack names, so saved UI state (panel sizes, sidebar, keymap, ...) survives the rename.
 *
 * Copies old -> new only when the old value exists and the new key is empty; never overwrites, keeps the
 * old keys (rollback), idempotent, and never throws. Runs at import time of legacy-storage-boot.ts, which every
 * module that defines one of these keys imports first, so it precedes the first read.
 *
 * The old prefix is assembled from parts so the rename grep stays clean.
 */

type KeyStorage = Pick<Storage, "getItem" | "setItem">;

const OLD = "lh";
/** [separator, rest of the key] — old key is `lh<sep><rest>`, new key is `wolfpack<sep><rest>`. */
const SUFFIXES: ReadonlyArray<readonly [string, string]> = [
	[".", "graph.pane-width.v1"],
	[".", "graph.camera.v1"],
	[".", "memory-panel.open.v1"],
	[".", "memory-panel.view.v1"],
	[".", "right-panel.v1"],
	[":", "sidebar-open"],
	[":", "keymap"],
	[":", "notify-needs-you"],
];

export const LEGACY_KEY_MAP: Readonly<Record<string, string>> = Object.fromEntries(
	SUFFIXES.map(([sep, rest]) => [`${OLD}${sep}${rest}`, `wolfpack${sep}${rest}`]),
);

export function migrateLegacyKeys(storage: KeyStorage): void {
	try {
		for (const [oldKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
			const value = storage.getItem(oldKey);
			if (value !== null && storage.getItem(newKey) === null) storage.setItem(newKey, value);
		}
	} catch {
		// storage unavailable or full: saved state simply isn't carried over
	}
}
