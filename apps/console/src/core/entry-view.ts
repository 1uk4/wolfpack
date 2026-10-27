/**
 * Pure view model for the KB entry reader: [[wikilink]] rewriting, the
 * frontmatter facts shown in the header, related links and backlinks grouped
 * by `via`. Browser-safe; the reader component is a thin shell over these.
 */
import { entryHref } from "./kb.ts";
import type { KbEntryDetail } from "./kb.ts";

/** href of an unresolved wikilink; the reader renders it as a muted span, not a link. */
export const UNRESOLVED_HREF = "#kb-unresolved";

export interface ParsedWikilink {
	target: string;
	heading?: string;
	alias?: string;
}

/** `target`, `target|alias`, `target#heading`, `target#heading|alias` (the text between the brackets). */
export function parseWikilink(inner: string): ParsedWikilink | null {
	const pipe = inner.indexOf("|");
	const head = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
	const alias = pipe === -1 ? undefined : inner.slice(pipe + 1).trim();
	const hash = head.indexOf("#");
	const target = (hash === -1 ? head : head.slice(0, hash)).trim();
	const heading = hash === -1 ? undefined : head.slice(hash + 1).trim();
	if (!target) return null;
	return {
		target,
		...(heading ? { heading } : {}),
		...(alias ? { alias } : {}),
	};
}

/** GitHub-style heading slug (the anchor ids the markdown renderer emits). */
export function headingSlug(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s+/g, "-");
}

const escapeLabel = (s: string) => s.replace(/([\\[\]])/g, "\\$1");

/**
 * Rewrite [[wikilinks]] in a markdown body into ordinary links: existing
 * targets point at entryHref (+ #heading slug), the rest at UNRESOLVED_HREF.
 * Fenced code blocks and inline code spans are left untouched.
 */
export function rewriteWikilinks(body: string, wikilinks: readonly { target: string; exists: boolean }[]): string {
	const exists = new Map(wikilinks.map((w) => [w.target, w.exists]));
	const convert = (text: string) =>
		text.replace(/\[\[([^\[\]\n]+?)\]\]/g, (whole, inner: string) => {
			const w = parseWikilink(inner);
			if (!w) return whole;
			const label = escapeLabel(w.alias ?? (w.heading ? `${w.target} › ${w.heading}` : w.target));
			if (!exists.get(w.target)) return `[${label}](${UNRESOLVED_HREF})`;
			const frag = w.heading ? `#${headingSlug(w.heading)}` : "";
			return `[${label}](${entryHref(w.target)}${frag})`;
		});
	const out: string[] = [];
	let fence: string | null = null;
	for (const line of body.split("\n")) {
		const m = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) {
			if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
			out.push(line);
		} else if (m) {
			fence = m[1];
			out.push(line);
		} else {
			// split on inline code spans; convert only the prose between them
			out.push(line.split(/(`+[^`]*`+)/).map((seg, i) => (i % 2 ? seg : convert(seg))).join(""));
		}
	}
	return out.join("\n");
}

export interface EntryFact {
	key: "kind" | "maturity" | "authority" | "currency";
	value: string;
}

const scalar = (v: unknown): string | null => {
	if (typeof v === "string") return v.trim() || null;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return null;
};

/** The frontmatter keys the reader surfaces, in display order; absent ones are skipped. */
export function entryFacts(frontmatter: Record<string, unknown>): EntryFact[] {
	const out: EntryFact[] = [];
	const kind = scalar(frontmatter.kind) ?? scalar(frontmatter.type) ?? scalar(frontmatter.entryKind);
	if (kind) out.push({ key: "kind", value: kind });
	for (const key of ["maturity", "authority", "currency"] as const) {
		const v = scalar(frontmatter[key]);
		if (v) out.push({ key, value: v });
	}
	return out;
}

export interface EntryCrumb {
	label: string;
	kind: "domain" | "section";
}

/** domain › section (section from frontmatter when the entry names one). */
export function entryBreadcrumb(entry: Pick<KbEntryDetail, "domain" | "frontmatter">): EntryCrumb[] {
	const crumbs: EntryCrumb[] = [{ label: entry.domain, kind: "domain" }];
	const section = scalar(entry.frontmatter.section) ?? scalar(entry.frontmatter.topic);
	if (section) crumbs.push({ label: section, kind: "section" });
	return crumbs;
}

export interface RelatedLink {
	target: string;
	relation: string;
}

/** Outgoing `related:` / `relations:` frontmatter (strings or {target, kind|rel}), de-duplicated. */
export function entryRelated(frontmatter: Record<string, unknown>): RelatedLink[] {
	const out: RelatedLink[] = [];
	const seen = new Set<string>();
	for (const key of ["relations", "related"]) {
		const v = frontmatter[key];
		if (!Array.isArray(v)) continue;
		for (const r of v) {
			let target: string | null = null;
			let relation = "see_also";
			if (typeof r === "string") target = r;
			else if (r && typeof r === "object") {
				const o = r as Record<string, unknown>;
				target = scalar(o.target);
				relation = scalar(o.kind) ?? scalar(o.rel) ?? relation;
			}
			if (!target) continue;
			const k = `${target}\0${relation}`;
			if (seen.has(k)) continue;
			seen.add(k);
			out.push({ target, relation });
		}
	}
	return out;
}

export interface BacklinkGroup {
	via: "wikilink" | "related";
	items: KbEntryDetail["backlinks"];
}

/** Backlinks grouped by `via` (wikilink first), empty groups dropped; server order kept within a group. */
export function groupBacklinks(backlinks: KbEntryDetail["backlinks"]): BacklinkGroup[] {
	return (["wikilink", "related"] as const)
		.map((via) => ({ via, items: backlinks.filter((b) => b.via === via) }))
		.filter((g) => g.items.length > 0);
}
