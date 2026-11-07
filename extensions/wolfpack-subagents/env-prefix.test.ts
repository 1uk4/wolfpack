import { describe, expect, it } from "vitest";
import { subagentEnvPrefix } from "./env-prefix.ts";

const base = { name: "worker-1", session: "/s/x.jsonl", id: "abc", activityFile: "/a/x.json" };

describe("subagent launch env prefix", () => {
  it("marks a spawned child as an agent run and keeps its identity", () => {
    const p = subagentEnvPrefix({ ...base, agent: "worker", allowed: ["worker"], surface: "s1", autoExit: true });
    expect(p).toContain("WOLFPACK_AGENT_RUN=1 ");
    expect(p).toContain("PI_SUBAGENT_AGENT=");
    expect(p).toContain("PI_SUBAGENT_ALLOWED=");
    expect(p).toContain("PI_SUBAGENT_AUTO_EXIT=1");
    expect(p.endsWith(" ")).toBe(true);
  });

  it("marks a resumed child (no surface, no spawn list) the same way", () => {
    const p = subagentEnvPrefix({ ...base, agent: "worker" });
    expect(p).toContain("WOLFPACK_AGENT_RUN=1 ");
    expect(p).not.toContain("PI_SUBAGENT_SURFACE");
    expect(p).not.toContain("PI_SUBAGENT_ALLOWED");
  });

  it("marks an agentless child too", () => {
    expect(subagentEnvPrefix(base)).toContain("WOLFPACK_AGENT_RUN=1 ");
  });
});
