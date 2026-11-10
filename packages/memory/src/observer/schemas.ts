/**
 * Observer output schemas — what the observation LLM returns.
 */
import { z } from "zod";

export const RawObservationSchema = z.object({
  timestamp: z
    .string()
    .describe("YYYY-MM-DD HH:MM format, local time"),
  content: z
    .string()
    .min(1)
    .describe("Single-line plain prose — no markdown, no tags"),
  domain: z
    .string()
    .optional()
    .describe("The knowledge domain this observation belongs to"),
});

/** Schema sent to the model when `memory.generalToDen` is on: adds the `general` flag. */
export const RawObservationWithGeneralSchema = RawObservationSchema.extend({
  general: z
    .boolean()
    .optional()
    .describe("True only for owner preferences, standing rules, and environment/tooling facts that outlive the task; absent means false"),
});

// `general` is parse-tolerant: only present when the flag is on.
export type RawObservation = z.infer<typeof RawObservationSchema> & { general?: boolean };

export const ObserverResultSchema = z.object({
  observations: z.array(RawObservationSchema),
});

export type ObserverResult = z.infer<typeof ObserverResultSchema>;

export const ObserverResultWithGeneralSchema = z.object({
  observations: z.array(RawObservationWithGeneralSchema),
});
