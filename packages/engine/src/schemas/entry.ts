/**
 * Knowledge entry schema — a curated piece of knowledge in the KB.
 * Used at both wolf tier (den topic files) and pack tier (KB entries).
 */
import { z } from "zod";

/**
 * Controlled vocabulary for a KB entry's document kind. Strict on purpose —
 * a loose `type` is the #1 source of frontmatter drift. When nothing fits,
 * the model MUST pick `other` and put its preferred word in `tag` (see below).
 * Review accumulated `tag` values periodically and promote recurring ones into
 * this enum manually.
 */
export const ENTRY_TYPES = [
  "architecture", // how a system is built / how parts fit together
  "reference", // lookup material: inventories, indexes, master references
  "overview", // high-level orientation / product or platform summary
  "api", // API surface, routes, contracts
  "changelog", // timelines, changelogs, point-in-time snapshots
  "decision", // a settled choice + rationale (ADR-like)
  "process", // runbooks, workflows, how-to procedures
  "fact", // a discrete, durable fact
  "policy", // legal, terms, privacy, governance
  "product", // product/marketing/community/ASO material
  "incident", // bugs, outages, postmortems
  "other", // escape hatch — REQUIRES `tag`
] as const;

export const EntryTypeSchema = z.enum(ENTRY_TYPES);
export type EntryType = (typeof ENTRY_TYPES)[number];

export const EntryFrontmatterSchema = z.object({
  id: z.string().describe("Stable unique identifier, e.g. kb-snapjack-abc123"),
  title: z.string(),
  type: EntryTypeSchema.describe(
    "Document kind — one of the controlled ENTRY_TYPES. Use `other` + `tag` when none fit."
  ),
  tag: z
    .string()
    .optional()
    .describe(
      "Optional kebab-case refinement of `type`. REQUIRED when type=other: your preferred word for this document kind. Staging ground for future enum values."
    ),
  domain: z.string(),
  subcategory: z.string().optional(),
  status: z.enum(["active", "superseded", "expired", "draft"]).default("active"),
  authority: z.enum(["claim", "curated"]).default("claim"),
  confidence: z.enum(["low", "medium", "high", "verified"]).default("medium"),
  related: z
    .array(z.string())
    .default([])
    .describe("IDs of related entries — the link graph"),
  supersedes: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  created: z.string(),
  updated: z.string(),
  expires: z.string().optional(),
  /** The source date this entry's knowledge is current as of (crawl/historical). */
  asOf: z.string().optional(),
  /** True when the entry is historical (archived crawl); readers treat as past. */
  historical: z.boolean().default(false),
});

export type EntryFrontmatter = z.infer<typeof EntryFrontmatterSchema>;

/**
 * Full entry — frontmatter + body sections.
 */
export const EntrySchema = z.object({
  frontmatter: EntryFrontmatterSchema,
  summary: z.string().describe("One paragraph, what this entry says"),
  detail: z.string().describe("Full content"),
  context: z.string().optional().describe("Why this matters, background"),
});

export type Entry = z.infer<typeof EntrySchema>;
