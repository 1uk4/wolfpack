import { z } from "zod";
import { cardFieldBase, type CardKind } from "./base.js";

export const FreeTextFieldSchema = cardFieldBase.extend({
  kind: z.literal("free-text"),
  default: z.string().optional(),
});
export const TextFieldAnswerSchema = z.object({ value: z.string(), other: z.boolean().optional(), attachments: z.array(z.string()).optional() });
export type TextFieldAnswer = z.infer<typeof TextFieldAnswerSchema>;

export const freeTextKind: CardKind = { kind: "free-text", fieldSchema: FreeTextFieldSchema, answerSchema: TextFieldAnswerSchema };
