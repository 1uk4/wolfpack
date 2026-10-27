"use client";

import { useCallback, useEffect, useId, useRef, useState, type InputHTMLAttributes, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { addCustomEntry, draftAnswers, draftComplete, fieldsComplete, foldPendingOther, initialDraft, multiInBounds, visibleFields, visibleSteps, type CardDraft } from "@/src/core";
import type { CardField, CardFieldAnswer } from "@wolfpack/client";
import type { InteractionCardProps } from "@/components/card-registry";

/**
 * The inline interaction card of a wolf thread (the wolf asked a question): free-text, single-choice, multi-choice (checkboxes) and confirm (yes/no) fields.
 * Visuals follow the legacy question dock (question-dock.tsx) and its answered record (answered-card.tsx): a bordered
 * card, "Question" kicker, markdown question, option rows with an Other entry. Pending it is a form; answered it is the
 * static record. Defaults only pre-select; nothing submits until the operator presses Submit.
 */
export function AskCard({ card, answer, dismissed, heldAnswer, pending, submitting, onAnswer }: InteractionCardProps) {
	const [draft, setDraft] = useState<CardDraft>(() => initialDraft(card, heldAnswer));
	const [stepIdx, setStepIdx] = useState(0);
	const rootRef = useRef<HTMLDivElement | null>(null);
	// Ref mirrors of the draft and the typed Other text: a dictation flush (or a submit resuming after finishDictation)
	// must read the tail, which has not rendered yet.
	const draftRef = useRef(draft);
	const set = (fieldId: string, a: CardFieldAnswer) => {
		draftRef.current = { ...draftRef.current, [fieldId]: a };
		setDraft(draftRef.current);
	};
	const answered = answer !== undefined;
	const closed = answered || dismissed === true;
	// Text typed into a multi "Other…" box but not yet added still counts on Submit (folded in, never lost).
	const [typed, setTyped] = useState<Record<string, string>>({});
	const typedRef = useRef(typed);
	const setTypedText = (fieldId: string, text: string) => {
		typedRef.current = { ...typedRef.current, [fieldId]: text };
		setTyped(typedRef.current);
	};
	const liveRef = useRef(false);
	liveRef.current = pending && !closed;
	// The fields in play now (hidden ones and other steps' fields never take dictation).
	const inPlay = closed ? [] : shownIds(card, draft, stepIdx);
	const { claimed, dictationProps } = useCardDictation(card, draftRef, set, typedRef, setTypedText, pending && !closed, inPlay);
	// Submit finishes a live dictation first, then reads the mirrors. `finishing` blocks re-entry (and disables Submit)
	// while the finish is pending; afterwards the card is re-checked (liveRef) so one answered/skipped meanwhile is not answered again.
	const [finishing, setFinishing] = useState(false);
	const finishingRef = useRef(false);
	// Recomputed from the mirrors at call time (after a dictation finish the render state is stale): an invalid or
	// incomplete result aborts the submit and leaves the typed text with its inline error.
	const answerNow = () => {
		const f = foldPendingOther(card, draftRef.current, typedRef.current);
		if (Object.keys(f.errors).length > 0 || !draftComplete(card, f.draft)) return;
		onAnswer(draftAnswers(card, f.draft));
	};
	const submit = () => {
		if (finishingRef.current) return;
		if (!isDictationActive()) return answerNow();
		finishingRef.current = true;
		setFinishing(true);
		void finishDictation().then(() => {
			finishingRef.current = false;
			setFinishing(false);
			if (liveRef.current) answerNow();
		});
	};
	const folded = foldPendingOther(card, draft, typed);
	const canSubmit = pending && !submitting && Object.keys(folded.errors).length === 0 && draftComplete(card, folded.draft);
	// Stepped card: one step at a time with Back/Next; the answers stay in the draft until the single Submit on the last step.
	// The step list follows the draft (a dependent step appears/vanishes with its controlling answer); `step` is clamped.
	const stepped = card.steps !== undefined && !closed;
	const steps = visibleSteps(card, folded.draft);
	const step = Math.min(stepIdx, steps.length - 1);
	const lastStep = step >= steps.length - 1;
	const stepOk = Object.keys(folded.errors).length === 0 && fieldsComplete(steps[step]?.fields ?? [], folded.draft);
	// Moving between steps finishes any live dictation (its text belongs to the step it was said on), drops the claim, and
	// puts focus on the new step's first control.
	// The step changes only after the flush (as Submit does), so a dictation tail lands in the field it was said in.
	const focusStep = useRef(false);
	const goTo = (n: number) => {
		void finishDictation().then(() => {
			if (!liveRef.current) return;
			dictationProps.release();
			focusStep.current = true;
			setStepIdx(n);
		});
	};
	useEffect(() => {
		if (!focusStep.current) return; // only a Back/Next/Enter move focuses, not the step list shrinking
		focusStep.current = false;
		(rootRef.current?.querySelector("[data-field] textarea, [data-field] input, [data-field] button") as HTMLElement | null)?.focus?.();
	}, [step]);
	const shownFields = closed ? visibleFields(card, answered ? answer : draft) : stepped ? (steps[step]?.fields ?? []) : visibleFields(card, folded.draft);

	return (
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground"
			data-testid={dismissed ? "dismissed-card" : answered ? "answered-card" : "pending-card"}
			data-card-tool={card.tool}
			data-dictation-claimed={claimed || undefined}
			{...dictationProps.root}
			ref={(el) => {
				rootRef.current = el;
				(dictationProps.root.ref as { current: HTMLDivElement | null }).current = el;
			}}
			onKeyDown={(e) => {
				// Enter in a single-line input advances a stepped card (the multi "Other" box claims its own Enter).
				const t = e.target as HTMLElement;
				if (e.key === "Enter" && !e.defaultPrevented && stepped && !lastStep && stepOk && t.tagName === "INPUT" && (!(t as HTMLInputElement).type || (t as HTMLInputElement).type === "text")) {
					e.preventDefault();
					goTo(step + 1);
				}
			}}
		>
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{card.title ?? "Question"}
				{dismissed && <span className="ml-2 rounded bg-muted px-1.5 py-0.5">skipped</span>}
				{!closed && !pending && <span className="ml-2 rounded bg-muted px-1.5 py-0.5">waiting</span>}
				{!closed && heldAnswer && <span data-testid="card-held" className="ml-2 rounded bg-muted px-1.5 py-0.5">answer saved · waiting for the other questions</span>}
			</div>
			{stepped && steps.length > 1 && (
				<div className="mb-2 text-xs text-muted-foreground" data-testid="card-step-indicator" aria-live="polite">
					Step {step + 1} of {steps.length}
					{steps[step]?.title ? ` · ${steps[step]?.title}` : ""}
				</div>
			)}
			{shownFields.map((f) => (
				<FieldView
					key={f.id}
					field={f}
					value={answered ? answer[f.id] : draft[f.id]}
					readOnly={closed || !pending || submitting}
					onChange={(a) => set(f.id, a)}
					typed={typed[f.id] ?? ""}
					onType={(text) => setTypedText(f.id, text)}
					dictation={dictationProps.field(f.id)}
					pendingError={folded.errors[f.id]}
				/>
			))}
			{!closed && (
				<div className="mt-3 flex justify-end gap-2">
					{stepped && step > 0 && (
						<Button type="button" size="sm" variant="outline" disabled={submitting} onClick={() => goTo(step - 1)} data-testid="card-back">
							Back
						</Button>
					)}
					{stepped && !lastStep ? (
						<Button type="button" size="sm" disabled={!pending || submitting || !stepOk} onClick={() => goTo(step + 1)} data-testid="card-next">
							Next
						</Button>
					) : (
						<Button type="button" size="sm" disabled={!canSubmit || finishing} onClick={submit} data-testid="card-submit">
							{submitting ? "Sending…" : heldAnswer ? "Update answer" : "Submit"}
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

/** Ids of the fields currently shown: the visible ones, on the current step when the card is stepped. */
function shownIds(card: InteractionCardProps["card"], draft: CardDraft, stepIdx: number): string[] {
	if (!card.steps) return visibleFields(card, draft).map((f) => f.id);
	const steps = visibleSteps(card, draft);
	return (steps[Math.min(stepIdx, steps.length - 1)]?.fields ?? []).map((f) => f.id);
}

/** Props spread onto a text input that is a dictation target. */
type FieldDictation = { onFocus: () => void; onKeyDown: (e: React.KeyboardEvent) => void };

/** Esc in a card field cancels a live dictation (the hook listens for this event; the Esc is claimed). */
function stopDictationOnEscape(e: React.KeyboardEvent) {
	if (e.key !== "Escape" || !isDictationActive()) return;
	e.preventDefault();
	e.stopPropagation();
	window.dispatchEvent(new CustomEvent("lh:kbd-cancel-dictation"));
}

/**
 * Card-field dictation, kept in one place: the text field focused last (free-text, single Other, multi Other) claims
 * dictated speech (like the question dock's fields); focus landing on a text input outside the card (the composer)
 * hands it back. Text inputs spread `dictationProps.field(id)`; the card root spreads `dictationProps.root`. Option
 * buttons and Submit do NOT release the claim (only focus on a text input outside the card does): after picking an
 * option the last text field still takes dictation, as in the question dock. Multi Other dictates into the pending
 * `typed` text (folded on Submit); confirm has no text field.
 */
function useCardDictation(
	card: InteractionCardProps["card"],
	draftRef: { current: CardDraft },
	set: (fieldId: string, a: CardFieldAnswer) => void,
	typedRef: { current: Record<string, string> },
	setTypedText: (fieldId: string, text: string) => void,
	live: boolean,
	inPlay: string[],
) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [dictField, setDictField] = useState<string | null>(null);
	// The targeted field became hidden (or left the step): the claim goes with it.
	const inPlayKey = inPlay.join("\0");
	useEffect(() => {
		if (dictField !== null && !inPlay.includes(dictField)) setDictField(null);
	}, [inPlayKey, dictField]);
	useEffect(() => {
		if (dictField === null) return;
		const onFocusIn = (e: FocusEvent) => {
			const el = e.target as HTMLElement | null;
			if (el && !rootRef.current?.contains(el) && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) setDictField(null);
		};
		document.addEventListener("focusin", onFocusIn);
		return () => document.removeEventListener("focusin", onFocusIn);
	}, [dictField]);
	const append = useCallback(
		(t: string) => {
			const f = card.fields.find((x) => x.id === dictField);
			if (!f || !inPlay.includes(f.id)) return;
			const cur = draftRef.current[f.id];
			if (f.kind === "free-text") set(f.id, { value: joinDictation(typeof cur?.value === "string" ? cur.value : "", t) });
			else if (f.kind === "single") set(f.id, { value: joinDictation(otherText(cur) ?? "", t), other: true });
			else if (f.kind === "multi") setTypedText(f.id, joinDictation(typedRef.current[f.id] ?? "", t));
		},
		// Deps are ref-backed: draftRef/typedRef are stable and `set`/`setTypedText` only write refs + state.
		[card, dictField, inPlayKey],
	);
	const claimed = live && dictField !== null;
	useDictationTarget(append, claimed);
	return {
		claimed,
		dictationProps: {
			root: { ref: rootRef },
			field: (id: string): FieldDictation => ({ onFocus: () => setDictField(id), onKeyDown: stopDictationOnEscape }),
			release: () => setDictField(null),
		},
	};
}

function FieldView({
	field,
	value,
	readOnly,
	onChange,
	typed,
	onType,
	pendingError,
	dictation,
}: {
	field: CardField;
	value: CardFieldAnswer | undefined;
	readOnly: boolean;
	onChange: (a: CardFieldAnswer) => void;
	typed: string;
	onType: (text: string) => void;
	pendingError?: string;
	dictation: FieldDictation;
}) {
	const labelId = `card-field-${useId()}`;
	return (
		<div className="mb-2 last:mb-0" data-field={field.id}>
			<div className="mb-2 flex flex-wrap items-baseline gap-x-2 font-medium" id={labelId}>
				<MessageResponse>{field.label}</MessageResponse>
				{field.optional && (
					<span className="text-xs font-normal text-muted-foreground" data-testid="card-optional">
						(optional)
					</span>
				)}
			</div>
			{field.description && (
				<div className="mb-3 text-sm text-muted-foreground">
					<MessageResponse>{field.description}</MessageResponse>
				</div>
			)}
			{field.kind === "confirm" ? (
				<ConfirmView field={field} value={value} readOnly={readOnly} onChange={onChange} labelledBy={labelId} />
			) : field.kind === "multi" ? (
				<MultiView field={field} value={value} readOnly={readOnly} onChange={onChange} labelledBy={labelId} typed={typed} onType={onType} error={pendingError} dictation={dictation} />
			) : field.kind === "free-text" ? (
				readOnly ? (
					<div className="lh-prose whitespace-pre-wrap" data-testid="card-answer-text">
						“{typeof value?.value === "string" ? value.value : ""}”
					</div>
				) : (
					<CardTextInput
						multiline
						testId="card-text"
						className="min-h-20 w-full resize-y px-3 py-2"
						value={typeof value?.value === "string" ? value.value : ""}
						onChange={(text) => onChange({ value: text })}
						placeholder="Your answer…"
						{...dictation}
					/>
				)
			) : (
				<div className="flex flex-col gap-1.5 text-sm" role="group" aria-labelledby={labelId}>
					{field.options.map((o) => {
						const other = value !== undefined && "other" in value && value.other === true;
						const sel = !other && value?.value === o.value;
						return (
							<button
								key={o.value}
								type="button"
								aria-pressed={sel}
								disabled={readOnly}
								data-testid="card-option"
								data-value={o.value}
								onClick={() => onChange({ value: o.value })}
								className={cn(
									OPTION_ROW,
									sel ? "border-primary bg-accent" : "enabled:hover:bg-accent/50",
									readOnly && !sel && "text-muted-foreground",
								)}
							>
								<Indicator shape="radio" on={sel} />
								<span className="flex min-w-0 flex-col items-start">
									<MessageResponse>{o.label}</MessageResponse>
									{o.description && <MessageResponse className="lh-prose block text-xs text-muted-foreground">{o.description}</MessageResponse>}
								</span>
							</button>
						);
					})}
					{field.allowOther !== false &&
						(readOnly ? (
							otherText(value) !== undefined && (
								<div data-testid="answered-other" className="rounded-lg border border-primary bg-accent px-3 py-1.5">
									“{otherText(value)}”
								</div>
							)
						) : (
							<CardTextInput
								testId="card-other"
								className={cn("px-3 py-1.5", isOther(value) && "border-primary bg-accent")}
								placeholder="Other…"
								value={otherText(value) ?? ""}
								onChange={(text) => onChange({ value: text, other: true })}
								{...dictation}
							/>
						))}
				</div>
			)}
		</div>
	);
}

/** One option row: the whole button (indicator + label) is the click target. */
const OPTION_ROW = "flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * The 20px choice indicator of an option row: a rounded square with a check (multi) or a circle with a dot (single,
 * confirm). Unselected it is a 2px foreground-tinted outline (readable on light and dark), selected it fills with the
 * primary colour. Decorative: the row's aria-pressed carries the state.
 */
function Indicator({ shape, on }: { shape: "check" | "radio"; on: boolean }) {
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

const otherText = (v: CardFieldAnswer | undefined): string | undefined => (v !== undefined && "other" in v && v.other === true ? String(v.value) : undefined);
const isOther = (v: CardFieldAnswer | undefined): boolean => otherText(v) !== undefined;

function MultiView({
	field,
	value,
	readOnly,
	onChange,
	labelledBy,
	typed,
	onType,
	error,
	dictation,
}: {
	field: Extract<CardField, { kind: "multi" }>;
	value: CardFieldAnswer | undefined;
	readOnly: boolean;
	onChange: (a: CardFieldAnswer) => void;
	labelledBy: string;
	typed: string;
	onType: (text: string) => void;
	error?: string;
	dictation: FieldDictation;
}) {
	const picked = Array.isArray(value?.value) ? value.value : [];
	const custom = value && "other" in value && Array.isArray(value.other) ? value.other : [];
	const atMax = field.max !== undefined && picked.length >= field.max;
	const write = (next: string[], nextCustom: string[]) => onChange({ value: next, ...(nextCustom.length > 0 ? { other: nextCustom } : {}) });
	const toggle = (v: string) => (picked.includes(v) ? write(picked.filter((p) => p !== v), custom.filter((c) => c !== v)) : write([...picked, v], custom));
	const addCustom = () => {
		const r = addCustomEntry(field, value, typed);
		if ("error" in r) return; // shown live as `error`
		onChange(r.answer);
		onType("");
	};
	const rows = [
		...field.options.map((o) => ({ ...o, custom: false })),
		...custom.filter((c) => picked.includes(c)).map((c) => ({ label: c, value: c, description: undefined, custom: true })),
	];
	const hint = field.min !== undefined || field.max !== undefined ? `Pick ${field.min !== undefined && field.max !== undefined ? `${field.min}–${field.max}` : field.min !== undefined ? `at least ${field.min}` : `up to ${field.max}`}` : null;
	return (
		<div className="flex flex-col gap-1.5 text-sm" role="group" aria-labelledby={labelledBy} data-testid="card-multi">
			{rows.map((o) => {
				const sel = picked.includes(o.value);
				return (
					<button
						key={o.value}
						type="button"
						aria-pressed={sel}
						disabled={readOnly || (!sel && atMax)}
						data-testid="card-option"
						data-value={o.value}
						data-custom={o.custom ? "true" : undefined}
						onClick={() => toggle(o.value)}
						className={cn(
							OPTION_ROW,
							sel ? "border-primary bg-accent" : "enabled:hover:bg-accent/50",
							readOnly && !sel && "text-muted-foreground",
							// at max: the unpicked rows stay visible but clearly unavailable
							!readOnly && !sel && atMax && "cursor-not-allowed opacity-50",
						)}
					>
						<Indicator shape="check" on={sel} />
						<span className="flex min-w-0 flex-col items-start">
							<MessageResponse>{o.label}</MessageResponse>
							{o.description && <MessageResponse className="lh-prose block text-xs text-muted-foreground">{o.description}</MessageResponse>}
						</span>
					</button>
				);
			})}
			{field.allowOther === true && !readOnly && (
				<div className="flex gap-2">
					<CardTextInput testId="card-other" className="flex-1 px-3 py-1.5" placeholder="Other…" value={typed} onChange={onType} onEnter={addCustom} {...dictation} />
					<Button type="button" size="sm" variant="outline" data-testid="card-other-add" disabled={typed.trim() === "" || error !== undefined} onClick={addCustom}>
						Add
					</Button>
				</div>
			)}
			{!readOnly && error && (
				<div data-testid="card-other-error" className="text-xs text-destructive">
					{error}
				</div>
			)}
			{!readOnly && hint && (
				<div data-testid="card-multi-hint" className={cn("text-xs text-muted-foreground", !multiInBounds(field, picked.length) && "text-destructive")}>
					{hint}
				</div>
			)}
		</div>
	);
}

function ConfirmView({
	field,
	value,
	readOnly,
	onChange,
	labelledBy,
}: {
	labelledBy: string;
	field: Extract<CardField, { kind: "confirm" }>;
	value: CardFieldAnswer | undefined;
	readOnly: boolean;
	onChange: (a: CardFieldAnswer) => void;
}) {
	const picked = typeof value?.value === "boolean" ? value.value : undefined;
	const note = value && "note" in value ? value.note : undefined;
	const btn = (which: boolean, label: string, testid: string) => (
		<button
			type="button"
			aria-pressed={picked === which}
			disabled={readOnly}
			data-testid={testid}
			onClick={() => onChange({ value: which, ...(note ? { note } : {}) })}
			className={cn(
				OPTION_ROW,
				"w-auto items-center pr-4",
				picked === which ? "border-primary bg-accent" : "enabled:hover:bg-accent/50",
				readOnly && picked !== which && "text-muted-foreground",
			)}
		>
			<Indicator shape="radio" on={picked === which} />
			{label}
		</button>
	);
	return (
		<div className="flex flex-wrap gap-2" role="group" aria-labelledby={labelledBy} data-testid="card-confirm-group">
			{btn(true, field.confirmLabel ?? "Yes", "card-confirm")}
			{btn(false, field.rejectLabel ?? "No", "card-reject")}
		</div>
	);
}

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
	...rest
}: {
	value: string;
	onChange: (text: string) => void;
	onEnter?: () => void;
	inputRef?: Ref<HTMLInputElement & HTMLTextAreaElement>;
	multiline?: boolean;
	testId: string;
	className?: string;
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
	if (multiline) return <textarea {...(common as object)} onKeyDown={onKeyDown} />;
	return (
		<input
			type="text"
			{...(common as object)}
			onKeyDown={(e) => {
				onKeyDown?.(e);
				if (e.key === "Enter" && onEnter && !e.defaultPrevented) {
					e.preventDefault();
					onEnter();
				}
			}}
		/>
	);
}
