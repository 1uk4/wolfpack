"use client";

/**
 * The questionnaire sheet of a paged `ask` card (work-wolfpack-ssPFrEw): one page at a time, each question with its
 * markdown context, optional diagram, kind-specific control, tradeoff lines, skip (unless required) and Other. A page is
 * submitted on its own (`pages/:n/answer`); the card stays pending and comes back with a higher `pageIndex`.
 * Typed text can be aimed at one question ("answering Qn", see `Answering`): the composer then POSTs it to
 * `questions/:qid/text` and the server's `draft` prefills the answer here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import { InertImage, mdComponents } from "@/components/md-blocks";
import { CardTextInput, Indicator, OPTION_ROW, isOther, otherText } from "@/components/card-fields/shared";
import { attachmentUrl, cardPageAnswerUrl, diagramUrl } from "@/components/thread-transport";
import { imagesOf, withImages } from "@/components/ask-images";
import { cn } from "@/lib/utils";
import { escapeRawHtml, type AttachedRef } from "@/src/core";
import type { CardAnswers, CardField, CardFieldAnswer, PendingCard } from "@wolfpack/client";

/** The question the composer's next text is bound to. */
export interface Answering {
	callId: string;
	qid: string;
}

const SAFE_MD = { ...mdComponents, img: InertImage };
const DIAGRAM_ID = /^viz-[a-z0-9]+(?:-[a-z0-9]+)*-\d+\.png$/;
type Opt = { label: string; value: string; description?: string; tradeoff?: string };

/** Ids of the questions on the card's current page, in order. */
export const pageFieldIds = (pc: PendingCard): string[] => pc.card.steps?.[pc.pageIndex ?? 0]?.fields ?? [];

type SingleA = { value: string; other?: boolean };
type MultiA = { value: string[]; other?: string[] };
type AnyA = { value?: unknown; other?: unknown };
/** The one place an answer is read by its kind's shape (the protocol's answer union is wider than any one control needs). */
const read = <T extends AnyA>(a: CardFieldAnswer | undefined): Partial<T> | undefined => a as unknown as Partial<T> | undefined;
const make = (a: AnyA): CardFieldAnswer => a as unknown as CardFieldAnswer;

/** Can typed text answer this question? Free text always; single unless allowOther is false; multi only when allowOther is true (the server refuses the rest). */
export function typable(f: CardField): boolean {
	if (f.kind === "free-text") return true;
	if (f.kind === "single") return (f as { allowOther?: boolean }).allowOther !== false;
	if (f.kind === "multi") return (f as { allowOther?: boolean }).allowOther === true;
	return false;
}

/** Does a kept draft still fit its field (kind unchanged, option still there, number in range)? */
function fits(f: CardField, a: CardFieldAnswer): boolean {
	const v = read<AnyA>(a);
	if (!v) return false;
	// An image-only draft (no text, no option) belongs to a free, single or multi question and stays.
	if (imagesOf(a).length > 0 && (v.value === "" || (Array.isArray(v.value) && v.value.length === 0)) && (f.kind === "free-text" || f.kind === "single" || f.kind === "multi")) return true;
	const opts = ((f as { options?: Opt[] }).options ?? []).map((o) => o.value);
	switch (f.kind) {
		case "free-text": return typeof v.value === "string";
		case "confirm": return typeof v.value === "boolean";
		case "slider": {
			const s = f as Extract<CardField, { kind: "slider" }>;
			return typeof v.value === "number" && v.value >= s.min && v.value <= s.max;
		}
		case "single": return typeof v.value === "string" && (v.other === true || opts.includes(v.value));
		case "multi": {
			const other = Array.isArray(v.other) ? (v.other as string[]) : [];
			return Array.isArray(v.value) && (v.value as unknown[]).every((x) => typeof x === "string" && (opts.includes(x) || other.includes(x)));
		}
		default: return false;
	}
}

/** One page's answers as sent: skipped (blank) questions and untouched optional sliders are left out; a required slider left at its default sends the default (the server has no answer to accept otherwise). */
export function pageBody(fields: CardField[], draft: Record<string, CardFieldAnswer>): CardAnswers {
	const out: CardAnswers = {};
	for (const f of fields) {
		if (f.kind === "slider" && !f.optional && draft[f.id] === undefined && (f as { default?: number }).default !== undefined) {
			out[f.id] = { value: (f as { default: number }).default };
			continue;
		}
		const a = draft[f.id];
		if (!a) continue;
		const v = read<AnyA>(a)!.value;
		if (typeof v === "string" && v.trim() === "") continue;
		if (Array.isArray(v) && v.length === 0) continue;
		// The images live in the server's draft, which it merges; a page answer carrying `attachments` is refused (400).
		out[f.id] = withImages(a, []);
	}
	return out;
}

