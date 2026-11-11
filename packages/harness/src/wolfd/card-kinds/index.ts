/**
 * wolfd's field-kind registry: validate / isEmpty / answerText per card answer kind, one module per kind.
 * To add a kind: write `<kind>.ts` exporting a `FieldKind`, add it to BUILTIN below (or `registerFieldKind` at startup),
 * and add the protocol module (packages/protocol/src/card-kinds) and console renderer (apps/console/components/ask/card-fields).
 * A kind this build does not know is handled like free text, so a card from a newer wolf still gets an answer.
 */
import { confirmFieldKind } from "./confirm.js";
import { freeTextFieldKind } from "./free-text.js";
import { multiFieldKind } from "./multi.js";
import { singleFieldKind } from "./single.js";
import { sliderFieldKind } from "./slider.js";
import type { FieldKind } from "./types.js";

export type { FieldKind, AnyAnswer } from "./types.js";

const BUILTIN: FieldKind[] = [freeTextFieldKind, singleFieldKind, multiFieldKind, confirmFieldKind, sliderFieldKind];
const kinds = new Map<string, FieldKind>(BUILTIN.map((k) => [k.kind, k]));

export function registerFieldKind(k: FieldKind): void {
  kinds.set(k.kind, k);
}
export function unregisterFieldKind(kind: string): void {
  if (!BUILTIN.some((k) => k.kind === kind)) kinds.delete(kind);
}
/** The kind's handlers; an unknown kind falls back to free text. */
export function fieldKind(kind: string): FieldKind {
  return kinds.get(kind) ?? freeTextFieldKind;
}
