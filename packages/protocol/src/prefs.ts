import { z } from "zod";

/** Per-person preference value (GET answer, PUT body and answer). `value` is any JSON, at most 32 KB serialized; `null` on GET = nothing stored. */
export const PrefBodySchema = z.object({ value: z.unknown() });
export const PrefResponseSchema = z.object({ value: z.unknown().nullable() });
export type PrefResponse = z.infer<typeof PrefResponseSchema>;