export function AskSheet({ target, pc, answering, setAnswering, onSubmitted, onRefetch }: {
	target: Pick<AttachedRef, "wolf" | "slug">;
	pc: PendingCard;
	answering: Answering | null;
	setAnswering: (a: Answering | null) => void;
	/** The page was accepted; `last` = it was the final page (the card is done). */
	onSubmitted: (last: boolean) => void;
	onRefetch: () => void;
}) {
	const pageIndex = pc.pageIndex ?? 0;
	const steps = pc.card.steps ?? [];
	const ids = pageFieldIds(pc);
	const fields = useMemo(() => ids.map((id) => pc.card.fields.find((f) => f.id === id)).filter((f): f is CardField => !!f), [pc.card, pageIndex]); // eslint-disable-line react-hooks/exhaustive-deps
	const last = pageIndex >= steps.length - 1;
	const [draft, setDraft] = useState<Record<string, CardFieldAnswer>>(() => seed(pc, ids));
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const inFlight = useRef(false);
	const idsKey = ids.join("\0");
	// A successful non-final submit keeps the button busy until the card moves to its next page.
	useEffect(() => {
		inFlight.current = false;
		setBusy(false);
	}, [pageIndex, pc.callId, pc.card]);
	// Safety net: if the card never comes back (refetch lost), release the button after a while.
	useEffect(() => {
		if (!busy) return;
		const t = setTimeout(() => {
			inFlight.current = false;
			setBusy(false);
		}, 10_000);
		return () => clearTimeout(t);
	}, [busy]);
	// A message belongs to the page it was raised on: it clears on a new page or card, not on a refetch of the same page.
	useEffect(() => setError(null), [pageIndex, pc.callId]);
	// card-pending is an in-place update: ids that left the page lose their draft; bound text from the server lands in its question.
	useEffect(() => {
		setDraft((d) => {
			const keep: Record<string, CardFieldAnswer> = {};
			for (const f of fields) if (d[f.id] && fits(f, d[f.id]!)) keep[f.id] = d[f.id]!;
			return { ...keep, ...seed(pc, ids) };
		});
	}, [idsKey, pageIndex, fields, JSON.stringify(pc.draft ?? null)]); // eslint-disable-line react-hooks/exhaustive-deps
	const key = `${target.wolf}:${target.slug}`;
	const keyRef = useRef(key);
	keyRef.current = key;

	// Picking keeps the images bound to the question (wolfd keeps them in the draft too).
	const set = (id: string, a: CardFieldAnswer) => setDraft((d) => ({ ...d, [id]: withImages(a, imagesOf(d[id])) }));
	const clear = (id: string) => setDraft((d) => (({ [id]: _g, ...rest }) => rest)(d));
	/** Reply mode: aim the bottom composer at this question and put the cursor there. */
	const reply = (id: string) => {
		setAnswering({ callId: pc.callId, qid: id });
		requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="composer"] textarea')?.focus());
	};
	const missing = fields.filter((f) => f.optional !== true && Object.keys(pageBody([f], draft)).length === 0 && imagesOf(draft[f.id]).length === 0);

	const submit = async () => {
		if (inFlight.current || missing.length > 0) return;
		inFlight.current = true;
		setBusy(true);
		setError(null);
		let keepBusy = false;
		try {
			const res = await fetch(cardPageAnswerUrl(target.wolf, target.slug, pc.callId, pageIndex), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ answers: pageBody(fields, draft) }),
			});
			if (key !== keyRef.current) return;
			if (res.ok) {
				keepBusy = true;
				setAnswering(null);
				onSubmitted(last);
				return;
			}
			const b = (await res.json().catch(() => null)) as { error?: string } | null;
			if (res.status === 409) {
				// the page moved on meanwhile: show where the card is now
				setError("The questions changed, check your answers.");
				onRefetch();
			} else if (res.status === 404) {
				setError("This question set is gone.");
				onRefetch();
			} else setError(b?.error ?? `Could not send the page (${res.status}).`);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not send.");
		} finally {
			if (!keepBusy) {
				inFlight.current = false;
				setBusy(false);
			}
		}
	};

	return (
		<div data-testid="ask-sheet" data-call-id={pc.callId} data-page={pageIndex} className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card text-card-foreground shadow-lg">
			<div className="flex items-baseline justify-between gap-2 border-b px-3 py-2 font-ui text-xs text-muted-foreground">
				<span className="truncate font-medium text-foreground" data-testid="ask-page-title">{steps[pageIndex]?.title ?? pc.card.title ?? "Questions"}</span>
				<span data-testid="ask-page-count" className="shrink-0">page {pageIndex + 1} of {steps.length}</span>
			</div>
			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
				{fields.map((f) => {
					const n = pc.card.fields.findIndex((x) => x.id === f.id) + 1;
					const canType = typable(f);
					const labelId = `ask-${pc.callId}-${f.id}-label`;
					const on = answering !== null && answering.callId === pc.callId && answering.qid === f.id;
					return (
						<section key={f.id} data-testid="ask-question" data-qid={f.id} className={cn("rounded-lg", on && "ring-2 ring-primary/50")}>
							{f.description && (
								<div data-testid="ask-context" className="mb-2 text-sm text-muted-foreground">
									<MessageResponse components={SAFE_MD}>{escapeRawHtml(f.description)}</MessageResponse>
								</div>
							)}
							{f.diagram && <Diagram target={target} id={f.diagram} />}
							<div id={labelId} className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
								<span className="font-ui text-xs text-muted-foreground">Q{n}</span>
								<MessageResponse components={SAFE_MD}>{escapeRawHtml(f.label)}</MessageResponse>
								{f.optional && <span className="text-xs font-normal text-muted-foreground">(optional)</span>}
							</div>
							<Control field={f} labelId={labelId} qn={`Q${n}`} onReply={() => reply(f.id)} value={draft[f.id]} onChange={(a) => set(f.id, a)} onClear={() => clear(f.id)} />
							{imagesOf(draft[f.id]).length > 0 && <Images target={target} ids={imagesOf(draft[f.id])} />}
							<div className="mt-1 flex gap-3 font-ui text-xs">
								{canType && (
									<button type="button" data-testid="ask-answer-by-typing" className="text-primary underline" onClick={(e) => { e.stopPropagation(); if (on) setAnswering(null); else reply(f.id); }}>
										{on ? `answering Q${n}…` : "answer by typing"}
									</button>
								)}
								{f.optional && draft[f.id] && (
									<button type="button" data-testid="ask-skip" className="text-muted-foreground underline" onClick={(e) => { e.stopPropagation(); clear(f.id); }}>
										skip
									</button>
								)}
							</div>
						</section>
					);
				})}
			</div>
			{error && <p role="alert" data-testid="ask-error" className="px-3 pb-1 font-ui text-xs text-destructive">{error}</p>}
			<div className="flex items-center justify-end gap-2 border-t px-3 py-2">
				{missing.length > 0 && <span data-testid="ask-missing" role="status" aria-live="polite" className="mr-auto font-ui text-xs text-amber-700 dark:text-amber-400">Answer to continue: {missing.map((f) => `Q${pc.card.fields.findIndex((x) => x.id === f.id) + 1}`).join(", ")}</span>}
				<Button type="button" size="sm" disabled={busy || missing.length > 0} onClick={() => void submit()} data-testid={last ? "ask-submit" : "ask-next"}>
					{busy ? "Sending…" : last ? "Submit" : "Next"}
				</Button>
			</div>
		</div>
	);
}

