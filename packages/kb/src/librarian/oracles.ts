/**
 * oracles — the three narrow LLM calls, each a thin engine.call wrapper with a
 * tight Zod contract. Two run on the fast model and are conditional; one (label)
 * is deferrable. Everything else in the sweep is deterministic code.
 */
import type { Engine } from "@wolfpack/engine";
import { CONTRADICT_SYSTEM, SECTION_PICK_SYSTEM } from "@wolfpack/engine";
import {
  ContradictResultSchema,
  type ContradictResult,
  SectionPickSchema,
  type SectionPick,
} from "../shared/index.js";

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

    /**
     * classifyToSection — route a contribution to a section from a closed set.
     * 
     * Input: contribution text + candidate sections (array of {sectionId, title, summary}).
     * Output: {section: sectionId | "NEW", confidence}.
     * 
     * CONFINEMENT: validates that the returned section is either "NEW" or one of the
     * provided sectionIds. If the model returns an id not in the set, coerces to "NEW".
     */
    async classifyToSection(
      contributionText: string,
      sections: Array<{ sectionId: string; title: string; summary: string }>
    ): Promise<SectionPick> {
      // Build the section enum for the prompt
      const sectionList = sections
        .map((s) => `- ${s.sectionId}: ${s.title}\n  ${s.summary}`)
        .join("\n\n");

      const prompt = `CONTRIBUTION:\n${contributionText}\n\nSECTIONS (pick one id or return "NEW"):\n${sectionList}`;

      const result = await engine.call("classifyToSection", SectionPickSchema, {
        system: SECTION_PICK_SYSTEM,
        prompt,
      });

      // FIREWALL: validate the returned section is in the provided set or "NEW"
      const validSectionIds = new Set(sections.map((s) => s.sectionId));
      if (result.section !== "NEW" && !validSectionIds.has(result.section)) {
        // Model returned an invalid id — coerce to "NEW"
        return {
          section: "NEW",
          confidence: result.confidence,
        };
      }

      return result;
    },
  };
}

export type Oracles = ReturnType<typeof createOracles>;
