/**
 * Full work item ids in message markdown. Owner standard: agents always write `work-<domain>-<id>` (id = 7
 * alphanumerics); only full ids are linked, a bare short id stays text.
 *
 * `linkifyWorkIds` rewrites full ids in PLAIN TEXT into markdown links to a marker URL that the `a` override in
 * md-blocks turns into a chip. Fenced code (also inside blockquotes and list items), indented code blocks, existing
 * inline code (the `code` override handles those), link labels/destinations, autolinks and URLs are left alone.
 *
 * False-positive guards: only the known domains; the id part is exactly 7 alphanumerics at a word boundary, is not
 * followed by `.<letter>` (a file name), and is not all lowercase letters (real ids are random base62, so
 * `work-wolfpack-section` is a slug, not an id).
 */

/** The work domains an id can name (the KB's configured domains; keep in step with the wolves' config). */
export const WORK_DOMAINS = ["personal", "snapjack", "wolfpack"] as const;

const DOMAIN_ALT = WORK_DOMAINS.join("|");
export const WORK_ID_SOURCE = `work-(?:${DOMAIN_ALT})-[0-9A-Za-z]{7}`;
const EXACT = new RegExp(`^${WORK_ID_SOURCE}$`);
const IN_TEXT = new RegExp(`(?<![\\w/.:@#-])${WORK_ID_SOURCE}(?![\\w-])(?!\\.[A-Za-z])`, "g");

/** Marker origin of a rewritten id link. */
export const WORK_LINK_PREFIX = "https://work-item.invalid/";

/** The 7-char id part is random base62: an all-lowercase-letters one is a word, not an id. */
const looksRandom = (id: string): boolean => !/^[a-z]{7}$/.test(id.slice(id.length - 7));

export const isFullWorkId = (s: string): boolean => EXACT.test(s) && looksRandom(s);
/** `work-wolfpack-cEg92qS` → `cEg92qS`. */
export const shortWorkId = (id: string): string => id.slice(id.length - 7);
/** `work-wolfpack-cEg92qS` → `wolfpack`. */
export const workIdDomain = (id: string): string => id.slice("work-".length, id.length - 8);
/** The full id behind a rewritten link href, or null (also for a malformed escape). */
export function workIdFromHref(href: string | undefined): string | null {
	if (!href?.startsWith(WORK_LINK_PREFIX)) return null;
	let id: string;
	try {
		id = decodeURIComponent(href.slice(WORK_LINK_PREFIX.length));
	} catch {
		return null;
	}
	return isFullWorkId(id) ? id : null;
}

// Spans never rewritten, in priority order: inline code, link/image syntax, autolinks, bare URLs.
const SKIP = /(`+)[\s\S]*?\1|!?\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])?|<[^>\n]+>|https?:\/\/[^\s<>)]+/g;

function linkifyText(text: string): string {
	let out = "";
	let last = 0;
	const rewrite = (s: string) => s.replace(IN_TEXT, (id) => (looksRandom(id) ? `[${shortWorkId(id)}](${WORK_LINK_PREFIX}${encodeURIComponent(id)})` : id));
	for (const m of text.matchAll(SKIP)) {
		out += rewrite(text.slice(last, m.index)) + m[0];
		last = m.index! + m[0].length;
	}
	return out + rewrite(text.slice(last));
}

// A fence line: optional blockquote markers / one list marker / indentation, then 3+ backticks or tildes.
const FENCE = /^[ \t>]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(`{3,}|~{3,})/;
const LIST_ITEM = /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]/;
const INDENTED = /^(?: {4}|\t)/;

export function linkifyWorkIds(markdown: string): string {
	if (!markdown.includes("work-")) return markdown;
	const out: string[] = [];
	let fence: { ch: string; len: number } | null = null;
	let buf: string[] = [];
	const flush = () => {
		if (buf.length) out.push(linkifyText(buf.join("\n")));
		buf = [];
	};
	let prevBlank = true;
	let inList = false;
	let indentedCode = false;
	for (const line of markdown.split("\n")) {
		const m = FENCE.exec(line);
		const blank = line.trim() === "";
		if (fence) {
			out.push(line);
			if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && /^[ \t>]*(?:[-*+]|\d+[.)])?[ \t]*[`~]+\s*$/.test(line)) fence = null;
			prevBlank = false;
			continue;
		}
		if (m) {
			flush();
			out.push(line);
			fence = { ch: m[1]![0]!, len: m[1]!.length };
			prevBlank = false;
			indentedCode = false;
			continue;
		}
		// Indented code: 4+ spaces after a blank line (or the start), outside a list; blank lines inside it stay code.
		if (!blank && INDENTED.test(line) && !inList && (prevBlank || indentedCode)) {
			flush();
			out.push(line);
			indentedCode = true;
			prevBlank = false;
			continue;
		}
		if (blank && indentedCode) {
			flush();
			out.push(line);
			prevBlank = true;
			continue;
		}
		indentedCode = false;
		if (!blank && !INDENTED.test(line)) inList = LIST_ITEM.test(line) || (inList && /^[ \t]/.test(line));
		if (blank) {
			prevBlank = true;
		} else prevBlank = false;
		buf.push(line);
	}
	flush();
	return out.join("\n");
}
