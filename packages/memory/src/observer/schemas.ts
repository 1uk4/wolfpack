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
});

export type RawObservation = z.infer<typeof RawObservationSchema>;

export const ObserverResultSchema = z.object({
  observations: z.array(RawObservationSchema),
});

export type ObserverResult = z.infer<typeof ObserverResultSchema>;