/** Bound text (the server's draft) as the prefilled answer: Other text for single/multi, the value for free text. */
function seed(pc: PendingCard, ids: string[]): Record<string, CardFieldAnswer> {
	const out: Record<string, CardFieldAnswer> = {};
	for (const id of ids) {
		const d = pc.draft?.[id];
		if (d) out[id] = d;
	}
	return out;
}

/** Small thumbnails of the images bound to an answer, with an "N images" badge; loaded through the thread's attachment URL. */
function Images({ target, ids }: { target: Pick<AttachedRef, "wolf" | "slug">; ids: string[] }) {
	return (
		<div data-testid="ask-images" className="mt-1 flex flex-wrap items-center gap-1">
			<span className="font-ui text-xs text-muted-foreground">{ids.length} image{ids.length === 1 ? "" : "s"}</span>
			{ids.map((id) => (
				// eslint-disable-next-line @next/next/no-img-element
				<img key={id} src={attachmentUrl(target.wolf, target.slug, id)} alt="" className="size-8 rounded border object-cover" />
			))}
		</div>
	);
}

function Diagram({ target, id }: { target: Pick<AttachedRef, "wolf" | "slug">; id: string }) {
	const [failed, setFailed] = useState(false);
	if (!DIAGRAM_ID.test(id) || failed) return <div data-testid="ask-diagram-missing" className="mb-2 rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">Diagram unavailable</div>;
	return <img data-testid="ask-diagram" src={diagramUrl(target.wolf, target.slug, id)} alt="Diagram" onError={() => setFailed(true)} className="mb-2 max-h-72 w-full rounded-lg border bg-background object-contain" />;
}

