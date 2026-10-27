"use client";

import { useCallback, useEffect, useId, useRef, useState, type InputHTMLAttributes, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { addCustomEntry, draftAnswers, draftComplete, foldPendingOther, initialDraft, multiInBounds, type CardDraft } from "@/src/core";
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
	const { claimed, dictationProps } = useCardDictation(card, draftRef, set, typedRef, setTypedText, pending && !closed);
	// Submit finishes a live dictation first, then reads the mirrors. `finishing` blocks re-entry (and disables Submit)
	// while the finish is pending; afterwards the card is re-checked (liveRef) so one answered/skipped meanwhile is not answered again.
	const [finishing, setFinishing] = useState(false);
	const finishingRef = useRef(false);
	const answerNow = () => onAnswer(draftAnswers(card, foldPendingOther(card, draftRef.current, typedRef.current).draft));
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

	return (
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground"
			data-testid={dismissed ? "dismissed-card" : answered ? "answered-card" : "pending-card"}
			data-card-tool={card.tool}
			data-dictation-claimed={claimed || undefined}
			{...dictationProps.root}
		>
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{card.title ?? "Question"}
				{dismissed && <span className="ml-2 rounded bg-muted px-1.5 py-0.5">skipped</span>}
				{!closed && !pending && <span className="ml-2 rounded bg-muted px-1.5 py-0.5">waiting</span>}
				{!closed && heldAnswer && <span data-testid="card-held" className="ml-2 rounded bg-muted px-1.5 py-0.5">answer saved · waiting for the other questions</span>}
			</div>
			{card.fields.map((f) => (
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
				<div className="mt-3 flex justify-end">
					<Button type="button" size="sm" disabled={!canSubmit || finishing} onClick={submit} data-testid="card-submit">
						{submitting ? "Sending…" : heldAnswer ? "Update answer" : "Submit"}
					</Button>
				</div>
			)}
		</div>
	);
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
) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [dictField, setDictField] = useState<string | null>(null);
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
			if (!f) return;
			const cur = draftRef.current[f.id];
			if (f.kind === "free-text") set(f.id, { value: joinDictation(typeof cur?.value === "string" ? cur.value : "", t) });
			else if (f.kind === "single") set(f.id, { value: joinDictation(otherText(cur) ?? "", t), other: true });
			else if (f.kind === "multi") setTypedText(f.id, joinDictation(typedRef.current[f.id] ?? "", t));
		},
		[card, dictField],
	);
	const claimed = live && dictField !== null;
	useDictationTarget(append, claimed);
	return {
		claimed,
		dictationProps: {
			root: { ref: rootRef },
			field: (id: string): FieldDictation => ({ onFocus: () => setDictField(id), onKeyDown: stopDictationOnEscape }),
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
			<div className="mb-2 font-medium" id={labelId}>
				<MessageResponse>{field.label}</MessageResponse>
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
									"flex flex-col items-start rounded-lg border px-3 py-1.5 text-left transition-colors",
									sel ? "border-primary bg-accent" : "enabled:hover:bg-accent/50",
									readOnly && !sel && "text-muted-foreground",
								)}
							>
								<MessageResponse>{o.label}</MessageResponse>
								{o.description && <MessageResponse className="lh-prose block text-xs text-muted-foreground">{o.description}</MessageResponse>}
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
							"flex flex-col items-start rounded-lg border px-3 py-1.5 text-left transition-colors",
							sel ? "border-primary bg-accent" : "enabled:hover:bg-accent/50",
							readOnly && !sel && "text-muted-foreground",
						)}
					>
						<span className="flex items-center gap-2">
							<span aria-hidden>{sel ? "☑" : "☐"}</span>
							<MessageResponse>{o.label}</MessageResponse>
						</span>
						{o.description && <MessageResponse className="lh-prose block text-xs text-muted-foreground">{o.description}</MessageResponse>}
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
				"rounded-lg border px-4 py-1.5 text-sm transition-colors",
				picked === which ? "border-primary bg-accent" : "enabled:hover:bg-accent/50",
				readOnly && picked !== which && "text-muted-foreground",
			)}
		>
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
