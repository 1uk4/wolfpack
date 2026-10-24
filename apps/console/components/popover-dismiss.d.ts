import { type RefObject } from "react";
/**
 * Close-on-dismissal for floating panels (graph chrome, 2026-09-17):
 * any pointerdown landing OUTSIDE the control's root closes it; Escape
 * closes it too. The root contains both the toggle button and the panel,
 * so clicks on the control's own button stay "inside" — its toggle keeps
 * working — while a click on a sibling chrome button counts as outside:
 * pointerdown closes the open panel first, then the sibling's click opens
 * its own. Two dropdowns can therefore never be open at once.
 */
export declare function usePopoverDismiss(rootRef: RefObject<HTMLElement | null>, open: boolean, close: () => void): void;
//# sourceMappingURL=popover-dismiss.d.ts.map