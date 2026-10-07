/**
 * oracles — the three narrow LLM calls, each a thin engine.call wrapper with a
 * tight Zod contract. Two run on the fast model and are conditional; one (label)
 * is deferrable. Everything else in the sweep is deterministic code.
 */
import type { Engine } from "@wolfpack/engine";
import {
  ContradictResultSchema,
  type ContradictResult,
  ClassifyResultSchema,
  type ClassifyResult,
  LabelTopicResultSchema,
  type LabelTopicResult,
} from "../shared/index.js";

const CONTRADICT_SYSTEM =
  "You compare a NEW knowledge contribution against an EXISTING KB entry. " +
  "Decide only whether they factually conflict, and if so which should win. " +
  "Base 'winner' on recency and specificity of evidence, using the supplied " +
  "dates. IMPORTANT: if the NEW contribution is marked currency=archived and its " +
  "date is older than the existing entry, prefer 'existing' and treat the new " +
  "material as historical context, NOT a correction. Also: origin=crawl means the " +
  "NEW material was bulk-ingested from old documents (a wolf acting as a scribe), " +
  "not lived/curated knowledge — do not let it overwrite a current entry unless it " +
  "is clearly more recent AND more specific. Output JSON only.";

const CLASSIFY_SYSTEM =
  "You classify a single knowledge contribution into a domain, type, and a " +
  "short subcategory slug. Output JSON only.";

const LABEL_SYSTEM =
  "You name a cluster of related knowledge entries with a concise human topic " +
  "label and a kebab-case slug. Output JSON only.";

export function createOracles(engine: Engine) {
  return {
    async contradict(
      newText: string,
      existingText: string,
      dates?: {
        newDate?: string;
        newCurrency?: string;
        existingDate?: string;
        newOrigin?: string;
      }
    ): Promise<ContradictResult> {
      const header = dates
        ? `NEW date: ${dates.newDate ?? "unknown"} (currency: ${dates.newCurrency ?? "live"}, origin: ${dates.newOrigin ?? "wolf"})\n` +
          `EXISTING date: ${dates.existingDate ?? "unknown"}\n\n`
        : "";
      return engine.call("contradict", ContradictResultSchema, {
        system: CONTRADICT_SYSTEM,
        prompt: `${header}NEW:\n${newText}\n\nEXISTING:\n${existingText}`,
      });
    },

    async classify(text: string): Promise<ClassifyResult> {
      return engine.call("classifyEntry", ClassifyResultSchema, {
        system: CLASSIFY_SYSTEM,
        prompt: text,
      });
    },

    async labelTopic(memberSummaries: string[]): Promise<LabelTopicResult> {
      return engine.call("labelTopic", LabelTopicResultSchema, {
        system: LABEL_SYSTEM,
        prompt: memberSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n"),
      });
    },
  };
}

export type Oracles = ReturnType<typeof createOracles>;
