/** The short question label shown in "Replying to: …" (markdown stripped: links keep their text, images go; one line, cut at 40). Kept apart from ask-sheet.tsx so the eager bar does not pull the sheet in. */
export const replyLabel = (f: { label: string }): string => {
	const t = f.label
		.replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, "")
		.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
		.replace(/[*_`#>\[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > 40 ? `${t.slice(0, 39)}…` : t;
};
