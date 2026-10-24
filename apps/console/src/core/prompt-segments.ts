/**
 * The pure prompt-segment grammar: segment-path validation + the shared
 * segment types, ZERO fs. Discovery lives in the agent layer
 * (src/agent/prompt-segments.ts); the override-file CRUD lives in the store
 * adapter (src/store/prompt-overrides.ts). Both import THIS grammar so the
 * mirror-layout rules are defined exactly once.
 *
 * Path grammar: "system-prompt.md" (the base), "shared/<fragment>" /
 * "assistant/<fragment>" — where <fragment> is numeric-prefixed + .md
 * (e.g. 20-style.md). POSIX-relative, no traversal, no nesting.
 */

/** A prompt fragment: numeric order key + .md (e.g. 20-style.md). Nothing else loads. */
export const FRAGMENT_RE = /^\d+-[\w.-]+\.md$/;

/** Which agent's prompt to compose. */
export type PromptAgent = "assistant";

/** One segment of one agent's composed prompt. */
export interface PromptSegmentInfo {
	/** The override/store key — mirrors the source layout ("system-prompt.md"). */
	path: string;
	/** The source text (what the segment runs without an override). */
	sourceText: string;
	/** The user's override text, or null when no file exists on disk. */
	overrideText: string | null;
	/** Effective state: the settings switch AND the file both present. */
	enabled: boolean;
	/** True for segments every agent composes. */
	shared: boolean;
}

/** Validate a segment path against the mirror-layout rules (see module
 *  doc). Exported for the routes, which also check membership in the
 *  CURRENT source segment list. */
export function isValidSegmentPath(segmentPath: string): boolean {
	if (segmentPath === "system-prompt.md") return true;
	const m = /^(assistant|shared)\/([\w.-]+\.md)$/.exec(segmentPath);
	if (!m || m[2] === undefined) return false;
	return FRAGMENT_RE.test(m[2]);
}
