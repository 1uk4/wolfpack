import { z } from "zod";
import { cardFieldBase, CardOptionSchema, type CardKind } from "./base.js";

export const MultiFieldSchema = cardFieldBase.extend({
  kind: z.literal("multi"),
  options: z.array(CardOptionSchema).min(1),
  /** Offer custom entries beside the options. Default false (unlike `single`): a multi answer is a subset of the options. */
  allowOther: z.boolean().optional(),
  /** Option values to pre-select. */
  default: z.array(z.string()).optional(),
  /** Bounds on the number of picked entries (options and custom ones together). A required multi needs at least one pick regardless; optional: true allows blank. */
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(1).optional(),
});
type Multi = z.infer<typeof MultiFieldSchema>;
export const MultiFieldAnswerSchema = z.object({ value: z.array(z.string()), other: z.array(z.string()).optional() });
export type MultiFieldAnswer = z.infer<typeof MultiFieldAnswerSchema>;

export const multiKind: CardKind = {
  kind: "multi",
  fieldSchema: MultiFieldSchema,
  answerSchema: MultiFieldAnswerSchema,
  checkField(f) {
    const m = f as unknown as Multi;
    const def = m.default;
    if (def !== undefined && !def.every((d) => m.options.some((o) => o.value === d))) return "a multi field's default must be a subset of its option values";
    if (new Set(def ?? []).size !== (def ?? []).length) return "a multi field's default must not repeat a value";
    if ((m.min ?? 0) > (m.max ?? Infinity)) return "a multi field's min must not exceed its max";
    if (m.allowOther !== true && (m.min ?? 0) > m.options.length) return "a multi field's min exceeds its number of options (and allowOther is not set), so it can never be satisfied";
    if (def !== undefined && !(def.length >= (m.min ?? 0) && def.length <= (m.max ?? Infinity))) return "a multi field's default must respect its min and max";
    return undefined;
  },
};
