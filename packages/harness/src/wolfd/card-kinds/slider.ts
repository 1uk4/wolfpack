import { onSliderStep } from "@wolfpack/protocol";
import { NO_ANSWER, type FieldKind } from "./types.js";

export const sliderFieldKind: FieldKind = {
  kind: "slider",
  validate(f, a) {
    const v = a.value;
    if (typeof v !== "number" || !Number.isFinite(v)) return `field "${f.id}" is a slider: the answer must be a number`;
    const { min, max, step } = f as unknown as { min: number; max: number; step: number };
    if (v < min || v > max) return `field "${f.id}": ${v} is outside ${min}..${max}`;
    if (!onSliderStep(v, min, step)) return `field "${f.id}": ${v} is not on a step of ${step} from ${min}`;
    return undefined;
  },
  // Skipped only when ABSENT.
  isEmpty: () => false,
  answerText: (_f, a) => (typeof a.value === "number" ? String(a.value) : NO_ANSWER),
};
