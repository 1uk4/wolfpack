/**
 * Mermaid → PlanTree authoring format (the author-once protocol, 2026-09-03;
 * free-form pass 2026-09-11 — the muscle-protein session post-mortem: four
 * failed plan_init calls over ids the parser silently hated).
 *
 * The teacher writes the session map as a mermaid block — the format models
 * are most fluent in — and plan_init canonicalizes it into the structured
 * PlanTree. Hand-parsed subset: deterministic, dependency-free, precise
 * line-numbered errors the teacher can act on (the same validate-and-retry
 * loop as the question schemas). Not the mermaid runtime — the server never
 * renders, it only needs the graph.
 *
 * THE ONE STRICT RULE: node ids are permanent slugs the teacher references
 * via quiz nodeId — lowercase words (a-z, 0-9) joined by hyphens OR
 * underscores (`chain-rule-intuition`, `mps_translation`). Everything else
 * is as free-form as mermaid allows:
 *   graph|flowchart TD|TB|LR|RL|BT   (direction is cosmetic — we layout
 *                                     ourselves; case-insensitive)
 *   %% comment lines
 *   node            — bare id (title falls back to the id)
 *   id[title]       — square-bracket label; any single-line title, a
 *                     surrounding "…" pair is stripped
 *   id("title")     — paren label
 *   a --> b         — requires edge (from = prerequisite); ==>, -.-> are
 *                     synonyms; chains a --> b --> c expand to pairs
 *   a[title] --> b[title] — inline labels anywhere an endpoint appears
 * Bare endpoints register as nodes; forward references are fine; duplicate
 * edges dedupe; the first label a node gets wins.
 */
import type { PlanEdge, PlanNode } from "@/src/core";
export interface ParsedPlan {
    nodes: PlanNode[];
    edges: PlanEdge[];
}
export interface PlanParseResult {
    ok: boolean;
    /** All problems, each prefixed with its 1-based line number. */
    problems: string[];
    plan?: ParsedPlan;
}
/** Parse the mermaid subset. Collects ALL problems (never just the first). */
export declare function parseMermaidPlan(mermaid: string): PlanParseResult;
//# sourceMappingURL=mermaid-plan.d.ts.map