/**
 * One cohesive document for a work item view: Done when → the item's own
 * working document → Record, under a single heading hierarchy (## sections,
 * ### inside them). Pure; callers render the string with KbMarkdown.
 */
import type { WorkRecordResponse } from "./kb.ts";

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const ROLLUP_MARKER = /<!--\s*\/?\s*rollup[^>]*-->/g;
const MAX_DOC_LEVEL = 4;

/** Line classes with fenced code left alone: a heading line carries its level. */
function classify(lines: string[]): { level: number; text: string }[] {
	let fence: string | null = null;
	return lines.map((line) => {
		const f = FENCE.exec(line);
		if (f) {
			if (fence === null) fence = f[1] ?? "";
			else if (fence === f[1]) fence = null;
			return { level: 0, text: line };
		}
		const h = fence === null ? HEADING.exec(line) : null;
		return h ? { level: (h[1] ?? "").length, text: h[2] ?? "" } : { level: 0, text: line };
	});
}

/** Drop headings whose section (to the next heading of the same or higher level) has no body text, nested ones included. */
function dropEmptySections(lines: string[]): string[] {
	const levels = classify(lines).map((x) => x.level);
	const keep = lines.map(() => true);
	for (let i = 0; i < lines.length; i++) {
		const L = levels[i] ?? 0;
		if (!L) continue;
		let hasContent = false;
		for (let j = i + 1; j < lines.length; j++) {
			const lj = levels[j] ?? 0;
			if (lj && lj <= L) break;
			if (!lj && (lines[j] ?? "").trim()) {
				hasContent = true;
				break;
			}
		}
		if (!hasContent) keep[i] = false;
	}
	return lines.filter((_, i) => keep[i]);
}

/** Shift headings so the shallowest becomes `top` (deepest allowed: `max`). */
function normaliseHeadings(lines: string[], top: number, max: number): string[] {
	const c = classify(lines);
	const levels = c.map((x) => x.level).filter(Boolean);
	if (levels.length === 0) return lines;
	const shift = top - Math.min(...levels);
	return lines.map((line, i) => {
		const h = c[i];
		return h && h.level ? `${"#".repeat(Math.min(max, Math.max(1, h.level + shift)))} ${h.text}` : line;
	});
}

function tidy(lines: string[]): string {
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function clean(md: string, top: number, max: number, stripTitle: boolean): string {
	let lines = md.replace(ROLLUP_MARKER, "").split("\n");
	if (stripTitle) {
		const first = lines.findIndex((l) => l.trim());
		if (first >= 0 && /^#\s+/.test(lines[first] ?? "")) lines = lines.slice(first + 1);
	}
	return tidy(normaliseHeadings(dropEmptySections(lines), top, max));
}

/** The Record to show: its text, and the parent feature's title when it was inherited from it. */
export interface ItemRecord {
	record: string;
	inheritedFrom: { title: string } | null;
}

export function composeItemDocument(
	item: Pick<WorkRecordResponse, "plan" | "successCriteria">,
	rec: ItemRecord | null,
): string {
	const parts: string[] = [];
	const done = item.successCriteria?.trim();
	if (done) parts.push(`## Done when\n\n${done}`);
	const doc = clean(item.plan, 2, MAX_DOC_LEVEL, true);
	if (doc) parts.push(doc);
	const record = rec ? clean(rec.record, 3, MAX_DOC_LEVEL + 1, false) : "";
	if (record) parts.push(`## Record${rec!.inheritedFrom ? ` — from ${rec!.inheritedFrom.title}` : ""}\n\n${record}`);
	return parts.join("\n\n");
}
