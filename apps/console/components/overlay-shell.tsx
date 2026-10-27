"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const FOCUSABLE = 'button, a[href], textarea, input, select, summary, [tabindex="0"]';

/** Focusable and reachable: not disabled, and not hidden inside a closed <details> (its summary stays reachable). */
const reachable = (el: HTMLElement): boolean => {
	if ((el as HTMLButtonElement).disabled) return false;
	const d = el.closest("details");
	return !d || d.open || (el.tagName === "SUMMARY" && el.parentElement === d);
};

/**
 * The full-screen overlay both the task graph and the subagent modal use: an opaque bg-background page with p-4, a
 * header row (the caller's `header`, then the close button), and the body below. It owns Esc (the one-Esc law), the
 * Tab focus trap, focus restored to the opener on close, the page's scroll locked behind, and aria-modal.
 * `header` (or `children` as a function) gets the close button so a caller can place it after its own controls.
 */
export function OverlayShell({
	label,
	labelledBy,
	testId,
	closeTestId,
	onClose,
	header,
	children,
}: {
	/** aria-label, when there is no visible title element to point at. */
	label?: string;
	/** id of the visible title element (aria-labelledby). */
	labelledBy?: string;
	testId: string;
	closeTestId: string;
	onClose: () => void;
	/** The header row, given the close button. Omit when the body draws its own header (children as a function). */
	header?: (close: ReactNode) => ReactNode;
	children: ReactNode | ((close: ReactNode) => ReactNode);
}) {
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		const opener = document.activeElement as HTMLElement | null;
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		closeRef.current?.focus();
		return () => {
			document.body.style.overflow = prevOverflow;
			if (opener?.isConnected) opener.focus?.();
		};
	}, []);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// THE ONE-ESC LAW: claim at the document level, the window chain must not also act.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			} else if (e.key === "Tab") {
				const els = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(reachable);
				if (els.length === 0) return;
				const first = els[0]!;
				const last = els[els.length - 1]!;
				const active = document.activeElement;
				if (!dialogRef.current?.contains(active)) {
					e.preventDefault();
					first.focus();
				} else if (e.shiftKey && active === first) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && active === last) {
					e.preventDefault();
					first.focus();
				}
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	const close = (
		<Button ref={closeRef} size="icon-xs" variant="ghost" className="ml-auto" aria-label="Close" data-testid={closeTestId} onClick={onClose}>
			<XIcon />
		</Button>
	);
	return (
		<div
			ref={dialogRef}
			className="fixed inset-0 z-50 flex flex-col bg-background p-4"
			role="dialog"
			aria-modal="true"
			aria-label={labelledBy ? undefined : label}
			aria-labelledby={labelledBy}
			data-testid={testId}
		>
			{header?.(close)}
			{typeof children === "function" ? children(close) : children}
		</div>
	);
}
