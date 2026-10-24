/**
 * The prompt-override STORE (settings-storage wave, 2026-09-19; P2
 * reconciliation same day): the override-file CRUD behind the core port —
 * list/read/write/delete under config.PROMPTS_OVERRIDE_DIR.
 *
 * The CANONICAL segment discovery + resolution (listSourceSegments,
 * effectivePromptSegments, allSegmentPaths) lives in the agent layer
 * (src/agent/prompt-segments.ts) — composition is an agent concern, and
 * the architecture law pins the layers apart (store may not import agent;
 * agent may not import store). Both sides share the pure path grammar
 * (src/core/prompt-segments.ts); the store's readOverride and the agent's
 * readPromptOverride read the SAME mirror layout.
 *
 * SEGMENTS: a prompt composes from the SHARED base
 * (src/agent/system-prompt.md), the shared/ fragments (composed by both
 * agents), plus every numeric-prefix *.md fragment in the agent's own
 * directory — see the agent module for the full rules.
 *
 * OVERRIDES: override files mirror the source layout under
 * config.PROMPTS_OVERRIDE_DIR — "system-prompt.md" at the root,
 * "shared/<file>", "teacher/<file>" / "prober/<file>" (POSIX-relative
 * paths, the same keys as the settings record's agent.prompts switches).
 * File presence is NOT the override: the switch is (owner decision) — the
 * user keeps their file and flips back to the source default to compare.
 *
 * Path discipline: only .md under the override dir, no traversal (no "..",
 * absolute, or empty segments) — a hand-crafted path outside the mirror
 * layout is rejected (null / no-op), never written.
 */
import type { PromptOverrideStore } from "../core/ports.ts";
/** The store adapter (core/ports.ts). */
export declare const promptOverrides: PromptOverrideStore;
//# sourceMappingURL=prompt-overrides.d.ts.map