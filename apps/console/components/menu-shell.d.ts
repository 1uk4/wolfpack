import { type ReactNode, type RefObject } from "react";
/** A MenuShell mounted = a dropdown open (fix wave, owner ruling:
 *  the settings dialog's content column locks while any menu is down —
 *  no scrolling under a dropdown). The shell stays placement-only: it
 *  just ANNOUNCES, surfaces decide what to do with the fact (the
 *  settings dialog locks; anything un-lockable keeps the re-place-on-
 *  scroll fallback below). Count-based: overlapping menus open/close in
 *  any order and the accounting stays balanced. */
export declare const MENU_OPEN_EVENT = "lh:menu-open";
export declare const MENU_CLOSE_EVENT = "lh:menu-close";
export type MenuSide = "up" | "down";
export type MenuAlign = "left" | "right";
/** One placement decision. `style` is the fixed-position payload; the side
 *  rides back for the flip assertion in tests. */
export interface MenuPlacement {
    side: MenuSide;
    style: Record<string, string | number>;
    maxHeight: number;
}
/** Pure: the placement decision — anchored rect + viewport + the menu's
 *  UNCAPPED content height (scrollHeight, so re-placements after a search
 *  filter re-measure honestly) → side, fixed style, cap. Flip rule: stay
 *  on the preferred side unless it cannot show the full content AND the
 *  other side is roomier. The cap always keeps the menu inside its side's
 *  room when there is room; the floor keeps it usable when there isn't. */
export declare function computeMenuPlacement(rect: {
    top: number;
    bottom: number;
    left: number;
    right: number;
}, viewport: {
    width: number;
    height: number;
}, contentHeight: number, preferredSide: MenuSide, align: MenuAlign): MenuPlacement;
/** The shared shell. Exactly one anchor seam: pass `anchorRef` (a live
 *  element ref) or `anchorTestid` (the settings section's pattern — the
 *  trigger is queried by testid at place time). */
export declare function MenuShell({ anchorRef, anchorTestid, testid, preferredSide, align, menuClass, children, }: {
    anchorRef?: RefObject<HTMLElement | null>;
    anchorTestid?: string;
    /** The menu body's own testid (sites assert it). */
    testid: string;
    /** Which way the menu opens from the anchor when both sides fit. */
    preferredSide: MenuSide;
    /** Which anchor edge the menu's horizontal position keys off. */
    align?: MenuAlign;
    /** The menu body classes: width, border, bg, padding, text — the
     *  shell adds position, z-index, the height cap, and scrolling. */
    menuClass: string;
    children: ReactNode;
}): any;
//# sourceMappingURL=menu-shell.d.ts.map