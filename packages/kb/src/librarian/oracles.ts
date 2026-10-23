/**
 * oracles — the three narrow LLM calls, each a thin engine.call wrapper with a
 * tight Zod contract. Two run on the fast model and are conditional; one (label)
 * is deferrable. Everything else in the sweep is deterministic code.
 */
import type { Engine } from "@wolfpack/engine";
import { classifyError } from "./backoff.js";
import { BudgetExceeded } from "./park.js";
import { CONTRADICT_SYSTEM, SECTION_PICK_SYSTEM, MATCH_SUBJECT_SYSTEM } from "@wolfpack/engine";
import {
  ContradictResultSchema,
  type ContradictResult,
  SectionPickSchema,
  type SectionPick,
  MatchSubjectSchema,
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

    /**
     * matchSubject — is the contribution the same subject as one of the
     * candidate entries? Returns a candidate id, or "new".
     *
     * CONFINEMENT: an id outside the candidate set (or any answer that does
     * not parse) is "new" — creating a duplicate is safer than a wrong merge.
     * Infra errors propagate to the sweep's backoff.
     */
    async matchSubject(
      contribution: { title: string; summary: string },
      candidates: Array<{ id: string; title: string; summary: string }>
    ): Promise<{ match: string; valid: boolean; reason?: string }> {
      const list = candidates
        .map((c) => `- ${c.id}: ${c.title}\n  ${c.summary}`)
        .join("\n\n");
      const prompt =
        `CONTRIBUTION:\n${contribution.title}\n${contribution.summary}\n\n` +
        `CANDIDATE ENTRIES (answer one id or "new"):\n${list}`;
      let result;
      try {
        result = await engine.call("matchSubject", MatchSubjectSchema, {
          system: MATCH_SUBJECT_SYSTEM,
          prompt,
        });
      } catch (err) {
        // Only an unparseable answer degrades to "new"; infra errors and
        // budget aborts must reach the sweep's backoff / parking.
        const msg = err instanceof Error ? err.message : String(err);
        const unparseable =
          classifyError(err) === "item" &&
          !(err instanceof BudgetExceeded) &&
          (/^Failed to extract valid output/.test(msg) || (err as { name?: string })?.name === "ZodError");
        if (!unparseable) throw err;
        return { match: "new", valid: false, reason: "unparseable answer" };
      }
      const match = result.match.trim();
      const reason = result.reason?.trim() || undefined;
      if (candidates.some((c) => c.id === match)) return { match, valid: true, reason };
      return { match: "new", valid: match.toLowerCase() === "new", reason };
    },
  };
}

export type Oracles = ReturnType<typeof createOracles>;
