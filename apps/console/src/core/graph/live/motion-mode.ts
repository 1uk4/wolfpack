/**
 * The one motion-mode input of the live map (work-wolfpack-B473jD5). The 'Live map motion' setting is `follow` (default: obey the
 * OS Reduce motion switch) or `always` (animate regardless). The overlay and the canvas both ask here; nothing else reads matchMedia
 * for motion. Under reduced motion nothing MOVES (no wander, orbit, float, trails, launch), but state effects (working, loading and
 * needs-you rings) keep running as fades.
 */

export type MotionMode = "follow" | "always";

export function sanitizeMotionMode(v: unknown): MotionMode {
	return v === "always" ? "always" : "follow";
}

/** Does the OS ask for reduced motion right now? Read live; false off the browser. */
export function osPrefersReducedMotion(): boolean {
	return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Movement is off: the setting follows the system and the system asks for reduced motion. */
export function isMotionReduced(mode: MotionMode, osReduced: boolean = osPrefersReducedMotion()): boolean {
	return mode === "follow" && osReduced;
}
