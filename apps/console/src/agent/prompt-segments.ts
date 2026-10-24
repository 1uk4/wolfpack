/**
 * THE canonical prompt-segment discovery + override resolution. The agent
 * layer owns it because composition lives here: composeInstructions
 * (assistant-agent.ts) composes through effectivePromptSegments.
 *
 * The architecture law pins the layout: the agent layer never imports the
 * store adapters, so the override-file READ lives here too; the
 * override-file CRUD (write/delete/list) stays in src/store/prompt-overrides.ts.
 * Both sides share the pure path grammar (src/core/prompt-segments.ts).
 *
 * SEGMENTS: the assistant has ONE source segment, src/agent/system-prompt.md.
 * An override keyed to a segment the source no longer ships stops composing
 * automatically.
 *
 * OVERRIDES: override files mirror the source layout under
 * config.PROMPTS_OVERRIDE_DIR. File presence is NOT the override: the
 * settings SWITCH is — the user keeps their file and flips back to the
 * source default to compare.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS, PROMPTS_OVERRIDE_DIR } from "../../config.ts";
import { isValidSegmentPath, type PromptAgent, type PromptSegmentInfo } from "../core/prompt-segments.ts";

/** Absolute path for an override file (unchecked — validate first). */
function overrideFileFor(segmentPath: string): string {
	return path.join(PROMPTS_OVERRIDE_DIR, ...segmentPath.split("/"));
}

/** Read one override file, or null when absent/invalid — the composition
 *  side's reader (the store's readOverride is the same mirror layout,
 *  kept separate because the layers may not import each other). */
export function readPromptOverride(segmentPath: string): string | null {
	if (!isValidSegmentPath(segmentPath)) return null;
	try {
		return fs.readFileSync(overrideFileFor(segmentPath), "utf-8");
	} catch {
		return null;
	}
}

/** List the SOURCE segments for one agent, in composition order. */
export function listSourceSegments(_agent: PromptAgent): Array<{ path: string; shared: boolean; file: string }> {
	return [{ path: "system-prompt.md", shared: true, file: PATHS.systemPrompt }];
}

/**
 * The effective segment view for one agent — every segment with its source
 * text, override text, and effective switch state. `switches` is the
 * settings record's agent.prompts map (absent key = off); enabled =
 * switch on AND the override file exists.
 */
export function effectivePromptSegments(
	agent: PromptAgent,
	switches: Record<string, boolean>,
): PromptSegmentInfo[] {
	return listSourceSegments(agent).map((segment) => {
		let sourceText: string;
		try {
			sourceText = fs.readFileSync(segment.file, "utf-8");
		} catch {
			sourceText = ""; // source unreadable — the agent loader would crash anyway
		}
		const overrideText = readPromptOverride(segment.path);
		return {
			path: segment.path,
			sourceText,
			overrideText,
			enabled: switches[segment.path] === true && overrideText !== null,
			shared: segment.shared,
		};
	});
}

/** Every known segment path (route validation). */
export function allSegmentPaths(): string[] {
	return listSourceSegments("assistant").map((segment) => segment.path);
}
