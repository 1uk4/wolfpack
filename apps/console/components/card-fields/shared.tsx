"use client";

import type { InputHTMLAttributes, Ref } from "react";
import { InlineMic } from "@/components/dictation";
import { cn } from "@/lib/utils";
import type { CardFieldAnswer } from "@wolfpack/client";

/** Props spread onto a text input that is a dictation target. */
export type FieldDictation = { onFocus: () => void; onKeyDown: (e: React.KeyboardEvent) => void; mic: { targetKey: string; onClaim: () => void } };


/** One option row: the whole button (indicator + label) is the click target. */
// Confirm rows add "w-auto": cn() (tailwind-merge) lets the later w-auto replace this w-full.
export const OPTION_ROW = "flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * The 20px choice indicator of an option row: a rounded square with a check (multi) or a circle with a dot (single,
 * confirm). Unselected it is a 2px foreground-tinted outline (readable on light and dark), selected it fills with the
 * primary colour. Decorative: the row's aria-pressed carries the state.
 */
export function Indicator({ shape, on }: { shape: "check" | "radio"; on: boolean }) {
	return (
		<span
			aria-hidden
			data-testid="card-indicator"
			data-on={on || undefined}
			className={cn(
				"mt-px flex size-5 shrink-0 items-center justify-center border-2 transition-colors",
				shape === "check" ? "rounded-md" : "rounded-full",
				on ? "border-primary bg-primary text-primary-foreground" : "border-foreground/50 bg-background",
			)}
		>
			{on &&
				(shape === "check" ? (
					<svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
						<path d="M3.5 8.5l3 3 6-7" />
					</svg>
				) : (
					<span className="size-2 rounded-full bg-current" />
				))}
		</span>
	);
}

export const otherText = (v: CardFieldAnswer | undefined): string | undefined => (v !== undefined && "other" in v && v.other === true ? String(v.value) : undefined);
export const isOther = (v: CardFieldAnswer | undefined): boolean => otherText(v) !== undefined;


/**
 * The one text entry of the card (free text, single Other, multi Other). Dictation can wire in here once: it only needs
 * the value, the change callback, Enter, and the element ref.
 */
export function CardTextInput({
	value,
	onChange,
	onEnter,
	inputRef,
	multiline,
	testId,
	className,
	onKeyDown,
	mic,
	...rest
}: {
	value: string;
	onChange: (text: string) => void;
	onEnter?: () => void;
	inputRef?: Ref<HTMLInputElement & HTMLTextAreaElement>;
	multiline?: boolean;
	testId: string;
	className?: string;
	/** Inline dictation mic at the field's trailing edge (see InlineMic). */
	mic?: { targetKey: string; onClaim: () => void };
} & Omit<InputHTMLAttributes<HTMLInputElement | HTMLTextAreaElement>, "value" | "onChange" | "className" | "ref">) {
	// Extra props (placeholder, onFocus, data-*, …) are spread so callers such as dictation can attach to the field.
	const common = {
		...rest,
		"data-testid": testId,
		className: cn("rounded-lg border bg-background text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", className),
		value,
		ref: inputRef,
		onChange: (e: { target: { value: string } }) => onChange(e.target.value),
	};
	const field = multiline ? (
		// pr-10 on textareas (mic at right-4, clear of the scrollbar); pr-9 on inputs (mic at right-1.5, no scrollbar).
		<textarea {...(common as object)} className={cn(common.className, mic && "pr-10")} onKeyDown={onKeyDown} />
	) : (
		<input
			type="text"
			{...(common as object)}
			className={cn(common.className, mic && "w-full pr-9")}
			onKeyDown={(e) => {
				onKeyDown?.(e);
				if (e.key === "Enter" && onEnter && !e.defaultPrevented) {
					e.preventDefault();
					onEnter();
				}
			}}
		/>
	);
	if (!mic) return field;
	return (
		<div className={cn("relative", !multiline && "min-w-0 flex-1")}>
			{field}
			<InlineMic {...mic} className={cn("absolute", !multiline && "right-1.5", multiline ? "right-4 top-1.5" : "top-1/2 -translate-y-1/2")} />
		</div>
	);
}
