/**
 * Private view (work-wolfpack-xH0rRtw): one pure set of helpers shared by the node cards, the overlay hover/pin cards, the activity feed
 * and the canvas label pass. When `priv` is true personal text (titles, summaries, section/domain names) is replaced; the structure
 * (kind, stage, wolf names, counts) stays so the graph still reads as a picture of what the pack is doing.
 */
export const REDACTED = "•••";

/** The text, or the redaction mark when private. Empty text stays empty. */
export function redact(text: string, priv: boolean): string;
export function redact(text: string | undefined, priv: boolean): string | undefined;
export function redact(text: string | undefined, priv: boolean): string | undefined {
	return priv && text ? REDACTED : text;
}

/** Canvas label lines: when private, a row of dots per line (same length, so labels keep their footprint; the canvas blurs them). */
export function redactLines(lines: string[], priv: boolean): string[] {
	return priv ? lines.map((l) => "•".repeat(l.length)) : lines;
}

interface CardLinkLike {
	id: string;
	label: string;
}
interface CardLike {
	title: string;
	summary?: string;
	domain?: { name: string; label: string };
	section?: { id: string; label: string };
	parent: CardLinkLike | null;
	dependencies: CardLinkLike[];
	openHref?: string;
}

/** A node detail card with every personal string redacted and the "Open" link dropped (it would open the real page). */
export function redactCard<T extends CardLike>(card: T, priv: boolean): T {
	if (!priv) return card;
	const link = (l: CardLinkLike): CardLinkLike => ({ ...l, label: REDACTED });
	return {
		...card,
		title: REDACTED,
		summary: redact(card.summary, true),
		domain: card.domain ? { ...card.domain, label: REDACTED } : undefined,
		section: card.section ? { ...card.section, label: REDACTED } : undefined,
		parent: card.parent ? link(card.parent) : null,
		dependencies: card.dependencies.map(link),
		openHref: undefined,
	};
}
