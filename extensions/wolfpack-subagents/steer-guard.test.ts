import { beforeEach, describe, expect, it, vi } from "vitest";

// index.ts pulls in the pi host packages, which aren't installed in the repo.
vi.mock("@earendil-works/pi-coding-agent", () => ({ keyHint: () => "" }));
vi.mock("@earendil-works/pi-tui", () => ({
  Box: class {},
  Text: class {},
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
}));
vi.mock("typebox", () => {
  const t: any = new Proxy(() => ({}), { get: () => t, apply: () => ({}) });
  return { Type: t };
});
// Never touch a real multiplexer.
vi.mock("./mux/index.ts", () => ({
  isMuxAvailable: () => true,
  createSurface: vi.fn(),
  isBackgroundSurfaceId: (s: string) => s.startsWith("bg:"),
  sendCommand: vi.fn(),
  sendLongCommand: vi.fn(),
  pollForExit: vi.fn(),
  probeExit: vi.fn(),
  closeSurface: vi.fn(),
  shellEscape: (s: string) => `'${s}'`,
  readScreen: () => "",
  wolfEnvPrefix: () => "",
}));

import { __test__ } from "./index.ts";

const { handleSubagentSteer, runningSubagents } = __test__ as any;

function addRunning(surface = "w1:p2") {
  const running = {
    id: "id1",
    name: "step1-deletions",
    task: "t",
    surface,
    startTime: Date.now(),
    sessionFile: "/nonexistent/session.jsonl",
    statusState: {},
    interactive: false,
  };
  runningSubagents.set(running.id, running);
  return running;
}

describe("handleSubagentSteer exit guard", () => {
  beforeEach(() => runningSubagents.clear());

  it("types into the pane when the agent is alive", async () => {
    addRunning();
    const send = vi.fn();
    const res = await handleSubagentSteer({ name: "step1-deletions", message: "hi" }, send, async () => null);
    expect(send).toHaveBeenCalledWith("w1:p2", "hi");
    expect(res.details.status).toBe("steered");
  });

  it("sends NO keystrokes once the agent has exited", async () => {
    addRunning();
    const send = vi.fn();
    const res = await handleSubagentSteer(
      { name: "step1-deletions", message: "rm -rf /" },
      send,
      async () => ({ reason: "sentinel", exitCode: 0 }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(res.details.exited).toBe(true);
    expect(res.details.error).toMatch(/already exited/);
  });

  it("refuses without typing when exit state can't be determined", async () => {
    addRunning();
    const send = vi.fn();
    const res = await handleSubagentSteer(
      { name: "step1-deletions", message: "hi" },
      send,
      async () => {
        throw new Error("pane unreadable");
      },
    );
    expect(send).not.toHaveBeenCalled();
    expect(res.details.error).toMatch(/Can't tell whether/);
    expect(res.details.exited).toBeUndefined();
  });
});
