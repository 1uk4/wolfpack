/**
 * Observation schema — atomic facts extracted from raw content.
 * Matches OM's observation format so we can consume OM output directly.
 */
import { z } from "zod";

export const ObservationSchema = z.object({
  timestamp: z.string().describe("YYYY-MM-DDTHH:MM:SS format, doubles as id"),
  content: z.string().min(1).describe("Single-line plain prose"),
  tokenCount: z.number().int().nonnegative(),
});

export type Observation = z.infer<typeof ObservationSchema>;
