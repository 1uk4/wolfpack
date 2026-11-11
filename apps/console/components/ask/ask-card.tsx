"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/composer/dictation";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { addCustomEntry, escapeRawHtml, closedOf, draftAnswers, draftComplete, fieldBlank, fieldsComplete, foldPendingOther, initialDraft, visibleFields, visibleSteps, type CardDraft } from "@/src/core";
import type { CardField, CardFieldAnswer } from "@wolfpack/client";
import type { InteractionCardProps } from "@/components/card-registry";
import { fieldRenderer } from "@/components/ask/card-fields";
import { CardTextInput, otherText, type FieldDictation } from "@/components/ask/card-fields/shared";
import { BriefHeader } from "@/components/ask/brief-header";

export { CardTextInput };

/**
 * The inline interaction card of a wolf thread (the wolf asked a question): free-text, single-choice, multi-choice (checkboxes) and confirm (yes/no) fields.
 * Visuals follow the answered record (answered-card.tsx): a bordered
 * card, "Question" kicker, markdown question, option rows with an Other entry. Pending it is a form; answered it is the
 * static record. Defaults only pre-select; nothing submits until the operator presses Submit.
 */
export function AskCard({ card, answer, dismissed, closed: closedProp, heldAnswer, heldSkip, pending, submitting, onAnswer, onSkip, compact, onOpenThread }: InteractionCardProps) {
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
	// Un-pick an optional single/confirm (clicking the selected option again): the entry leaves the draft, so a default does not come back.
	const clear = (fieldId: string) => {
		const { [fieldId]: _gone, ...rest } = draftRef.current;
		draftRef.current = rest;
		setDraft(rest);
	};
	const answered = answer !== undefined;
	const closedKind = closedOf({ answer, dismissed, closed: closedProp });
	const closed = closedKind !== undefined;
	// Text typed into a multi "Other…" box but not yet added still counts on Submit (folded in, never lost).
	const [typed, setTyped] = useState<Record<string, string>>({});
	const typedRef = useRef(typed);
	const setTypedText = (fieldId: string, text: string) => {
		typedRef.current = { ...typedRef.current, [fieldId]: text };
		setTyped(typedRef.current);
	};
	const liveRef = useRef(false);
	liveRef.current = pending && !closed;
	// Add (button or Enter) finishes a live dictation first (as Submit does), then reads the ref mirrors, never a render's
	// props: a late dictated chunk lands in the pending text before it is added, so it cannot become a second entry.
	const addCustomFor = (field: Extract<CardField, { kind: "multi" }>) => {
		void finishDictation().then(() => {
			if (!liveRef.current) return;
			const r = addCustomEntry(field, draftRef.current[field.id], typedRef.current[field.id] ?? "");
			if ("error" in r) return; // shown live as the field's error
			set(field.id, r.answer);
			setTypedText(field.id, "");
		});
	};
	// The fields in play now (hidden ones and other steps' fields never take dictation).
	const inPlay = closed ? [] : shownIds(card, draft, stepIdx);
	const { claimed, dictationProps } = useCardDictation(card, draftRef, set, typedRef, setTypedText, pending && !closed, inPlay);
	// Submit finishes a live dictation first, then reads the mirrors. `finishing` blocks re-entry (and disables Submit)
	// while the finish is pending; afterwards the card is re-checked (liveRef) so one answered/skipped meanwhile is not answered again.
	const [finishing, setFinishing] = useState(false);
	const finishingRef = useRef(false);
	// Recomputed from the mirrors at call time (after a dictation finish the render state is stale): an invalid or
	// incomplete result aborts the submit and leaves the typed text with its inline error.
	const [attempted, setAttempted] = useState(false);
	const answerNow = () => {
		const f = foldPendingOther(card, draftRef.current, typedRef.current);
		if (Object.keys(f.errors).length > 0 || !draftComplete(card, f.draft)) {
			setAttempted(true); // never a silent no-op: the hint + highlight say what is missing
			return;
		}
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
	// Required fields still unanswered (visible ones only): highlighted, and named beside the disabled Submit so it is never a mystery.
	const missingFields = visibleFields(card, folded.draft).filter((f) => !fieldsComplete([f], folded.draft));
	const missingIds = new Set(missingFields.map((f) => f.id));
	// Shown only after a failed Submit; clears itself once the draft is complete and valid.
	const hasErrors = Object.keys(folded.errors).length > 0;
	const incomplete = hasErrors || missingFields.length > 0;
	useEffect(() => {
		if (!incomplete) setAttempted(false);
	}, [incomplete]);
	const showHint = attempted && incomplete && pending && !closed && !submitting;
	const hintId = `card-hint-${useId()}`;
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
			className={cn("rounded-xl border bg-card text-card-foreground", compact ? "p-2.5 text-sm" : "p-4", closedKind && CLOSED_STYLE[closedKind].card)}
			data-testid={closedKind === "skipped" || closedKind === "superseded" ? "dismissed-card" : answered ? "answered-card" : "pending-card"}
			data-closed={closedKind}
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
				{/* `card.brief` is legacy: the brief tool is gone, so only old transcripts carry it (rendered read-only). */}
				{card.brief ? "Brief" : (card.title ?? "Question")}
				{closedKind && (
					<span data-testid="card-closed-badge" data-closed={closedKind} className={cn("ml-2 rounded px-1.5 py-0.5 font-semibold", CLOSED_STYLE[closedKind].badge)}>
						{CLOSED_STYLE[closedKind].label}
					</span>
				)}
				{!closed && !pending && <span className="ml-2 rounded bg-muted px-1.5 py-0.5">waiting</span>}
				{!closed && heldSkip && <span data-testid="card-held-skip" className="ml-2 rounded bg-muted px-1.5 py-0.5">skip saved · waiting for the other questions</span>}
				{!closed && !heldSkip && heldAnswer && <span data-testid="card-held" className="ml-2 rounded bg-muted px-1.5 py-0.5">answer saved · waiting for the other questions</span>}
			</div>
			{card.brief && <BriefHeader brief={card.brief} compact={compact} onOpenThread={onOpenThread} className={compact ? "mb-2" : "mb-3"} />}
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
					skipped={answered && f.optional === true && fieldBlank(f, answer[f.id])}
					onChange={(a) => set(f.id, a)}
					onClear={() => clear(f.id)}
					typed={typed[f.id] ?? ""}
					onType={(text) => setTypedText(f.id, text)}
					onAddCustom={f.kind === "multi" ? () => addCustomFor(f) : undefined}
					dictation={dictationProps.field(f.id)}
					pendingError={folded.errors[f.id]}
					missing={showHint && missingIds.has(f.id)}
					compact={compact}
				/>
			))}
			{!closed && (
				<div id={hintId} role="status" className="mt-3 text-xs text-amber-700 empty:hidden dark:text-amber-400" data-testid="card-submit-hint">
					{showHint &&
						[
							hasErrors ? "Fix the highlighted entry to submit." : "",
							missingFields.length > 0 ? `Answer to submit: ${missingFields.map((f) => f.label.replace(/[*_`]|\[([^\]]*)\]\([^)]*\)/g, "$1")).join(", ")}` : "",
						]
							.filter(Boolean)
							.join(" ")}
				</div>
			)}
			{!closed && (
				<div className="mt-3 flex justify-end gap-2">
					{onSkip && (
						<Button type="button" size="sm" variant="ghost" disabled={!pending || submitting} onClick={onSkip} data-testid="card-skip">
							{heldAnswer && !heldSkip ? "Skip (discard saved answer)" : "Skip question"}
						</Button>
					)}
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
						<Button type="button" size="sm" disabled={!pending || submitting || finishing} aria-disabled={!canSubmit || undefined} aria-describedby={hintId} onClick={submit} data-testid="card-submit">
							{submitting ? "Sending…" : heldAnswer ? "Update answer" : card.fields.length === 0 ? "OK" : "Submit"}
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

/** How each way of closing looks: a badge (label + colour) and a card accent, so a closed card is never just dimmed. */
const CLOSED_STYLE = {
	answered: { label: "Answered", badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", card: "border-l-4 border-l-emerald-500/60" },
	skipped: { label: "Skipped", badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400", card: "border-l-4 border-l-amber-500/60" },
	superseded: { label: "Superseded", badge: "bg-slate-500/15 text-slate-700 dark:text-slate-300", card: "border-l-4 border-l-slate-400/60 border-dashed" },
} as const;

/** Ids of the fields currently shown: the visible ones, on the current step when the card is stepped. */
function shownIds(card: InteractionCardProps["card"], draft: CardDraft, stepIdx: number): string[] {
	if (!card.steps) return visibleFields(card, draft).map((f) => f.id);
	const steps = visibleSteps(card, draft);
	return (steps[Math.min(stepIdx, steps.length - 1)]?.fields ?? []).map((f) => f.id);
}

let enterFinishing = false;
/** Esc in a card field cancels a live dictation (the hook listens for this event; the Esc is claimed). Plain Enter while
 *  dictating only finishes the run (the last words land in the field) and is claimed, so it adds no newline, moves no
 *  step and submits nothing; a press while the run settles does nothing. The next Enter behaves as without dictation. */
function stopDictationOnEscape(e: React.KeyboardEvent) {
	if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && isDictationActive()) {
		e.preventDefault();
		if (enterFinishing) return;
		enterFinishing = true;
		void finishDictation().finally(() => void (enterFinishing = false));
		return;
	}
	if (e.key !== "Escape" || !isDictationActive()) return;
	e.preventDefault();
	e.stopPropagation();
	window.dispatchEvent(new CustomEvent("wolfpack:kbd-cancel-dictation"));
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
	const uid = useId();
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
	useDictationTarget(append, claimed, dictField === null ? undefined : `${uid}:${dictField}`);
	return {
		claimed,
		dictationProps: {
			root: { ref: rootRef },
			field: (id: string): FieldDictation => ({ onFocus: () => setDictField(id), onKeyDown: stopDictationOnEscape, mic: { targetKey: `${uid}:${id}`, onClaim: () => setDictField(id) } }),
			release: () => setDictField(null),
		},
	};
}

function FieldView({
	field,
	value,
	readOnly,
	onChange,
	onClear,
	typed,
	onType,
	onAddCustom,
	skipped,
	pendingError,
	dictation,
	missing,
	compact,
}: {
	compact?: boolean;
	field: CardField;
	value: CardFieldAnswer | undefined;
	readOnly: boolean;
	onChange: (a: CardFieldAnswer) => void;
	onClear: () => void;
	typed: string;
	onType: (text: string) => void;
	onAddCustom?: () => void;
	/** An optional field the operator left blank, on an answered card: "Skipped" instead of empty quotes / no selection. */
	skipped?: boolean;
	pendingError?: string;
	dictation: FieldDictation;
	/** A required field with no (valid) answer yet: highlighted so it is clear what Submit is waiting for. */
	missing?: boolean;
}) {
	const labelId = `card-field-${useId()}`;
	const Renderer = fieldRenderer(field.kind);
	return (
		<div className={cn("mb-2 last:mb-0", missing && "border-l-2 border-amber-500/70 pl-2")} data-field={field.id} data-incomplete={missing || undefined}>
			<div className="mb-2 flex flex-wrap items-baseline gap-x-2 font-medium" id={labelId}>
				<MessageResponse>{escapeRawHtml(field.label)}</MessageResponse>
				{field.optional && (
					<span className="text-xs font-normal text-muted-foreground" data-testid="card-optional">
						(optional)
					</span>
				)}
			</div>
			{field.description && (
				<div className="mb-3 text-sm text-muted-foreground">
					<MessageResponse>{escapeRawHtml(field.description)}</MessageResponse>
				</div>
			)}
			{skipped ? (
				<div className="text-sm italic text-muted-foreground" data-testid="card-skipped">
					Skipped
				</div>
			) : (
				<Renderer
					field={field}
					value={value}
					readOnly={readOnly}
					onChange={onChange}
					onClear={onClear}
					labelledBy={labelId}
					compact={compact}
					typed={typed}
					onType={onType}
					onAddCustom={onAddCustom}
					error={pendingError}
					dictation={dictation}
				/>
			)}
		</div>
	);
}
