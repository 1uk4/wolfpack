/**
 * Answer hook of the `task_graduate` card (work-wolfpack-zoeLko9). The wolf never graduates: when the owner submits the card,
 * the console graduates each picked item with the owner's login (preview from the wolf, then graduate-direct), and the
 * card's normal answer then goes back to the wolf with a note saying what happened.
 *
 * The note is for humans and the model's first read of the outcome; it is not proof. The wolf's `task_graduate reconcile`
 * call asks the hub which items really graduated.
 *
 * Trust: the wolf is always the thread's own wolf (the one whose session raised the card), never `card.meta.wolf` alone;
 * a card that names another wolf graduates nothing. Only ids the card itself offered can be graduated.
 */
import { getPendingPreview, graduateDirect } from "./graduate-direct-client";

export const GRADUATE_CARD_TOOL = "task_graduate";
// Two at a time: each graduation is an owner-approved write on the hub plus a preview read from the wolf, so the console
// stays gentle on the hub. The wolf side distills three at a time because that is model work, not hub writes.
const PARALLEL = 2;

export interface GraduateCardDeps {
	getPendingPreview: typeof getPendingPreview;
	graduateDirect: typeof graduateDirect;
}

const real: GraduateCardDeps = { getPendingPreview, graduateDirect };

/** The picked ids of a submitted task_graduate card's answers (`{picked: {value: string[]}}`). */
export function pickedOf(answers: Record<string, unknown>): string[] {
	const v = (answers.picked as { value?: unknown } | undefined)?.value;
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export interface GraduatePickedInput {
	/** The thread's own wolf: the one whose session raised the card. Always the wolf used. */
	wolf: string;
	/** `card.meta.wolf`, when present; a different wolf refuses the whole graduation. */
	cardWolf?: string;
	/** The option values the card offered. */
	offered: readonly string[];
	picked: readonly string[];
}

/**
 * Graduate every picked item, at most two at once; one failure never stops the others. Returns the note for the wolf
 * ("Graduated: … Failed: <id>: <reason> … Expired: …"), or "" when nothing was picked. An item the hub says is already
 * graduated counts as graduated.
 */
export async function graduatePicked(input: GraduatePickedInput, deps: GraduateCardDeps = real): Promise<string> {
	const { wolf, cardWolf, offered, picked } = input;
	if (!picked.length) return "";
	if (cardWolf !== undefined && cardWolf !== wolf) return `Graduation refused: card wolf mismatch (card says ${cardWolf}, this thread is ${wolf}). Nothing was graduated.`;
	const ok = picked.filter((id) => offered.includes(id));
	const ignored = picked.filter((id) => !offered.includes(id));
	const graduated: string[] = [];
	const failed: string[] = [];
	const expired: string[] = [];
	// The workers share this counter on purpose: `next++` runs synchronously between awaits, so each id is taken exactly once.
	let next = 0;
	const one = async (id: string) => {
		try {
			const p = await deps.getPendingPreview(wolf, id);
			if (!p.ok) return void failed.push(`${id}: ${p.message}`);
			if ("none" in p) return void expired.push(id);
			const r = await deps.graduateDirect(id, { contributions: p.preview.contributions, ...(p.preview.summary ? { summary: p.preview.summary } : {}), via: "card", wolf });
			if (r.ok || r.alreadyGraduated) graduated.push(id);
			else failed.push(`${id}: ${r.message}`);
		} catch (err) {
			failed.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	const worker = async () => {
		for (let id = ok[next++]; id !== undefined; id = ok[next++]) await one(id);
	};
	await Promise.all(Array.from({ length: Math.min(PARALLEL, ok.length) }, worker));
	const parts: string[] = [];
	if (graduated.length) parts.push(`Graduated: ${graduated.join(", ")}.`);
	if (failed.length) parts.push(`Failed: ${failed.join("; ")}.`);
	if (expired.length) parts.push(`Expired (the preview is gone, prepare it again): ${expired.join(", ")}.`);
	if (ignored.length) parts.push(`Not offered on this card, ignored: ${ignored.join(", ")}.`);
	return parts.join(" ");
}

/** The note for a submitted task_graduate card. Never throws: any failure of the step becomes the note. */
export async function graduationNoteFor(card: { fields: { id: string; options?: { value: string }[] }[]; meta?: { wolf?: unknown } }, answers: Record<string, unknown>, threadWolf: string, deps: GraduateCardDeps = real): Promise<string> {
	try {
		const offered = card.fields.find((f) => f.id === "picked")?.options?.map((o) => o.value) ?? [];
		const cardWolf = typeof card.meta?.wolf === "string" ? card.meta.wolf : undefined;
		return await graduatePicked({ wolf: threadWolf, cardWolf, offered, picked: pickedOf(answers) }, deps);
	} catch (err) {
		return `graduation step failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}
