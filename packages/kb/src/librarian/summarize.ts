/**
 * summarize — confined section-summary LLM call for crystallize + digest.
 */
import type { Engine } from "@wolfpack/engine";
import { SECTION_SUMMARY_SYSTEM, LABEL_SECTION_SYSTEM, HIERARCHY } from "@wolfpack/engine";
import { SectionSummarySchema, LabelSectionSchema } from "../shared/index.js";

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
  members: SectionMember[]
): Promise<string> {
  const bounded = members.slice(0, HIERARCHY.maxChildSummaries);

  const prompt = [
    "Entries in this section:",
    "",
    ...bounded.map((m, i) => {
      const summary = m.summary?.trim().slice(0, 200);
      return `${i + 1}. ${m.title}${summary ? ` — ${summary}` : ""}`;
    }),
    "",
    "Write the section's one-line summary (one sentence, at most 140 characters).",
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
  context: { sampleTitles?: string[]; parentTitle?: string; siblingSummaries?: string[] } = {}
): Promise<string> {
  const { sampleTitles = [], parentTitle, siblingSummaries = [] } = context;
  const bounded = sampleTitles.slice(0, HIERARCHY.maxChildSummaries);
  const sibs = siblingSummaries.slice(0, HIERARCHY.maxChildSummaries);
  const prompt = [
    parentTitle ? `Parent section title: ${parentTitle}` : "",
    sibs.length ? "Sibling sections (make THIS title distinct from these):" : "",
    ...sibs.map((s) => `- ${s}`),
    sibs.length || parentTitle ? "" : "",
    "Section summary:",
    summary,
    bounded.length ? "\nSample member titles:" : "",
    ...bounded.map((t) => `- ${t}`),
    "",
    "Produce a short, specific title that is distinct from the parent and siblings.",
  ].join("\n");

  const result = await engine.call("labelSection", LabelSectionSchema, {
    system: LABEL_SECTION_SYSTEM,
    prompt,
  });

  return result.title;
}
