/** How the Prompts reader shows a prompt, by type. Pure: no DOM, no fetch. */

export type ReaderMode = "profile" | "template" | "composed" | "markdown";

/** profile: frontmatter strip + markdown body; template (a pipeline prompt with `{{var}}`): chips; composed: the resolved block, with an edit link; markdown: the rest. */
export function readerModeOf(row: { id: string; kind?: string; text: string }): ReaderMode {
	if (row.id.startsWith("agent.")) return "profile";
	if (row.kind === "system-block") return "composed";
	if (row.kind === "pipeline" && /\{\{\s*\w+\s*\}\}/.test(row.text)) return "template";
	return "markdown";
}

export type VarSegment = { text: string } | { variable: string };

/** The text split at `{{var}}` placeholders, in order. */
export function splitVars(text: string): VarSegment[] {
	const out: VarSegment[] = [];
	let last = 0;
	for (const m of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
		if (m.index > last) out.push({ text: text.slice(last, m.index) });
		out.push({ variable: m[1]! });
		last = m.index + m[0].length;
	}
	if (last < text.length) out.push({ text: text.slice(last) });
	return out;
}

/** A leading `---` block as key/value pairs, and the body after it. No block: no fields, the text as is. */
export function parseFrontmatter(text: string): { fields: Array<[string, string]>; body: string } {
	const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!m) return { fields: [], body: text };
	const fields: Array<[string, string]> = [];
	for (const line of m[1]!.split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) fields.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
	}
	return { fields, body: text.slice(m[0].length).replace(/^\n+/, "") };
}
