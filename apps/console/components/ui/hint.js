"use client";
import * as React from "react";
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { bindingForAction, formatBinding } from "@/src/core";
/** The composition itself, pure — "Dictate" + ⌘D → "Dictate (⌘D)". Exported
 *  for the mechanism pins (tests/tooltip-mechanism.test.tsx). */
export function hintText(label, action, binding) {
    const live = action
        ? formatBinding(bindingForAction(action))
        : binding
            ? formatBinding(binding)
            : "";
    return live ? `${label} (${live})` : label;
}
export function Hint({ label, action, binding, side = "top", children }) {
    return (<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>{children}</TooltipTrigger>
				<TooltipContent side={side}>{hintText(label, action, binding)}</TooltipContent>
			</Tooltip>
		</TooltipProvider>);
}
//# sourceMappingURL=hint.js.map