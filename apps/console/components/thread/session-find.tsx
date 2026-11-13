"use client";


export const SESSION_FIND_HIGHLIGHT = "wp-session-find";
export const SESSION_FIND_ACTIVE_HIGHLIGHT = "wp-session-find-active";

/** ::highlight() rules live OUTSIDE globals.css on purpose: the PostCSS/
 *  Tailwind v4 pipeline rejects the Custom Highlight pseudo-element as a
 *  parse error, which downed the whole stylesheet. A tiny <style> element,
 *  injected once on first client mount, ships them verbatim. */
const FIND_STYLE_ID = "wp-session-find-style";
export function injectFindStyles(): void {
	if (document.getElementById(FIND_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = FIND_STYLE_ID;
	style.textContent = `
::highlight(${SESSION_FIND_HIGHLIGHT}) { background-color: color-mix(in oklab, var(--primary) 25%, transparent); }
::highlight(${SESSION_FIND_ACTIVE_HIGHLIGHT}) { background-color: var(--primary); color: var(--primary-foreground); }`;
	document.head.appendChild(style);
}

export function clearSessionFindHighlights(): void {
	if (typeof CSS === "undefined") return;
	CSS.highlights?.delete(SESSION_FIND_HIGHLIGHT);
	CSS.highlights?.delete(SESSION_FIND_ACTIVE_HIGHLIGHT);
}

function publishHighlights(ranges: readonly Range[], index: number): void {
	if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
	// Avoid a huge argument spread when a short query matches many times.
	const all = new Highlight();
	for (const range of ranges) all.add(range);
	CSS.highlights.set(SESSION_FIND_HIGHLIGHT, all);
	const active = new Highlight();
	active.priority = 1;
	if (ranges[index]) active.add(ranges[index]!);
	CSS.highlights.set(SESSION_FIND_ACTIVE_HIGHLIGHT, active);
}

/** One-Esc law: a surfaced menu/dialog/cheat sheet outranks this non-modal
 * bar, regardless of where focus happened to be left. Closed Radix exits
 * must not block Find once they have stopped being a surfaced layer. */
export function sessionFindHasForegroundLayer(doc: Document): boolean {
	return Array.from(doc.querySelectorAll(
		'[data-wp-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"], [data-testid="cheat-sheet"]',
	)).some((element) => {
		if (element.getAttribute("data-state") === "closed" || element.hasAttribute("hidden")) return false;
		const view = doc.defaultView;
		if (typeof view?.getComputedStyle !== "function") return true;
		const style = view.getComputedStyle(element);
		return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
	});
}

