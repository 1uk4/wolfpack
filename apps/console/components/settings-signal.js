"use client";
/**
 * THE cross-surface settings signal (fix wave, owner ruling 2026-09-22):
 * every WRITER dispatches after a successful PUT, every READER re-reads —
 * the composer reflects the strong slot the instant setup saves, the
 * settings section reflects the composer's pick on its next mount... and
 * so on, by construction. CustomEvent on the window, the lh:chat-renamed
 * pattern: writers and readers live in different component subtrees
 * (portaled dialogs included), and the app already speaks this dialect.
 *
 * The event carries the section name so ONE event serves all sections —
 * readers filter on what they actually read.
 */
import { useEffect, useRef } from "react";
export const SETTINGS_SAVED_EVENT = "lh:settings-saved";
/** Writers call this after the PUT resolves ok — never before (a failed
 *  write notifies nothing; the record is unchanged). */
export function notifySettingsSaved(section) {
    window.dispatchEvent(new CustomEvent(SETTINGS_SAVED_EVENT, { detail: { section } }));
}
/** Non-hook listener (imperative seams, tests). Returns an unsubscribe. */
export function onSettingsSaved(handler) {
    const listener = (e) => {
        const section = e.detail?.section;
        if (section !== undefined)
            handler(section);
    };
    window.addEventListener(SETTINGS_SAVED_EVENT, listener);
    return () => window.removeEventListener(SETTINGS_SAVED_EVENT, listener);
}
/** Reader subscription: re-invokes whenever a writer lands, with the
 *  handler captured through a ref so callers never churn the
 *  subscription (and never stale-close over it either). */
export function useSettingsSaved(handler) {
    const saved = useRef(handler);
    saved.current = handler;
    useEffect(() => onSettingsSaved((section) => saved.current(section)), []);
}
//# sourceMappingURL=settings-signal.js.map