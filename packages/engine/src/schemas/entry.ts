/**
 * Knowledge entry schema — a curated piece of knowledge in the KB.
 * Used at both wolf tier (den topic files) and pack tier (KB entries).
 */
import { z } from "zod";

export const EntryFrontmatterSchema = z.object({
  id: z.string().describe("Stable unique identifier, e.g. kb-snapjack-abc123"),
  title: z.string(),
  type: z.string().describe("fact, decision, bug, reference, architecture, etc."),
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
