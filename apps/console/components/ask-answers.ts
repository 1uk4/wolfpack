/**
 * The answers of a paged `ask` as the sheet and its session hold them (work-wolfpack-ssPFrEw): reading an answer by its kind's
 * shape, whether a kept draft still fits its field, and one page's body as sent. Pure; shared by ask-sheet.tsx (lazy) and
 * ask-session.ts (eager) so neither pulls in the other.
 */
import type { CardAnswers, CardField, CardFieldAnswer, PendingCard } from "@wolfpack/client";
import { imagesOf, withImages } from "@/components/ask-images";

export type Opt = { label: string; value: string; description?: string; tradeoff?: string };
export type SingleA = { value: string; other?: boolean };
export type MultiA = { value: string[]; other?: string[] };
export type AnyA = { value?: unknown; other?: unknown };
/** The one place an answer is read by its kind's shape (the protocol's answer union is wider than any one control needs). */
export const read = <T extends AnyA>(a: CardFieldAnswer | undefined): Partial<T> | undefined => a as unknown as Partial<T> | undefined;
export const make = (a: AnyA): CardFieldAnswer => a as unknown as CardFieldAnswer;

/** Ids of the questions on a page of the card, in order (default: the page being viewed on wolfd). */
export const pageFieldIds = (pc: PendingCard, page: number = pc.pageIndex ?? 0): string[] => pc.card.steps?.[page]?.fields ?? [];

/** Does a kept draft still fit its field (kind unchanged, option still there, number in range)? */
export function fits(f: CardField, a: CardFieldAnswer): boolean {
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

/** Is a required question still unanswered (no answer and no bound image)? */
export const unanswered = (f: CardField, draft: Record<string, CardFieldAnswer>): boolean =>
	f.optional !== true && Object.keys(pageBody([f], draft)).length === 0 && imagesOf(draft[f.id]).length === 0;

/** What the card already holds per question: the saved page answers, with the text and images bound to questions over them. */
export function seedAll(pc: PendingCard | undefined): Record<string, CardFieldAnswer> {
	const out: Record<string, CardFieldAnswer> = {};
	if (!pc) return out;
	for (const [id, a] of Object.entries(pc.pageAnswers ?? {})) out[id] = a as CardFieldAnswer;
	for (const [id, a] of Object.entries(pc.draft ?? {})) out[id] = a as CardFieldAnswer;
	return out;
}

/** The local draft after a card-pending: answers whose question left (or no longer fits) go, bound text lands, saved answers fill gaps. */
export function reconcile(pc: PendingCard, local: Record<string, CardFieldAnswer>): Record<string, CardFieldAnswer> {
	const keep: Record<string, CardFieldAnswer> = {};
	for (const f of pc.card.fields) if (local[f.id] && fits(f, local[f.id]!)) keep[f.id] = local[f.id]!;
	const server = seedAll(pc);
	const out: Record<string, CardFieldAnswer> = { ...keep };
	for (const f of pc.card.fields) {
		const s = server[f.id];
		if (!s) continue;
		if (!out[f.id] || (pc.draft && pc.draft[f.id])) out[f.id] = s;
	}
	return out;
}
