/**
 * Claim schema — a wolf's submission to the Librarian.
 * The raw input to the pack-tier pipeline.
 */
import { z } from "zod";

export const ClaimSchema = z.object({
  from: z.string().describe("Wolf name that submitted this"),
  domain: z.string(),
  origin: z.enum(["intentional", "auto", "sweep", "backfill"]),
  submitted: z.string(),
  session: z.string().optional(),
  title: z.string(),
  claim: z.string().describe("What the wolf asserts"),
  evidence: z.string().describe("How the wolf knows this"),
  sources: z.array(z.string()).default([]),
});

export type Claim = z.infer<typeof ClaimSchema>;

/**
 * Claim worthiness — the wolf-tier consolidator's judgment on whether
 * an observation or topic update is worth submitting as a pack claim.
 */
export const ClaimWorthinessSchema = z.object({
  worthy: z.boolean(),
  reasoning: z.string(),
  /** If worthy: draft the claim */
  title: z.string().optional(),
  claim: z.string().optional(),
  evidence: z.string().optional(),
  domain: z.string().optional(),
});

export type ClaimWorthiness = z.infer<typeof ClaimWorthinessSchema>;
