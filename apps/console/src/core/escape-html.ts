/**
 * Card text (questions, details, option labels) is authored by an agent as markdown, but tag-like text such as
 * `<button>` or `<Foo bar>` is meant literally. Markdown treats it as raw HTML, which the sanitiser then drops, leaving
 * an empty gap. `escapeRawHtml` turns the `<` of such tags into `&lt;` outside code spans and fences, so they render
 * as text; autolinks (`<https://x>`, `<a@b.c>`) are left alone, and inline/fenced code is untouched.
 */
const TAG_START = /<(?=[A-Za-z/!?])/g;
const AUTOLINK = /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/;
const FENCE = /^[ \t>]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(`{3,}|~{3,})/;

function escapeSegment(text: string): string {
	let out = "";
	let last = 0;
	for (const m of text.matchAll(TAG_START)) {
		const at = m.index!;
		if (AUTOLINK.test(text.slice(at))) continue;
		out += text.slice(last, at) + "&lt;";
		last = at + 1;
	}
	return out + text.slice(last);
}

/** Escape within a run of non-fence text, skipping inline code spans. */
function escapeOutsideSpans(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (text[i] === "`") {
			let n = 0;
			while (text[i + n] === "`") n++;
			const close = text.indexOf("`".repeat(n), i + n);
			if (close !== -1) {
				out += text.slice(i, close + n);
				i = close + n;
				continue;
			}
			out += text.slice(i, i + n);
			i += n;
			continue;
		}
		let j = text.indexOf("`", i);
		if (j === -1) j = text.length;
		out += escapeSegment(text.slice(i, j));
		i = j;
	}
	return out;
}

export function escapeRawHtml(markdown: string): string {
	if (!markdown.includes("<")) return markdown;
	let fence: { ch: string; len: number } | null = null;
	const buf: string[] = [];
	const out: string[] = [];
	const flush = () => {
		if (buf.length) out.push(escapeOutsideSpans(buf.join("\n")));
		buf.length = 0;
	};
	for (const line of markdown.split("\n")) {
		const m = FENCE.exec(line);
		if (fence) {
			out.push(line);
			if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len) fence = null;
			continue;
		}
		if (m) {
			flush();
			out.push(line);
			fence = { ch: m[1]![0]!, len: m[1]!.length };
			continue;
		}
		buf.push(line);
	}
	flush();
	return out.join("\n");
}
