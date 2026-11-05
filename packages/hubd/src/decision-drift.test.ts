/** The hub event's decision shape (protocol) and the KB ledger's (kb) must agree (work-wolfpack-55ZPU2a). */
import { describe, expect, it } from "vitest";
import { HubSweepDecisionSchema, type HubSweepDecision } from "@wolfpack/protocol";
import { DecisionSummarySchema, type DecisionSummary } from "@wolfpack/kb/shared";

// Type level: each shape is assignable to the other (a field added on one side only fails the build).
const toProtocol = (d: DecisionSummary): HubSweepDecision => d;
const toKb = (d: HubSweepDecision): DecisionSummary => d;
type Keys<T> = keyof T;
const sameKeys: Keys<DecisionSummary> extends Keys<HubSweepDecision> ? (Keys<HubSweepDecision> extends Keys<DecisionSummary> ? true : false) : false = true;

describe("decision shape drift", () => {
  const full: DecisionSummary = {
    outcome: "merge",
    entryId: "kb-wp-AAAAAAA",
    reason: "r",
    routing: {
      route: "similarity",
      candidates: [{ id: "kb-wp-AAAAAAA", score: 0.9 }],
      band: "ask",
      subject: { match: "kb-wp-AAAAAAA", valid: true, reason: "same" },
      confirm: { candidate: "kb-wp-AAAAAAA", score: 0.82, merge: true, valid: true, reason: "same" },
      target: "kb-wp-AAAAAAA",
      warning: "w",
    },
  };

  it("both schemas accept and round-trip the same full value", () => {
    expect(sameKeys).toBe(true);
    expect(DecisionSummarySchema.parse(toKb(toProtocol(full)))).toEqual(full);
    expect(HubSweepDecisionSchema.parse(full)).toEqual(full);
  });

  it("same outcomes, same routing keys and routes", () => {
    expect(HubSweepDecisionSchema.shape.outcome.options).toEqual(DecisionSummarySchema.shape.outcome.options);
    const p = HubSweepDecisionSchema.shape.routing.unwrap().shape;
    const k = DecisionSummarySchema.shape.routing.unwrap().shape;
    expect(Object.keys(p).sort()).toEqual(Object.keys(k).sort());
    expect(p.route.options).toEqual(k.route.options);
    expect(Object.keys(p.confirm.unwrap().shape).sort()).toEqual(Object.keys(k.confirm.unwrap().shape).sort());
    expect(Object.keys(p.subject.unwrap().shape).sort()).toEqual(Object.keys(k.subject.unwrap().shape).sort());
  });
});
