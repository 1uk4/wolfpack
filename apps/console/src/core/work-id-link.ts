/**
 * Full work item ids in message markdown. Owner standard: agents always write `work-<domain>-<id>` (id = 7
 * alphanumerics); only full ids are linked, a bare short id stays text.
 *
 * `linkifyWorkIds` rewrites full ids in PLAIN TEXT into markdown links to a marker URL that the `a` override in
 * md-blocks turns into a chip. Fenced code, existing inline code spans (the `code` override handles those), link
 * labels/destinations, autolinks and URLs are left alone.
 */

export const WORK_ID_SOURCE = "work-[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9A-Za-z]{7}";
const EXACT = new RegExp(`^${WORK_ID_SOURCE}$`);
const IN_TEXT = new RegExp(`(?<![\\w/.:@#-])(${WORK_ID_SOURCE})(?![\\w-])`, "g");

/** Marker origin of a rewritten id link. */
export const WORK_LINK_PREFIX = "https://work-item.invalid/";

export const isFullWorkId = (s: string): boolean => EXACT.test(s);
/** `work-wolfpack-cEg92qS` → `cEg92qS`. */
export const shortWorkId = (id: string): string => id.slice(id.length - 7);
/** `work-wolfpack-cEg92qS` → `wolfpack`. */
export const workIdDomain = (id: string): string => id.slice("work-".length, id.length - 8);
/** The full id behind a rewritten link href, or null. */
export function workIdFromHref(href: string | undefined): string | null {
	if (!href?.startsWith(WORK_LINK_PREFIX)) return null;
	const id = decodeURIComponent(href.slice(WORK_LINK_PREFIX.length));
	return isFullWorkId(id) ? id : null;
}

// Spans never rewritten, in priority order: inline code, link/image syntax, autolinks, bare URLs.
const SKIP = /(`+)[\s\S]*?\1|!?\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])?|<[^>\n]+>|https?:\/\/[^\s<>)]+/g;

function linkifyText(text: string): string {
	let out = "";
	let last = 0;
	const rewrite = (s: string) => s.replace(IN_TEXT, (id) => `[${shortWorkId(id)}](${WORK_LINK_PREFIX}${encodeURIComponent(id)})`);
	for (const m of text.matchAll(SKIP)) {
		out += rewrite(text.slice(last, m.index)) + m[0];
		last = m.index! + m[0].length;
	}
	return out + rewrite(text.slice(last));
}

export function linkifyWorkIds(markdown: string): string {
	if (!markdown.includes("work-")) return markdown;
	const lines = markdown.split("\n");
	const out: string[] = [];
	let fence: { ch: string; len: number } | null = null;
	let buf: string[] = [];
	const flush = () => {
		if (buf.length) out.push(linkifyText(buf.join("\n")));
		buf = [];
	};
	for (const line of lines) {
		const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			out.push(line);
			if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
		} else if (m) {
			flush();
			out.push(line);
			fence = { ch: m[1]![0]!, len: m[1]!.length };
		} else buf.push(line);
	}
	flush();
	return out.join("\n");
}
