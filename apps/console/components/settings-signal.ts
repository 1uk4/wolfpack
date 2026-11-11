"use client";

/**
 * THE cross-surface settings signal (fix wave, owner ruling 2026-09-22):
 * every WRITER dispatches after a successful PUT, every READER re-reads —
 * the composer reflects the strong slot the instant setup saves, the
 * settings section reflects the composer's pick on its next mount... and
 * so on, by construction. CustomEvent on the window, the wolfpack:chat-renamed
 * pattern: writers and readers live in different component subtrees
 * (portaled dialogs included), and the app already speaks this dialect.
 *
 * The event carries the section name so ONE event serves all sections —
 * readers filter on what they actually read.
 */

export const SETTINGS_SAVED_EVENT = "wolfpack:settings-saved";

/** The settings sections a writer can land (the write seam's union). */
// "keys" joined the roster (zero-keys wave, 2026-09-25): keys-section
// dispatches it after save AND delete — deletions used to be invisible to
// the zero-keys pill and the setup dialog's auto-advance.
export type SettingsSection = "keys" | "models" | "appearance" | "graph";

/** Writers call this after the PUT resolves ok — never before (a failed
 *  write notifies nothing; the record is unchanged). */
export function notifySettingsSaved(section: SettingsSection): void {
	window.dispatchEvent(
		new CustomEvent(SETTINGS_SAVED_EVENT, { detail: { section } }),
	);
}

/** Non-hook listener (imperative seams, tests). Returns an unsubscribe. */
export function onSettingsSaved(handler: (section: SettingsSection) => void): () => void {
	const listener = (e: Event) => {
		const section = (e as CustomEvent<{ section?: SettingsSection }>).detail?.section;
		if (section !== undefined) handler(section);
	};
	window.addEventListener(SETTINGS_SAVED_EVENT, listener);
	return () => window.removeEventListener(SETTINGS_SAVED_EVENT, listener);
}

