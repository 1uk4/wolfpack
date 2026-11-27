"use client";

/**
 * The bar's ⋯ button for a narrow column: the secondary controls (gear, shrink, eye, swap) move into a small macOS-style popover above
 * the bar, so the chip and send keep their room. The caller passes the controls as children; Esc or a press outside closes it and hands
 * focus back to the button.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { ZC } from "@/lib/z-layers";

export function BarOverflow({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement | null>(null);
	const button = useRef<HTMLButtonElement | null>(null);
	const close = useCallback(() => {
		setOpen(false);
		button.current?.focus();
	}, []);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: Event) => {
			if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			e.preventDefault();
			close();
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, close]);

	return (
		<div ref={box} className="relative">
			<Hint label="More">
				<button
					ref={button}
					type="button"
					data-testid="chat-bar-overflow"
					aria-label="More chat controls"
					aria-haspopup="menu"
					aria-expanded={open}
					onClick={() => (open ? close() : setOpen(true))}
					className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
				>
					<EllipsisIcon aria-hidden className="size-4" />
				</button>
			</Hint>
			{open && (
				<div
					role="menu"
					data-testid="chat-bar-overflow-menu"
					className={`absolute bottom-full right-0 ${ZC.menu} mb-2 flex items-center gap-0.5 rounded-xl border bg-popover/95 p-1 shadow-lg backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150`}
				>
					{children}
				</div>
			)}
		</div>
	);
}
