/**
 * summarize — confined section-summary LLM call for crystallize + digest.
 */
import type { Engine } from "@wolfpack/engine";
import { SECTION_SUMMARY_SYSTEM, LABEL_SECTION_SYSTEM, HIERARCHY } from "@wolfpack/engine";
import { SectionSummarySchema, LabelSectionSchema } from "../shared/index.js";

/**
 * Produce a one-paragraph summary of a section from its child summaries.
 * Bounded input (caps child summaries to HIERARCHY.maxChildSummaries).
 * Used by crystallize + digest; no ids/dates/structure emitted.
 */
export async function sectionSummary(
  engine: Engine,
  childSummaries: string[]
): Promise<string> {
  // Cap input to prevent unbounded context
  const bounded = childSummaries.slice(0, HIERARCHY.maxChildSummaries);
  
  const prompt = [
    "Summarize this section based on its child entries:",
    "",
    ...bounded.map((s, i) => `${i + 1}. ${s}`),
    "",
    "Write one concise paragraph (2-4 sentences) that captures the common theme.",
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
