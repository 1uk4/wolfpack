import { z } from "zod";

export const CardOptionSchema = z.object({
  label: z.string(),
  /** Machine-readable value returned when picked. Defaults to the label. */
  value: z.string(),
  description: z.string().optional(),
  /** The `ask` tool: what picking this option costs or implies (required there). */
  tradeoff: z.string().optional(),
});
export type CardOption = z.infer<typeof CardOptionSchema>;

/**
 * A field shown only while an earlier field's answer matches: `equals` compares a single/free-text value or a confirm
 * boolean; `oneOf` matches any of several single values. Exactly one of the two. A hidden field is neither shown nor
 * required, and any answer it carries is rejected.
 */
export const FieldShowIfSchema = z
  .object({
    /** Id of the controlling field; it must be declared earlier in the card. */
    field: z.string().min(1),
    equals: z.union([z.string(), z.boolean()]).optional(),
    oneOf: z.array(z.string()).min(1).optional(),
  })
  .refine((s) => (s.equals === undefined) !== (s.oneOf === undefined), { message: "showIf needs exactly one of equals / oneOf" });
export type FieldShowIf = z.infer<typeof FieldShowIfSchema>;

/** `viz-<slug>-<ms>.png`, exactly as the visual tools' `publish()` names a render (slug: lowercase a-z0-9 and dashes). */
export const DIAGRAM_ID_RE = /^viz-[a-z0-9]+(?:-[a-z0-9]+)*-\d+\.png$/;

/** The properties every field kind shares; a kind's field schema extends this. */
export const cardFieldBase = z.object({
  /** Unique within the card; keys the answer. */
  id: z.string().min(1),
  label: z.string(),
  /** Extra context shown under the label. */
  description: z.string().optional(),
  /**
   * The `ask` tool: id of a diagram the wolf rendered and persisted (render_mermaid / render_svg with `save_as` and
   * `persist: true`). Served by `GET /v1/threads/:id/diagrams/:diagramId`. An id only: never a path or URL, the console must not build one.
   */
  diagram: z.string().regex(DIAGRAM_ID_RE, "a diagram is the file name of a published render (viz-<slug>-<ms>.png), never a path or URL").optional(),
  /** Conditional visibility (stepped/dependent cards); absent = always shown. */
  showIf: FieldShowIfSchema.optional(),
  /**
   * The operator may leave it blank. Default (absent) = required. A skipped optional field is submitted empty
   * (free-text/single `{value: ""}`, multi `{value: []}`, confirm: no answer) and the wolf is told it was skipped;
   * an answer that is given is validated normally (a multi's min/max still apply once something is picked).
   */
  optional: z.boolean().optional(),
});

/** What every kind's field looks like to the registry (kind-specific props are read by the kind's own hooks). */
export interface AnyField {
  id: string;
  kind: string;
  label: string;
  optional?: boolean;
  showIf?: FieldShowIf;
  [k: string]: unknown;
}
export interface AnyAnswer {
  value: unknown;
  [k: string]: unknown;
}

/**
 * One answer kind of an interaction card. To add a kind: write a module like `confirm.ts`, then list it in
 * `BUILTIN_KINDS` (index.ts) or call `registerCardKind` at startup. The wolfd side (validate / isEmpty / answerText)
 * lives in `packages/harness/src/wolfd/card-kinds/` (one module per kind, keyed by `kind`); the console renderer in
 * `apps/console/components/card-fields/`.
 */
export interface CardKind {
  kind: string;
  /** The field as the wolf declares it on a card (extends `cardFieldBase`). */
  fieldSchema: z.ZodType;
  /** The answer value as the operator submits it. */
  answerSchema: z.ZodType;
  /** A problem with the field's own props (model-facing message), or undefined. */
  checkField?(f: AnyField): string | undefined;
  /** Why a field of this kind cannot be the target of another field's showIf (undefined = it can). */
  checkShowIfController?(ctl: AnyField, showIf: FieldShowIf): string | undefined;
}
