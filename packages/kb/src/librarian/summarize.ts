/**
 * summarize — confined section-summary LLM call for crystallize + digest.
 */
import type { Engine } from "@wolfpack/engine";
import { SECTION_SUMMARY_SYSTEM, LABEL_SECTION_SYSTEM, SPLIT_SECTION_SYSTEM, HIERARCHY } from "@wolfpack/engine";
import { SectionSummarySchema, LabelSectionSchema, SplitSectionSchema } from "../shared/index.js";

/** One member entry of a section, as fed to sectionSummary. */
export interface SectionMember {
  title: string;
  summary?: string;
}

/**
 * Produce a one-line (≤140 chars) summary of a section from its member
 * entries' titles and summaries. Bounded input (caps members to
 * HIERARCHY.maxChildSummaries, and each member's summary to 200 chars).
 * Used by reorg; no ids/dates/structure emitted.
 */
export async function sectionSummary(
  engine: Engine,
  members: SectionMember[],
  opts?: { depth?: number; maxDepth?: number }
): Promise<string> {
  const bounded = members.slice(0, HIERARCHY.maxChildSummaries);
  const depthHint = opts?.depth !== undefined && opts?.maxDepth
    ? opts.depth === 0
      ? "\nThis is a TOP-LEVEL section. Write a BROAD, domain-level summary."
      : opts.depth <= 1
        ? "\nThis is a high-level grouping. Write a general thematic summary."
        : ""
    : "";

  const prompt = [
    "Entries in this section:",
    "",
    ...bounded.map((m, i) => {
      const summary = m.summary?.trim().slice(0, 200);
      return `${i + 1}. ${m.title}${summary ? ` — ${summary}` : ""}`;
    }),
    "",
    "Write the section's one-line summary (one sentence, at most 140 characters)." + depthHint,
  ].join("\n");

  const result = await engine.call("sectionSummary", SectionSummarySchema, {
    system: SECTION_SUMMARY_SYSTEM,
    prompt,
  });

  return result.summary;
}

/**
 * Produce a SHORT title for a section from its summary (+ a few sample member
 * titles). Confined labeling call; emits only a title, no ids/structure.
 */
export async function labelSection(
  engine: Engine,
  summary: string,
  context: { sampleTitles?: string[]; parentTitle?: string; siblingSummaries?: string[]; depth?: number; maxDepth?: number; domain?: string; forbiddenTitles?: string[] } = {}
): Promise<string> {
  const { sampleTitles = [], parentTitle, siblingSummaries = [], domain } = context;
  const bounded = sampleTitles.slice(0, HIERARCHY.maxChildSummaries);
  const sibs = siblingSummaries.slice(0, HIERARCHY.maxChildSummaries);
  const prompt = [
    domain ? `Domain: ${domain} (do NOT include this word as a prefix in the title)` : "",
    parentTitle ? `Parent section title: ${parentTitle}` : "",
    context.forbiddenTitles?.length ? `Do NOT title this section anything like: ${context.forbiddenTitles.map((t) => `"${t}"`).join(", ")}. Name what is specific to this group.` : "",
    sibs.length ? "Sibling sections (make THIS title distinct from these):" : "",
    ...sibs.map((s) => `- ${s}`),
    sibs.length || parentTitle || domain ? "" : "",
    "Section summary:",
    summary,
    bounded.length ? "\nSample member titles:" : "",
    ...bounded.map((t) => `- ${t}`),
    "",
    (context.depth === 0 ? "Produce a BROAD, domain-level title (2-4 words). This is the top-level section." : context.depth !== undefined && context.depth <= 1 ? "Produce a general thematic title (2-5 words) that covers the scope of this group." : "Produce a short, specific title that is distinct from the parent and siblings."),
  ].filter((line, i, arr) => line !== "" || (i > 0 && arr[i - 1] !== "")).join("\n");

  const result = await engine.call("labelSection", LabelSectionSchema, {
    system: LABEL_SECTION_SYSTEM,
    prompt,
  });

  return result.title;
}

/** One member of an oversized section, as fed to proposeSplit. */
export interface SplitMember { id: string; title: string; summary?: string }
/** The model's proposed division, by entry id. */
export interface SplitProposal { categories: Array<{ name: string; ids: string[] }>; doesntFit: string[] }

/**
 * Ask for 2-5 categories (plus a doesn't-fit bucket) for an oversized section. Deterministic inputs: members
 * in id order, one fixed prompt, no sampling parameters (Claude 5 rejects temperature). The caller caches the
 * answer by member set, so the same set is never asked twice.
 */
export async function proposeSplit(engine: Engine, parentTitle: string, members: SplitMember[]): Promise<SplitProposal> {
  const ordered = [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const prompt = [
    `Parent section: ${JSON.stringify(parentTitle || "(root of the domain)")}`,
    "",
    "Entries:",
    JSON.stringify(ordered.map((m) => ({ id: m.id, title: m.title, summary: m.summary?.trim().slice(0, 240) ?? "" }))),
  ].join("\n");
  const r = await engine.call("splitSection", SplitSectionSchema, { system: SPLIT_SECTION_SYSTEM, prompt });
  return { categories: r.categories.map((c) => ({ name: c.name.trim(), ids: c.ids })), doesntFit: r.doesnt_fit ?? [] };
}
