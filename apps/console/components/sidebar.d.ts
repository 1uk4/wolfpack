import type { ChatListItem } from "@/src/core";
declare global {
    interface Window {
        /** Preload bridge (electron/preload.cjs) — Electron only, absent in the browser. */
        lh?: {
            /** Read-only host OS; determines the native-control gutter. */
            platform?: string;
            expandWindow: () => void;
            /** The zoom truth (owner round 7): subscribes to "lh:zoom" pushes; returns unsubscribe. */
            onZoom?: (cb: (factor: number) => void) => () => void;
            getZoom?: () => Promise<number>;
            /** Auto-update channel (Wave C, 2026-10-10): "lh:update-status" pushes once a staged update exists. */
            onUpdateStatus?: (cb: (status: {
                status: string;
                version: string | null;
            }) => void) => () => void;
            installUpdate?: () => void;
        };
    }
}
export declare function useSidebar(): any;
export declare function SidebarProvider({ children }: {
    children: React.ReactNode;
}): any;
/** Hamburger for page headers — only visible when the sidebar is closed.
 *
 *  Owner, round 6c: the toggle is ALWAYS MOUNTED, owning a slot whose
 *  width+margin animate in LOCKSTEP with the sidebar's own width
 *  transition (same duration-200, same easing, both gated on mount) —
 *  before, it mounted/unmounted in one frame, so its 48px footprint
 *  (button + gap) popped and dragged the title and chips sideways while
 *  the sidebar was still mid-slide. When open the slot is exactly zero
 *  (w-0 -mr-3: width 0, the negative margin cancels the header's gap-3),
 *  so resting layouts are pixel-identical to the old conditional render.
 *  The icon fades with the slot and is clipped by it as it collapses —
 *  no popping in either direction. */
export declare function SidebarToggle(): any;
/** Compact "how long ago": "just now", "5m ago", "3h ago", "2d ago",
 *  then a plain date. How long a session has been WAITING matters more
 *  than an absolute timestamp. Beyond a week the date renders ISO
 *  (YYYY-MM-DD, zero-padded) — the international standard: unambiguous
 *  in any locale and it sorts (owner, typography round 5; the old
 *  M/D/YYYY was the US convention. A user-locale setting can come later
 *  — trivial, a format function swap). Pure — exported for tests. */
export declare function timeAgo(iso: string, now?: Date): string;
/**
 * One session row: the status spinner (only while working), then title +
 * state-aware meta. Exported for render tests — pure function of the
 * list item.
 */
export declare function SessionRow({ chat, active, onOpen, kbdSelected, onContextMenu, }: {
    chat: ChatListItem;
    active: boolean;
    onOpen: () => void;
    /** Keyboard-cycle highlight (shortcut wave A: Alt+↑/↓ + Alt+Enter) —
     *  visually distinct from the active session, which stays filled. */
    kbdSelected?: boolean;
    /** Right-click opens the context menu (wave 6: Rename / Delete). */
    onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}): any;
/** The inline-rename row (wave 6): same geometry as SessionRow, but the
 *  title line becomes a text input — select-all on entry (the click means
 *  "replace", the header rename's rule), Enter/blur commits, Esc discards.
 *  The meta line stays so the row never changes height mid-edit. */
export declare function RenameRow({ chat, onCommit, onCancel }: {
    chat: ChatListItem;
    onCommit: (next: string) => void;
    onCancel: () => void;
}): any;
/** The three-way kind filter (practice sessions, owner 2026-10-04):
 *  Teaching / All / Practice — a client-side filter over the same
 *  snapshot, persisted in localStorage, defaulting to All. */
export type SessionKindFilter = "teach" | "all" | "practice";
/** The app frame: sidebar inline + content. Rendered once in the root layout. */
export declare function AppShell({ children }: {
    children: React.ReactNode;
}): any;
//# sourceMappingURL=sidebar.d.ts.map