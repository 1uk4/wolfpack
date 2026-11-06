import { describe, expect, it } from "vitest";
import { parseHubEvent } from "./schemas.js";

describe("hub sweep_progress event", () => {
  const base = { id: 7, at: "2026-11-05T10:00:00.000Z", type: "sweep_progress", from: "1uk4", denTopicId: "t1", startedAt: 1793922503645 };
  it("parses with and without a route", () => {
    expect(parseHubEvent(base)).toMatchObject({ kind: "event", event: { type: "sweep_progress", from: "1uk4" } });
    expect(parseHubEvent({ ...base, route: "merge into kb-x (9391 chars)" })).toMatchObject({ kind: "event", event: { route: "merge into kb-x (9391 chars)" } });
  });
  it("rejects a missing startedAt", () => {
    const { startedAt: _s, ...bad } = base;
    expect(parseHubEvent(bad).kind).toBe("invalid");
  });
});
