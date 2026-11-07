import { z } from "zod";
import { cardFieldBase, type CardKind, type FieldShowIf } from "./base.js";

export const ConfirmFieldSchema = cardFieldBase.extend({
  kind: z.literal("confirm"),
  /** Button labels; default "Yes" / "No". */
  confirmLabel: z.string().optional(),
  rejectLabel: z.string().optional(),
  /** Pre-selects confirm (true) or reject (false); the operator still has to submit. */
  default: z.boolean().optional(),
});
export const ConfirmFieldAnswerSchema = z.object({ value: z.boolean(), note: z.string().optional() });
export type ConfirmFieldAnswer = z.infer<typeof ConfirmFieldAnswerSchema>;

export const confirmKind: CardKind = {
  kind: "confirm",
  fieldSchema: ConfirmFieldSchema,
  answerSchema: ConfirmFieldAnswerSchema,
  checkShowIfController: (ctl, s: FieldShowIf) => (typeof s.equals === "boolean" && s.oneOf === undefined ? undefined : `showIf on confirm field "${ctl.id}" needs a boolean \`equals\``),
};
