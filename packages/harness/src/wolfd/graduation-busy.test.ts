import { describe, expect, it } from "vitest";
import { runningReasonFor, type FeatureThreadState } from "./graduation-busy.js";

const thread = (over: Partial<FeatureThreadState> = {}): FeatureThreadState => ({ kind: "feature", boundWorkItem: "work-w-A", conversationId: 5, running: false, liveChildren: [], ...over });

describe("runningReasonFor: is the feature thread of a work item busy", () => {
  it("is idle when the thread has no turn and no live sub-agents, and when no thread is bound to the item", () => {
    expect(runningReasonFor("work-w-A", [thread()])).toBeUndefined();
    expect(runningReasonFor("work-w-A", [thread({ boundWorkItem: "work-w-B", running: true })])).toBeUndefined();
    expect(runningReasonFor("work-w-A", [])).toBeUndefined();
  });

  it("names a turn in progress, and running sub-agents even when the turn itself is idle", () => {
    expect(runningReasonFor("work-w-A", [thread({ running: true })])).toBe("a turn is in progress");
    expect(runningReasonFor("work-w-A", [thread({ liveChildren: ["w-api", "w-ui"] })])).toBe("2 sub-agents running (w-api, w-ui)");
  });

  it("leaves out the caller's own turn but still counts its sub-agents", () => {
    expect(runningReasonFor("work-w-A", [thread({ running: true })], 5)).toBeUndefined();
    expect(runningReasonFor("work-w-A", [thread({ running: true, liveChildren: ["w-api"] })], 5)).toBe("1 sub-agent running (w-api)");
  });
});
