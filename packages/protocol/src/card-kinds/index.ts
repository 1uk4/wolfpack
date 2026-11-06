/**
 * Field-kind registry of interaction cards (protocol side): each kind is one module with its field schema and answer
 * schema. `CardFieldSchema` / `CardFieldAnswerSchema` (schemas.ts) dispatch through this registry at parse time, so a
 * kind added with `registerCardKind` is accepted everywhere a card is parsed. An unknown kind (a newer wolfd) still
 * parses, as a free-text-like field (see `parseField`), so an older client keeps working.
 */
import { z } from "zod";
import type { AnyField, CardKind } from "./base.js";
import { confirmKind } from "./confirm.js";
import { freeTextKind } from "./free-text.js";
import { multiKind } from "./multi.js";
import { singleKind } from "./single.js";

export * from "./base.js";
export { FreeTextFieldSchema, TextFieldAnswerSchema, type TextFieldAnswer } from "./free-text.js";
export { SingleFieldSchema } from "./single.js";
export { MultiFieldSchema, MultiFieldAnswerSchema, type MultiFieldAnswer } from "./multi.js";
export { ConfirmFieldSchema, ConfirmFieldAnswerSchema, type ConfirmFieldAnswer } from "./confirm.js";

const BUILTIN_KINDS: CardKind[] = [freeTextKind, singleKind, multiKind, confirmKind];
const kinds = new Map<string, CardKind>(BUILTIN_KINDS.map((k) => [k.kind, k]));

export function registerCardKind(k: CardKind): void {
  kinds.set(k.kind, k);
}
/** Test helper: drop a kind registered at runtime (built-ins stay). */
export function unregisterCardKind(kind: string): void {
  if (!BUILTIN_KINDS.some((k) => k.kind === kind)) kinds.delete(kind);
}
export function cardKind(kind: string): CardKind | undefined {
  return kinds.get(kind);
}
export function cardKinds(): CardKind[] {
  return [...kinds.values()];
}

/** A field of a kind this build does not know: the shared props plus whatever else it carried. */
const unknownFieldSchema = z.looseObject({ id: z.string().min(1), kind: z.string(), label: z.string(), description: z.string().optional(), optional: z.boolean().optional() });

/** Parse one field through its kind's schema (unknown kinds fall back to the loose shared shape). */
export function parseField(raw: unknown, ctx: z.RefinementCtx, path: (string | number)[] = []): unknown {
  const kind = (raw as { kind?: unknown } | null)?.kind;
  const k = typeof kind === "string" ? kinds.get(kind) : undefined;
  const r = (k?.fieldSchema ?? unknownFieldSchema).safeParse(raw);
  if (r.success) return r.data;
  for (const i of r.error.issues) ctx.addIssue({ code: "custom", message: i.message, path: [...path, ...i.path] });
  return z.NEVER;
}

/** Fields: `kind` picks the registered schema. */
export const fieldSchemaOf = (): z.ZodType<AnyField> => z.unknown().transform((raw, ctx) => parseField(raw, ctx) as AnyField);

/** Answer values: any registered kind's answer shape. */
export const answerSchemaOf = (): z.ZodType<{ value: unknown; [k: string]: unknown }> =>
  z.unknown().transform((raw, ctx) => {
    for (const k of kinds.values()) {
      const r = k.answerSchema.safeParse(raw);
      if (r.success) return r.data as { value: unknown };
    }
    ctx.addIssue({ code: "custom", message: "not a valid card answer" });
    return z.NEVER;
  });
