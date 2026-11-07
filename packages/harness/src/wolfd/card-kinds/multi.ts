import type { AnyField, CardOption } from "@wolfpack/protocol";
import { NO_ANSWER, optionEntry, type FieldKind } from "./types.js";

const optionsOf = (f: AnyField): CardOption[] => (Array.isArray(f.options) ? (f.options as CardOption[]) : []);

export const multiFieldKind: FieldKind = {
  kind: "multi",
  validate(f, a) {
    const id = f.id;
    if (!Array.isArray(a.value)) return `field "${id}": the answer must be a list of strings`;
    const picked = a.value as string[];
    const options = optionsOf(f);
    const other = "other" in a && Array.isArray(a.other) ? (a.other as string[]) : [];
    if (new Set(picked).size !== picked.length) return `field "${id}": duplicate entries`;
    if (other.length > 0 && f.allowOther !== true) return `field "${id}" does not accept custom entries`;
    for (const o of other) {
      if (o.trim() === "") return `field "${id}": a custom entry cannot be empty`;
      if (options.some((x) => x.value === o.trim())) return `field "${id}": custom entry "${o}" duplicates an option value`;
      if (!picked.includes(o)) return `field "${id}": custom entry "${o}" is not among the picked values`;
    }
    for (const v of picked) {
      if (!other.includes(v) && !options.some((o) => o.value === v)) return `"${v}" is not an option of field "${id}"`;
    }
    // A required multi needs at least one pick, whatever its min (an optional one may be blank, which never reaches here).
    const fmin = typeof f.min === "number" ? f.min : 0;
    const min = Math.max(fmin, f.optional ? 0 : 1);
    if (min > 0 && picked.length < min) return `field "${id}": pick at least ${min}`;
    if (typeof f.max === "number" && picked.length > f.max) return `field "${id}": pick at most ${f.max}`;
    return undefined;
  },
  isEmpty: (_f, a) => Array.isArray(a.value) && a.value.length === 0,
  answerText(f, a) {
    if (!Array.isArray(a.value)) return NO_ANSWER;
    if (a.value.length === 0) return "(none selected)";
    const custom = "other" in a && Array.isArray(a.other) ? (a.other as string[]) : [];
    const options = optionsOf(f);
    return (a.value as string[]).map((v) => optionEntry(options, v, custom.includes(v))).join(", ");
  },
};
