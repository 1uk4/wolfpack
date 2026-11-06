import { z } from "zod";
import { cardFieldBase, CardOptionSchema, type CardKind, type FieldShowIf } from "./base.js";

export const SingleFieldSchema = cardFieldBase.extend({
  kind: z.literal("single"),
  options: z.array(CardOptionSchema).min(1),
  /** Offer an "Other" free-text entry beside the options. Default true. */
  allowOther: z.boolean().optional(),
  /** An option `value` to pre-select. */
  default: z.string().optional(),
});
type Single = z.infer<typeof SingleFieldSchema>;

export const singleKind: CardKind = {
  kind: "single",
  fieldSchema: SingleFieldSchema,
  // single answers share the text answer shape ({value, other?}); registered once by free-text, so reuse it here.
  answerSchema: z.object({ value: z.string(), other: z.boolean().optional() }),
  checkField(f) {
    const s = f as unknown as Single;
    return s.default === undefined || s.options.some((o) => o.value === s.default) ? undefined : "a single field's default must be one of its option values";
  },
  checkShowIfController(ctl, s: FieldShowIf) {
    const values = (ctl as unknown as Single).options.map((o) => o.value);
    const wanted = s.oneOf ?? (typeof s.equals === "string" ? [s.equals] : []);
    if (wanted.length === 0) return `showIf on single field "${ctl.id}" needs a string \`equals\` or a non-empty \`oneOf\``;
    const bad = wanted.find((w) => !values.includes(w));
    return bad === undefined ? undefined : `showIf value "${bad}" is not an option of "${ctl.id}"`;
  },
};
