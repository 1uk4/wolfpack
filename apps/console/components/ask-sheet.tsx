"use client";

/**
 * The questionnaire sheet of a paged `ask` card (work-wolfpack-ssPFrEw): one page at a time, each question with its markdown
 * context, optional diagram, kind-specific control, tradeoff lines, skip (unless required) and Other. It has no footer button and
 * no border of its own: the host draws ONE card around the sheet and the bottom composer, whose send button reads Next / Submit
 * (see ask-session.ts, which also holds the answers, the page cursor and the note). Back sits in the header from page 2.
 * A free-text or Other field turns into a composer in place when tapped ("answering Qn", see `Answering`): Send POSTs the
 * text and images to `questions/:qid/text` and the server's `draft` prefills the answer here. The host hides its bottom composer meanwhile.
 */
import { useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, PencilIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { InertImage, mdComponents } from "@/components/md-blocks";
import { CardTextInput, isOther, otherText } from "@/components/card-fields/shared";
import { attachmentUrl, diagramUrl } from "@/components/thread-transport";
import { imagesOf } from "@/components/ask-images";
import { postReply } from "@/components/ask-reply-send";
import { hasUnsent, InlineAnswerComposer, useInlineAnswers, type InlineDraft } from "@/components/ask-inline-composer";
import { replyLabel } from "@/components/ask-reply";
import { make, read, type AnyA, type MultiA, type Opt, type SingleA } from "@/components/ask-answers";
import type { AskSession } from "@/components/ask-session";
import type { Dictation } from "@/components/dictation";
import { cn } from "@/lib/utils";
import { escapeRawHtml, type AttachedRef } from "@/src/core";
import type { CardField, CardFieldAnswer } from "@wolfpack/client";
import { DIAGRAM_ID_RE } from "@wolfpack/protocol";

export { pageBody, pageFieldIds } from "@/components/ask-answers";

/** The question whose inline composer is open. */
export interface Answering {
	callId: string;
	qid: string;
}

/** The console's one highlight (a thread screen overrides it, amber on the owner's), as classes this sheet shares. */
const ACCENT_BG = "bg-(color:--thread-accent) text-(color:--thread-accent-foreground)";
const ACCENT_TINT = "border-(color:--thread-accent) bg-[color-mix(in_oklab,var(--thread-accent)_12%,transparent)]";
const FOCUS = "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
const CHOICE = cn("flex w-full items-start gap-2.5 rounded-lg border bg-background/40 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60", FOCUS);
/** A read-only field that hands typing to the composer: an input-like surface with a pencil and the hint. */
const PREVIEW = "w-full cursor-text rounded-lg border border-dashed bg-background/40 py-2 pl-8 pr-3 text-sm placeholder:text-muted-foreground/80 hover:bg-accent/40";
const SAFE_MD = { ...mdComponents, img: InertImage };

/** Can typed text answer this question? Free text always; single unless allowOther is false; multi only when allowOther is true (the server refuses the rest). */
export function typable(f: CardField): boolean {
	if (f.kind === "free-text") return true;
	if (f.kind === "single") return (f as { allowOther?: boolean }).allowOther !== false;
	if (f.kind === "multi") return (f as { allowOther?: boolean }).allowOther === true;
	return false;
}

/** A multi answer split into its option picks and its custom entries. */
function multiParts(a: CardFieldAnswer | undefined): { picked: string[]; custom: string[] } {
	const cur = read<AnyA>(a);
	const custom = Array.isArray(cur?.other) ? (cur.other as string[]) : [];
	const picked = Array.isArray(cur?.value) ? (cur.value as string[]).filter((v) => !custom.includes(v)) : [];
	return { picked, custom };
}

export function AskSheet({ target, session, answering, setAnswering, dictation }: {
	target: Pick<AttachedRef, "wolf" | "slug">;
	session: AskSession;
	answering: Answering | null;
	setAnswering: (a: Answering | null) => void;
	/** The host's dictation run: the inline composer shows its Dictate row and takes the transcript. */
	dictation?: Dictation;
}) {
	const { pc, page: pageIndex, fields, draft, set, clear, error } = session;
	const steps = pc.card.steps ?? [];
	// Skipped questions (optional ones the owner passed on): greyed until Answer or a click brings them back. A draft that arrives (bound text) also ends the skip.
	const [skippedIds, setSkippedIds] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => setSkippedIds(new Set()), [pageIndex, pc.callId]);
	const skip = (id: string) => { clear(id); setSkippedIds((s) => new Set(s).add(id)); };
	const unskip = (id: string) => setSkippedIds((s) => { const n = new Set(s); n.delete(id); return n; });
	/** Open this question's composer in place. */
	const reply = (id: string) => setAnswering({ callId: pc.callId, qid: id });
	const inline = useInlineAnswers(target, session.refetch);
	const composingId = answering !== null && answering.callId === pc.callId ? answering.qid : null;
	// A click anywhere outside the open composer closes it (capture phase, so an option picked in the same click still gets it); the draft stays.
	useEffect(() => {
		if (composingId === null) return;
		const onClick = (e: Event) => {
			const el = e.target as Element | null;
			if (el?.closest?.('[data-testid="ask-inline-composer"]')) return;
			setAnswering(null);
		};
		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, [composingId, setAnswering]);
	// Going to another page closes the open composer.
	useEffect(() => setAnswering(null), [pageIndex]); // eslint-disable-line react-hooks/exhaustive-deps
	/** The sent text shows in its field at once (the server's draft, read back right after, says the same). */
	const bindLocal = (f: CardField, text: string) => {
		if (text === "") return;
		if (f.kind === "free-text") return set(f.id, make({ value: text }));
		if (f.kind === "single") return set(f.id, make({ value: text, other: true }));
		if (f.kind !== "multi") return;
		const { picked, custom } = multiParts(draft[f.id]);
		const others = custom.includes(text) ? custom : [...custom, text];
		set(f.id, make({ value: [...picked, ...others], other: others } satisfies MultiA));
	};
	/** A multi question keeps a LIST of custom answers: the whole picked/custom lists go to the server, replacing its draft. */
	const multiOf = (f: CardField) => (text: string) => {
		const { picked, custom } = multiParts(draft[f.id]);
		return { picked, others: text === "" || custom.includes(text) ? custom : [...custom, text] };
	};
	/** Unchecking a custom row drops it from the server's draft too (the superseded note reads that). */
	const syncCustoms = (f: CardField, a: CardFieldAnswer) => {
		if (f.kind !== "multi") return;
		const before = multiParts(draft[f.id]).custom;
		const now = multiParts(a);
		if (before.length === now.custom.length) return;
		void postReply(target.wolf, target.slug, pc.callId, f.id, "", [], { picked: now.picked, others: now.custom });
	};
	const composer = (f: CardField): React.ReactNode =>
		composingId === f.id ? (
			<InlineAnswerComposer
				label={replyLabel(f)}
				draft={inline.drafts[f.id] ?? { text: "", atts: [] }}
				error={inline.errors[f.id]}
				dictation={dictation}
				onText={(v) => inline.setText(f.id, v)}
				onFiles={(files) => inline.addFiles(f.id, files)}
				onRemove={(k) => inline.removeAtt(f.id, k)}
				onSend={() => inline.send(pc.callId, f.id, f.kind === "multi" ? multiOf(f) : undefined).then((sent) => {
					if (sent === null) return;
					bindLocal(f, sent);
					// A multi question stays open for the next custom answer; the others bind and close.
					if (f.kind !== "multi") setAnswering(null);
				})}
				onClose={() => setAnswering(null)}
			/>
		) : null;

	return (
		<div data-testid="ask-sheet" data-call-id={pc.callId} data-page={pageIndex} className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card text-card-foreground">
			<div className="flex flex-col gap-2 border-b px-4 pb-2.5 pt-3">
				<div className="flex items-baseline justify-between gap-2">
					<span className="flex min-w-0 items-center gap-1">
						{pageIndex > 0 && (
							<button type="button" data-testid="ask-back" disabled={session.busy} onClick={session.back} className={cn("-ml-1.5 flex shrink-0 items-center gap-0.5 self-center rounded-md px-1.5 py-1 font-ui text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40", FOCUS)}>
								<ChevronLeftIcon aria-hidden className="size-3.5" />
								Back
							</button>
						)}
						<span className="truncate text-sm font-semibold text-foreground" data-testid="ask-page-title">{steps[pageIndex]?.title ?? pc.card.title ?? "Questions"}</span>
					</span>
					<span className="flex shrink-0 items-center gap-1">
						<span data-testid="ask-page-count" className="font-ui text-xs text-muted-foreground">page {pageIndex + 1} of {steps.length}</span>
						<button type="button" data-testid="ask-collapse" aria-label="Collapse the questions" onClick={session.collapse} className={cn("flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground", FOCUS)}>
							<ChevronDownIcon aria-hidden className="size-4" />
						</button>
					</span>
				</div>
				<div aria-hidden className="flex gap-1">
					{steps.map((_, i) => (
						<span key={i} className={cn("h-1 flex-1 rounded-full transition-colors", i <= pageIndex ? "bg-(color:--thread-accent)" : "bg-border")} />
					))}
				</div>
			</div>
			<div key={pageIndex} className="wp-card-enter min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
				{fields.map((f) => {
					const n = pc.card.fields.findIndex((x) => x.id === f.id) + 1;
					const labelId = `ask-${pc.callId}-${f.id}-label`;
					const on = answering !== null && answering.callId === pc.callId && answering.qid === f.id;
					const skipped = skippedIds.has(f.id) && !draft[f.id];
					return (
						<section
							key={f.id}
							data-testid="ask-question"
							data-qid={f.id}
							data-skipped={skipped ? "true" : undefined}
							tabIndex={skipped ? 0 : undefined}
							onClick={skipped ? () => unskip(f.id) : undefined}
							onKeyDown={skipped ? (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); unskip(f.id); } } : undefined}
							className={cn("relative rounded-lg", skipped && "cursor-pointer focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", on && "ring-1 ring-(color:--thread-accent) ring-offset-4 ring-offset-card")}
						>
							{/* Header row: the label wraps, Skip question / Answer stays at the right and outside the greyed part. */}
							<div data-testid="ask-question-header" className="mb-2 flex items-start justify-between gap-2">
								<div id={labelId} className={cn("flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-sm font-medium [overflow-wrap:anywhere]", skipped && "opacity-50")}>
									<MessageResponse components={SAFE_MD}>{escapeRawHtml(f.label)}</MessageResponse>
									{f.optional && <span className="rounded-full bg-accent px-1.5 py-px font-ui text-[10px] font-normal uppercase tracking-wider text-muted-foreground">optional</span>}
								</div>
								{(skipped || f.optional) && (
									<button type="button" data-testid={skipped ? "ask-unskip" : "ask-skip"} className={cn("-mt-1 shrink-0 rounded-md px-1.5 py-1 font-ui text-xs text-muted-foreground hover:bg-accent hover:text-foreground", FOCUS)} onClick={(e) => { e.stopPropagation(); skipped ? unskip(f.id) : skip(f.id); }}>
										{skipped ? "Answer" : "Skip question"}
									</button>
								)}
							</div>
							<div className={cn(skipped && "opacity-50")}>
							{f.description && (
								<div data-testid="ask-context" className={cn("mb-2 text-[13px] leading-relaxed text-muted-foreground")}>
									<MessageResponse components={SAFE_MD}>{escapeRawHtml(f.description)}</MessageResponse>
								</div>
							)}
							{f.diagram && <Diagram target={target} id={f.diagram} />}
							{skipped && <span data-testid="ask-skipped" className="mb-1 block font-ui text-[11px] text-muted-foreground">Skipped</span>}
							<div data-testid="ask-choices" role={skipped ? "group" : undefined} aria-labelledby={skipped ? labelId : undefined} aria-disabled={skipped ? true : undefined}>
								{/* A click on a greyed choice only brings the question back; it never selects. */}
								<Control field={f} labelId={labelId} qn={`Q${n}`} composer={composer(f)} unsent={inline.drafts[f.id]} onReply={() => (skipped ? unskip(f.id) : reply(f.id))} value={draft[f.id]} onChange={(a) => { if (skipped) return unskip(f.id); syncCustoms(f, a); set(f.id, a); }} onClear={() => (skipped ? unskip(f.id) : clear(f.id))} />
							</div>
							{imagesOf(draft[f.id]).length > 0 && <Images target={target} ids={imagesOf(draft[f.id])} />}
							</div>
						</section>
					);
				})}
			</div>
			{error && <p role="alert" data-testid="ask-error" className="px-4 pb-1 font-ui text-xs text-destructive">{error}</p>}
		</div>
	);
}

