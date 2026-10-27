/**
 * Structured-object payloads, dependency-free on purpose: browser code imports this subpath
 * (`@wolfpack/protocol/objects`) without pulling in zod or the rest of the protocol. The wolf side validates a tool
 * call with the zod schemas in schemas.ts AND this parser; every consumer (wolfd history/events, the console) gates
 * `data` through `parseObjectData`, so they cannot disagree about what a valid object is.
 *
 * REV RULE (one definition, used by wolfd's live events and its history fold): rev = the number of successful,
 * completed calls of the object's tool with that objectId so far in the thread (1 for the first). A call that is
 * aborted, faulted, errored or fails validation counts for nothing.
 */

/** Object types this version knows. A new type adds its name here, a parser below and a schemas.ts entry. */
export const OBJECT_TYPES = ["decision"] as const;
export type KnownObjectType = (typeof OBJECT_TYPES)[number];

/** Tool name -> the object type it shows. */
export const OBJECT_TOOL_TYPES = { show_decision: "decision" } as const satisfies Record<string, KnownObjectType>;
export type ObjectToolName = keyof typeof OBJECT_TOOL_TYPES;

export interface DecisionOption {
  id: string;
  label: string;
  detail?: string;
}
export interface DecisionData {
  title?: string;
  options: DecisionOption[];
  chosen: string;
  rationale: string;
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** `data` of a decision, or undefined when it does not fit (also when `chosen` names no option). */
export function parseDecisionData(data: unknown): DecisionData | undefined {
  const d = data as Partial<DecisionData> | null | undefined;
  if (!d || typeof d !== "object" || !isStr(d.chosen) || !isStr(d.rationale) || !Array.isArray(d.options) || d.options.length === 0) return undefined;
  const options: DecisionOption[] = [];
  for (const o of d.options as Array<Partial<DecisionOption> | null>) {
    if (!o || !isStr(o.id) || o.id === "" || !isStr(o.label) || o.label === "") return undefined;
    options.push({ id: o.id, label: o.label, ...(isStr(o.detail) ? { detail: o.detail } : {}) });
  }
  if (!options.some((o) => o.id === d.chosen)) return undefined;
  return { ...(isStr(d.title) ? { title: d.title } : {}), options, chosen: d.chosen, rationale: d.rationale };
}

const PARSERS: Record<KnownObjectType, (data: unknown) => unknown> = { decision: parseDecisionData };

/** Validate `data` for a known type; undefined for an unknown type or invalid data (consumers skip the object). */
export function parseObjectData(type: "decision", data: unknown): DecisionData | undefined;
export function parseObjectData(type: string, data: unknown): unknown;
export function parseObjectData(type: string, data: unknown): unknown {
  return Object.hasOwn(PARSERS, type) ? PARSERS[type as KnownObjectType](data) : undefined;
}