function Control({ field, labelId, qn, onReply, value, onChange, onClear }: { field: CardField; labelId: string; qn: string; onReply: () => void; value: CardFieldAnswer | undefined; onChange: (a: CardFieldAnswer) => void; onClear: () => void }) {
	const stop = (e: React.SyntheticEvent) => e.stopPropagation();
	// Reply mode starts on click, Enter or Space, never on focus: reply() moves focus to the composer, which would trap a keyboard user tabbing through.
	const replyKeys = { onClick: onReply, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onReply(); } } };
	const hint = (bound: boolean) => bound && <span data-testid="ask-replace-answer-hint" className="mt-0.5 block font-ui text-xs text-muted-foreground">Tap to replace this answer in the chat below</span>;
	if (field.kind === "free-text") {
		const v = typeof value?.value === "string" ? value.value : "";
		return <div onClick={stop}><CardTextInput testId="ask-free" multiline aria-labelledby={labelId} className="min-h-20 w-full px-3 py-1.5" value={v} onChange={() => {}} readOnly {...replyKeys} placeholder="Tap to answer in the chat below" />{hint(v !== "")}</div>;
	}
	if (field.kind === "confirm") {
		const v = (value as { value?: boolean } | undefined)?.value;
		return (
			<div className="flex gap-2" role="radiogroup" aria-labelledby={labelId} onClick={stop}>
				{[true, false].map((b) => (
					<button key={String(b)} type="button" role="radio" data-testid="ask-confirm" data-value={String(b)} aria-checked={v === b} onClick={() => (v === b ? onClear() : onChange({ value: b }))} className={cn(OPTION_ROW, "w-auto items-center", v === b ? "border-primary bg-accent" : "hover:bg-accent/50")}>
						<Indicator shape="radio" on={v === b} />
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
				<div className="flex items-center gap-3 text-xs text-muted-foreground">
					<span data-testid="ask-slider-min">{f.minLabel ?? f.min}</span>
					<input type="range" aria-labelledby={labelId} aria-valuetext={touched === undefined ? `${shown} (default)` : String(shown)} min={f.min} max={f.max} step={f.step} value={shown} onChange={(e) => onChange({ value: Number(e.target.value) })} className="min-w-0 flex-1" data-testid="ask-slider-input" />
					<span data-testid="ask-slider-max">{f.maxLabel ?? f.max}</span>
				</div>
				<div data-testid="ask-slider-value" className="mt-1 text-center font-ui text-sm text-foreground">{shown}</div>
			</div>
		);
	}
	const f = field as Extract<CardField, { kind: "single" | "multi" }>;
	const multi = f.kind === "multi";
	const cur = read<AnyA>(value);
	const custom = multi && Array.isArray(cur?.other) ? (cur!.other as string[]) : [];
	const picked = multi ? (Array.isArray(cur?.value) ? (cur!.value as string[]).filter((v) => !custom.includes(v)) : []) : [];
	const write = (opts: string[], text: string) => onChange(text.trim() === "" ? make({ value: opts } satisfies MultiA) : make({ value: [...opts, text], other: [text] } satisfies MultiA));
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
						onClick={() => (multi ? write(sel ? picked.filter((x) => x !== o.value) : [...picked, o.value], custom[0] ?? "") : sel ? onClear() : onChange(make({ value: o.value } satisfies SingleA)))}
						className={cn(OPTION_ROW, sel ? "border-primary bg-accent" : "hover:bg-accent/50")}
					>
						<Indicator shape={multi ? "check" : "radio"} on={sel} />
						<span className="flex min-w-0 flex-col items-start">
							<span>{o.label}</span>
							{o.description && <span className="text-xs text-muted-foreground">{o.description}</span>}
							{o.tradeoff && <span data-testid="ask-tradeoff" className="text-xs text-muted-foreground">{o.tradeoff}</span>}
						</span>
					</button>
				);
			})}
			{otherAllowed && !multi && (
				<CardTextInput testId="ask-other" aria-label={`${qn} Other`} className={cn("px-3 py-1.5", isOther(value) && "border-primary bg-accent")} placeholder="Other: tap to answer in the chat below" value={otherText(value) ?? ""} onChange={() => {}} readOnly {...replyKeys} />
			)}
			{otherAllowed && multi && (
				<CardTextInput testId="ask-other" aria-label={`${qn} Other`} className="px-3 py-1.5" placeholder="Other: tap to answer in the chat below" value={custom[0] ?? ""} onChange={() => {}} readOnly {...replyKeys} />
			)}
		</div>
	);
}