/** Small thumbnails of the images bound to an answer, with an "N images" badge; loaded through the thread's attachment URL. */
function Images({ target, ids }: { target: Pick<AttachedRef, "wolf" | "slug">; ids: string[] }) {
	return (
		<div data-testid="ask-images" className="mt-1.5 flex flex-wrap items-center gap-1.5">
			<span className="rounded-full bg-accent px-2 py-0.5 font-ui text-xs text-muted-foreground">{ids.length} image{ids.length === 1 ? "" : "s"}</span>
			{ids.map((id) => (
				// eslint-disable-next-line @next/next/no-img-element
				<img key={id} src={attachmentUrl(target.wolf, target.slug, id)} alt="" className="size-8 rounded-md border object-cover" />
			))}
		</div>
	);
}

function Diagram({ target, id }: { target: Pick<AttachedRef, "wolf" | "slug">; id: string }) {
	const [failed, setFailed] = useState(false);
	if (!DIAGRAM_ID_RE.test(id) || failed) return <div data-testid="ask-diagram-missing" className="mb-2 rounded-xl border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">Diagram unavailable</div>;
	return <img data-testid="ask-diagram" src={diagramUrl(target.wolf, target.slug, id)} alt="Diagram" onError={() => setFailed(true)} className="mb-2 max-h-72 w-full rounded-xl border bg-background object-contain" />;
}

