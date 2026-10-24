import { type PopupMessage } from "@/components/plan-block";
/** True when the transcript holds a plan tree. Gates the marginalia's
 *  clickable flank (chat.tsx): PlanMarginalia renders null without a
 *  tree, but the WRAPPER button must unmount too — a JSX element is
 *  always truthy, so gating on it alone left a phantom click target in
 *  the bottom-right whenever a question was pending with no plan
 *  (owner report, UI round 2026-10-01). */
export declare function planExists(messages: readonly PopupMessage[]): boolean;
export declare function PlanMarginalia({ messages }: {
    messages: readonly PopupMessage[];
}): any;
//# sourceMappingURL=plan-window.d.ts.map