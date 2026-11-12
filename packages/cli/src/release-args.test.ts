import { describe, expect, it, vi } from "vitest";
import { runReleaseCli } from "./release-args.js";

function mocks() {
  return { dispatch: vi.fn(), release: vi.fn(async () => {}), print: vi.fn() };
}

describe("wolfpack release argument handling", () => {
  it.each([["--help"], ["-h"]])("publish %s prints usage and dispatches nothing", async (flag) => {
    const m = mocks();
    await runReleaseCli(["publish", flag], m);
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(m.print.mock.calls.join("\n")).toContain("release publish");
  });

  it("publish refuses an unknown flag before dispatching", async () => {
    const m = mocks();
    await expect(runReleaseCli(["publish", "--bogus"], m)).rejects.toThrow(/unknown argument "--bogus"/);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("publish dispatches the default ref and honours --ref", async () => {
    const m = mocks();
    await runReleaseCli(["publish"], m);
    await runReleaseCli(["publish", "--ref", "feat/x"], m);
    expect(m.dispatch.mock.calls).toEqual([["wolf/1uk4"], ["feat/x"]]);
  });

  it("release --help prints usage and tags nothing; unknown flags are refused", async () => {
    const m = mocks();
    await runReleaseCli(["--help"], m);
    await expect(runReleaseCli(["--bogus"], m)).rejects.toThrow(/unknown argument "--bogus"/);
    expect(m.release).not.toHaveBeenCalled();
  });

  it("release passes parsed options through", async () => {
    const m = mocks();
    await runReleaseCli(["wolfd", "--minor", "--version", "1.2.3", "--dry-run", "-y"], m);
    expect(m.release).toHaveBeenCalledWith({ only: ["wolfd"], bump: "minor", version: "1.2.3", dryRun: true, yes: true });
  });
});
