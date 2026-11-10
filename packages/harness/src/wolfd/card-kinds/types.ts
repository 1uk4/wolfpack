import type { AnyField, CardFieldAnswer } from "@wolfpack/protocol";

/** An answer as the registry sees it (kind-specific props read by the kind itself). */
export type AnyAnswer = CardFieldAnswer | { value: unknown; [k: string]: unknown };

/**
 * wolfd side of one card answer kind. The protocol module of the same `kind` owns the schemas; this owns what the
 * server does with an answer. Register with `registerFieldKind` (index.ts).
 */
export interface FieldKind {
  kind: string;
  /** A problem with a PRESENT answer (model-facing message), or undefined when valid. */
  validate(field: AnyField, answer: AnyAnswer): string | undefined;
  /** Whether a present answer counts as blank (an optional field left blank is skipped; a required one is invalid). */
  isEmpty(field: AnyField, answer: AnyAnswer): boolean;
  /** The model-facing text of a present, non-skipped answer. */
  answerText(field: AnyField, answer: AnyAnswer): string;
}

/** Quote an entry when it would blur the comma-separated list. */
export const listSafe = (text: string): string => (/[,"]/.test(text) ? JSON.stringify(text) : text);

/** One picked entry of a multi or single answer: `Label (value)` (just `Label` when equal), or `other: "text"` for a custom one. */
export function optionEntry(options: readonly { label: string; value: string }[], value: string, custom: boolean): string {
  if (custom) return `other: ${JSON.stringify(value)}`;
  const o = options.find((x) => x.value === value);
  if (!o || o.label === o.value) return listSafe(value);
  return listSafe(`${o.label} (${value})`);
}

/** The image ids bound to an answer (`bindCardText` with attachments). */
export function attachmentIds(a: AnyAnswer | undefined): string[] {
  const v = (a as { attachments?: unknown } | undefined)?.attachments;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** An answer with images and no text/pick: the images are the answer (shape `{value: "" | [], attachments}`). */
export function isImageOnly(a: AnyAnswer): boolean {
  const v = (a as { value: unknown }).value;
  return attachmentIds(a).length > 0 && (v === "" || (Array.isArray(v) && v.length === 0));
}

export const IMAGE_ONLY_TEXT = "(image only)";
export const NO_ANSWER = "(no answer)";
export const EMPTY_RESPONSE = "(empty response)";