function Control({ field, labelId, qn, composer, unsent, onReply, value, onChange, onClear }: { field: CardField; labelId: string; qn: string; /** The open inline composer, drawn in place of the field. */ composer: React.ReactNode; /** Text and images typed but not sent. */ unsent: InlineDraft | undefined; onReply: () => void; value: CardFieldAnswer | undefined; onChange: (a: CardFieldAnswer) => void; onClear: () => void }) {
	const stop = (e: React.SyntheticEvent) => e.stopPropagation();
	// Reply mode starts on click, Enter or Space, never on focus: reply() moves focus to the composer, which would trap a keyboard user tabbing through.
	const replyKeys = { onClick: onReply, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onReply(); } } };
	const hint = (bound: boolean) => bound && <span data-testid="ask-replace-answer-hint" className="mt-0.5 block font-ui text-xs text-muted-foreground">Tap to replace this answer</span>;
	const unsentNote = hasUnsent(unsent) && <span data-testid="ask-unsent" className="mt-0.5 block font-ui text-xs text-muted-foreground">Unsent{unsent!.text.trim() !== "" ? `: ${unsent!.text.trim()}` : ""}{unsent!.atts.length > 0 ? ` (${unsent!.atts.length} image${unsent!.atts.length === 1 ? "" : "s"})` : ""}. Tap to continue</span>;
	if (field.kind === "free-text") {
		const v = typeof value?.value === "string" ? value.value : "";
		if (composer) return <div onClick={stop}>{composer}</div>;
		return <div onClick={stop} className="relative"><PencilIcon aria-hidden className="pointer-events-none absolute left-2.5 top-3 size-3.5 text-muted-foreground" /><CardTextInput testId="ask-free" multiline aria-labelledby={labelId} className={cn(PREVIEW, "min-h-20", v !== "" && "border-solid text-foreground", FOCUS)} value={v} onChange={() => {}} readOnly {...replyKeys} placeholder="Tap to answer" />{hint(v !== "")}{unsentNote}</div>;
	}
	if (field.kind === "confirm") {
		const v = (value as { value?: boolean } | undefined)?.value;
		return (
			<div className="inline-flex w-full gap-1 rounded-lg border bg-background/40 p-1 sm:w-auto" role="radiogroup" aria-labelledby={labelId} onClick={stop}>
				{[true, false].map((b) => (
					<button key={String(b)} type="button" role="radio" data-testid="ask-confirm" data-value={String(b)} aria-checked={v === b} onClick={() => (v === b ? onClear() : onChange({ value: b }))} className={cn("flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-5 text-sm transition-colors sm:flex-none", FOCUS, v === b ? cn(ACCENT_TINT, "font-medium text-foreground") : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>
						{v === b && <CheckIcon aria-hidden className="size-3.5" />}
						{b ? "Yes" : "No"}
					</button>
				))}
			</div>
		);
	}
	if (field.kind === "slider") {
		const f = field as Extract<CardField, { kind: "slider" }>;
		const touched = (value as { value?: number } | undefined)?.value;
		const shown = touched ?? f.default ?? f.min;
		return (
			<div onClick={stop} data-testid="ask-slider" data-touched={touched !== undefined || undefined}>
				<div className="flex items-center gap-3 text-xs text-muted-foreground [overflow-wrap:anywhere]">
					<span data-testid="ask-slider-min">{f.minLabel ?? f.min}</span>
					<input type="range" aria-labelledby={labelId} aria-valuetext={touched === undefined ? `${shown} (default)` : String(shown)} min={f.min} max={f.max} step={f.step} value={shown} onChange={(e) => onChange({ value: Number(e.target.value) })} className="h-1.5 min-w-0 flex-1 cursor-pointer accent-(color:--thread-accent)" data-testid="ask-slider-input" />
					<span data-testid="ask-slider-max">{f.maxLabel ?? f.max}</span>
				</div>
				<div className="mt-2 flex justify-center"><span data-testid="ask-slider-value" className={cn("rounded-full px-2.5 py-0.5 font-ui text-xs tabular-nums", touched === undefined ? "bg-accent text-muted-foreground" : cn(ACCENT_BG, "font-medium"))}>{shown}</span></div>
			</div>
		);
	}
	const f = field as Extract<CardField, { kind: "single" | "multi" }>;
	const multi = f.kind === "multi";
	const cur = read<AnyA>(value);
	const custom = multi && Array.isArray(cur?.other) ? (cur!.other as string[]) : [];
	const picked = multi ? (Array.isArray(cur?.value) ? (cur!.value as string[]).filter((v) => !custom.includes(v)) : []) : [];
	const write = (opts: string[], customs: string[]) => onChange(customs.length === 0 ? make({ value: opts } satisfies MultiA) : make({ value: [...opts, ...customs], other: customs } satisfies MultiA));
	const otherAllowed = multi ? f.allowOther === true : f.allowOther !== false;
	return (
		<div className="flex flex-col gap-1.5 text-sm" role={multi ? "group" : "radiogroup"} aria-labelledby={labelId} onClick={stop}>
			{(f.options as Opt[]).map((o) => {
				const sel = multi ? picked.includes(o.value) : !isOther(value) && cur?.value === o.value;
				return (
					<button
						key={o.value}
						type="button"
						role={multi ? "checkbox" : "radio"}
						aria-checked={sel}
						data-testid="ask-option"
						data-value={o.value}
						onClick={() => (multi ? write(sel ? picked.filter((x) => x !== o.value) : [...picked, o.value], custom) : sel ? onClear() : onChange(make({ value: o.value } satisfies SingleA)))}
						className={cn(CHOICE, sel && ACCENT_TINT)}
					>
						<span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 [overflow-wrap:anywhere]">
							<span className={cn(sel && "font-medium")}>{o.label}</span>
							{o.description && <span className="text-xs text-muted-foreground">{o.description}</span>}
							{o.tradeoff && <span data-testid="ask-tradeoff" className="text-xs text-muted-foreground">{o.tradeoff}</span>}
						</span>
						<span aria-hidden data-testid="card-indicator" data-on={sel || undefined} className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full transition-opacity", sel ? ACCENT_BG : "opacity-0")}>
							<CheckIcon className="size-3" strokeWidth={3} />
						</span>
					</button>
				);
			})}
			{/* Custom answers of a multi question: checked rows like a picked option; unchecking removes one. */}
			{custom.map((c) => (
				<button key={`custom:${c}`} type="button" role="checkbox" aria-checked data-testid="ask-option" data-custom="true" data-value={c} onClick={() => write(picked, custom.filter((x) => x !== c))} className={cn(CHOICE, ACCENT_TINT)}>
					<span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 [overflow-wrap:anywhere]"><span className="font-medium">{c}</span></span>
					<span aria-hidden data-testid="card-indicator" data-on className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full", ACCENT_BG)}><CheckIcon className="size-3" strokeWidth={3} /></span>
				</button>
			))}
			{otherAllowed && !multi && (
				composer ? composer : <div className="relative"><PencilIcon aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><CardTextInput testId="ask-other" aria-label={`${qn} Other`} className={cn(PREVIEW, FOCUS, isOther(value) && cn(ACCENT_TINT, "border-solid"))} placeholder="Other: tap to answer" value={otherText(value) ?? ""} onChange={() => {}} readOnly {...replyKeys} />{unsentNote}</div>
			)}
			{otherAllowed && multi && (
				composer ? composer : <div className="relative"><PencilIcon aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><CardTextInput testId="ask-other" aria-label={`${qn} Other`} className={cn(PREVIEW, FOCUS)} placeholder={custom.length ? "Add another answer" : "Other: tap to answer"} value="" onChange={() => {}} readOnly {...replyKeys} />{unsentNote}</div>
			)}
		</div>
	);
}
