import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
/**
 * The styled tooltip (tooltip wave → subtlety round, owner 2026-09-25):
 * a quiet dark chip, not a white slab — accent tone (the hover-chip color),
 * 11px, minimal padding, no arrow (nothing purely decorative). Opens after
 * a 500ms rest, so tooltips appear when you pause on a control, never in
 * passing; disableHoverableContent means the chip is un-hoverable — the
 * instant the cursor leaves the trigger it's gone, even mid-move onto the
 * chip's own pixels.
 */
/** The rest delay (ms): shared by hover and focus opens. */
export declare const TOOLTIP_DELAY_MS = 500;
declare function TooltipProvider({ delayDuration, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>): any;
declare function Tooltip({ disableHoverableContent, ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>): any;
declare function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>): any;
declare function TooltipContent({ className, sideOffset, children, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>): any;
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
//# sourceMappingURL=tooltip.d.ts.map