"use client"

import * as React from "react"
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { createLongPress } from "@/components/ui/long-press"
import { bindingForAction, formatBinding, type KeyAction } from "@/src/core"

/**
 * The tooltip composition for icon and pill controls (tooltip wave, owner
 * 2026-09-25; subtlety round same day). The styled Radix tooltip carries
 * the label, with the control's shortcut appended in parentheses when
 * it has one ("Dictate (⌘D)") — the owner call: the em-dash suffix read
 * as too much air.
 *
 * The binding is override-aware: pass `action` for registry shortcuts (a
 * user rebind in Pack → This device → Keyboard changes the suffix live), or
 * `binding` for surface-owned keys with no registry entry ("escape" for a
 * dialog close, "enter" for a form submit).
 *
 * children must be a single element able to take a ref (TooltipTrigger
 * asChild merges onto it — no wrapper DOM, no layout shift).
 */

interface HintProps {
	label: string
	/** Registry action whose LIVE binding is shown (override-aware). */
	action?: KeyAction
	/** Surface-owned binding ("escape", "enter") — keys the registry
	 *  deliberately doesn't dispatch (Esc closes the dialog itself; Enter
	 *  submits the form the button belongs to). */
	binding?: string
	side?: "top" | "bottom" | "left" | "right"
	/** The child holds selectable text (an input): skip the touch no-select/no-callout class. */
	selectable?: boolean
	children: React.ReactElement
}

/** The composition itself, pure — "Dictate" + ⌘D → "Dictate (⌘D)". Exported
 *  for the mechanism pins (tests/core/ui/tooltip-mechanism.test.tsx). */
export function hintText(label: string, action?: KeyAction, binding?: string): string {
	const live = action
		? formatBinding(bindingForAction(action))
		: binding
			? formatBinding(binding)
			: ""
	return live ? `${label} (${live})` : label
}

export function Hint({ label, action, binding, side = "top", selectable = false, children }: HintProps) {
	// Controlled so a phone long-press (Radix ignores touch) can open it; hover and focus still go through onOpenChange.
	const [open, setOpen] = React.useState(false)
	const press = React.useMemo(() => createLongPress(() => setOpen(true), () => setOpen(false)), [])
	React.useEffect(() => press.dispose, [press])
	// Radix closes a tooltip on pointerleave, which a touch fires right after the finger lifts; the long-press tip is closed only by its
	// own timer or a press outside.
	React.useEffect(() => {
		if (!open) return
		const outside = () => press.dismiss()
		document.addEventListener("pointerdown", outside, true)
		return () => document.removeEventListener("pointerdown", outside, true)
	}, [open, press])
	return (
		<TooltipProvider>
			<Tooltip open={open} onOpenChange={(next) => {
				if (!next && press.showing()) return
				setOpen(next)
			}}>
				<TooltipTrigger
					asChild
					// iOS has no contextmenu on long-press: suppress its callout and text selection (touch devices only).
					className={selectable ? undefined : "[@media(pointer:coarse)]:[-webkit-touch-callout:none] [@media(pointer:coarse)]:select-none"}
					onPointerDown={(e) => press.down(e)}
					onPointerMove={(e) => press.move(e)}
					onPointerUp={press.end}
					onPointerCancel={press.end}
					// The click that ends the long-press which opened the tip must not also fire the control.
					onClickCapture={(e) => {
						if (press.swallowClick()) {
							e.preventDefault()
							e.stopPropagation()
						}
					}}
					// The OS long-press menu would cover the tip.
					onContextMenu={(e) => {
						if ((e.nativeEvent as PointerEvent).pointerType === "touch") e.preventDefault()
					}}
				>
					{children}
				</TooltipTrigger>
				<TooltipContent side={side}>{hintText(label, action, binding)}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	)
}
