import { z } from "zod";
import { cardFieldBase, type CardKind } from "./base.js";

/** A single value on a numeric scale (the `ask` tool's slider). */
export const SliderFieldSchema = cardFieldBase.extend({
  kind: z.literal("slider"),
  min: z.number(),
  max: z.number(),
  step: z.number(),
  /** Pre-selected value; never auto-submitted. */
  default: z.number().optional(),
  minLabel: z.string().optional(),
  maxLabel: z.string().optional(),
});
type Slider = z.infer<typeof SliderFieldSchema>;
export const SliderFieldAnswerSchema = z.object({ value: z.number() });
export type SliderFieldAnswer = z.infer<typeof SliderFieldAnswerSchema>;

/** True when `v` sits on the scale `min + k*step` (tolerates float noise). */
export const onSliderStep = (v: number, min: number, step: number): boolean => {
  const k = (v - min) / step;
  return Math.abs(k - Math.round(k)) < 1e-9;
};

/** Why a slider's bounds are unusable, or undefined. Shared by the ask tool and the card refinement. */
export function sliderProblem(s: { min: number; max: number; step: number; default?: number }): string | undefined {
  if (!(s.min < s.max)) return "a slider needs min < max";
  if (!(s.step > 0)) return "a slider needs step > 0";
  if (!onSliderStep(s.max, s.min, s.step)) return "a slider's max must be reachable from min by whole steps (min + n*step)";
  if (s.default !== undefined) {
    if (s.default < s.min || s.default > s.max) return "a slider's default must be within min and max";
    if (!onSliderStep(s.default, s.min, s.step)) return "a slider's default must sit on a step (min + n*step)";
  }
  return undefined;
}

export const sliderKind: CardKind = {
  kind: "slider",
  fieldSchema: SliderFieldSchema,
  answerSchema: SliderFieldAnswerSchema,
  checkField: (f) => sliderProblem(f as unknown as Slider),
};
