/**
 * Keyboard shortcuts (shortcut wave, 2026-09-17) — the single source of truth
 * for every app action that has a binding. This module is PURE (no React, no
 * window access at module scope beyond the guarded helpers) so it can render
 * a cheat sheet, match events, and — at the settings milestone — drive a
 * user-editable key map without touching any component.
 *
 * Design (owner-approved plan):
 * - Tab is DEAD: browser tab-focus navigation is abandoned entirely. Tab
 *   does nothing; Shift+Tab alone cycles the thinking level.
 * - Esc is a layered dismiss: topmost popover (each popover stopPropagation's
 *   its own Esc) → dictation stop → abort in-flight turn.
 * - The key map persists overrides in localStorage (`lh:keymap`, overrides
 *   only) merged over DEFAULT_BINDINGS — the settings wave adds the editor.
 *
 * Binding strings are normalized, cross-platform:
 *   "mod+d"    — mod = ⌘ on macOS, Ctrl elsewhere (both are accepted live)
 *   "shift+tab", "alt+arrowdown", "mod+shift+f", "?", "f2", "escape"
 * Order is fixed: mod, alt, shift, then the key.
 */
export type KeyAction = "toggle-dictation" | "open-model-picker" | "cycle-thinking" | "toggle-sidebar" | "sessions-search" | "jump-graph" | "new-session" | "rename-session" | "cheat-sheet" | "find" | "question-focus" | "question-next-row" | "question-prev-row" | "question-pick-row" | "question-submit" | "open-settings" | "toggle-user-thinking";
/** Where the cheat sheet groups an action (display only — dispatch is
 *  global; a seam that isn't mounted simply no-ops). */
export type KeyScope = "global" | "chat" | "graph";
export interface KeyActionDef {
    id: KeyAction;
    /** Cheat-sheet label. */
    label: string;
    scope: KeyScope;
    binding: string;
    /** Display-only (cheat sheet) — contextual keys a SURFACE owns (the
     *  question dock's row machine); never dispatched from the registry,
     *  so they can't leak to pages where the surface isn't mounted. */
    displayOnly?: boolean;
}
export declare const KEYBOARD_ACTIONS: readonly KeyActionDef[];
/** localStorage overrides ({actionId: binding}) — read once per module
 *  instance; the settings editor will write this key. Guarded: SSR and a
 *  corrupt/absent store both fall back to defaults. */
export declare function loadOverrides(): Partial<Record<KeyAction, string>>;
/** Write the full overrides map ({actionId: binding}) — the settings
 *  editor's rebind/reset persistence. Guarded: SSR no-ops. An empty
 *  map clears the store entirely (all-defaults). */
export declare function saveOverrides(overrides: Partial<Record<KeyAction, string>>): void;
/** The live key map: defaults with user overrides applied. */
export declare function effectiveKeymap(): Map<string, KeyAction>;
/** Which action a normalized binding fires, if any (override-aware). */
export declare function actionForBinding(binding: string): KeyAction | undefined;
/** The effective (override-aware) binding for one action — display use. */
export declare function bindingForAction(id: KeyAction): string;
/**
 * Normalize a KeyboardEvent to a canonical binding string. Rules:
 * - mod matches BOTH meta (⌘) and ctrl — Ctrl+K works on a Mac keyboard too.
 * - a printable key ("?") bakes its shift in: "shift+/?" collapses to "?".
 */
export declare function eventBinding(e: KeyboardEvent): string;
/** The window event name a registry action dispatches/answers on —
 *  the ONE spelling shared by the dispatcher (keyboard-shortcuts) and
 *  every surface listener. Born from the ⌘B bug (owner interlude
 *  2026-09-25): the sidebar listened on the pre-convention name
 *  "lh:toggle-sidebar" while the dispatcher sent "lh:kbd-toggle-sidebar",
 *  so ⌘B silently did nothing. With both sides composing through this
 *  helper the mismatch is structurally impossible.
 */
export declare function kbdEventForAction(action: KeyAction): string;
/** True when the event lands in a typing surface (input, textarea, or a
 *  contentEditable). In one, only mod/alt combos (and Tab, which types
 *  nothing) may fire — bare keys belong to the field (typing, caret). */
export declare function isTypingSurface(e: KeyboardEvent): boolean;
/** macOS styling for binding display ("⌘D", "⇧⇥", "⌥↑"). */
export declare const IS_MAC: boolean;
/** Format a binding for display: "mod+shift+f" → "⌘⇧F". */
export declare function formatBinding(binding: string): string;
//# sourceMappingURL=keyboard.d.ts.map