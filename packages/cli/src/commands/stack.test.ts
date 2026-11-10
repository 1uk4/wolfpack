import { afterEach, describe, expect, it, vi } from "vitest";
import { stackCmd } from "./stack.js";

// Only argv that the scripts reject in parseArgs, before any launchctl/ps/spawn: these never touch the live stack.
describe("wolfpack stack", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes argv to the scripts and maps their errors to `stack: <msg>` and exit 1", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const codes = [await stackCmd(["nope"]), await stackCmd(["dev", "--zzz"]), await stackCmd(["dev", "start", "--app", "x"])];
    expect(codes).toEqual([1, 1, 1]);
    // "dev" is stripped before dev-stack sees argv: it rejects --zzz, not "dev"
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/^stack: usage: pnpm stack <install\|start\|stop\|restart\|status\|logs\|uninstall> .*unknown command "nope"/),
      expect.stringMatching(/^stack: unknown option "--zzz"/),
      expect.stringMatching(/^stack: --app must be one of console\|none, got "x"$/),
    ]);
  });
});
