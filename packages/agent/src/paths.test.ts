import { describe, expect, it } from "vitest";
import { kbBase, kbOps, kbRoot, wolfDen, wolfHome, wolfUser, workLedgerDir } from "./paths.js";

describe("agent paths", () => {
  it("defaults match the standard VPS layout", () => {
    expect(kbRoot({})).toBe("/var/wolfpack/kb");
    expect(kbBase({})).toBe("/var/wolfpack/kb/base");
    expect(kbOps({})).toBe("/var/wolfpack/kb/ops");
    expect(workLedgerDir({})).toBe("/var/wolfpack/kb/work");
    expect(wolfUser("abc", {})).toBe("wolf-abc");
    expect(wolfHome("abc", {})).toBe("/home/wolf-abc");
    expect(wolfDen("abc", {})).toBe("/home/wolf-abc/den");
  });
  it("honours env overrides", () => {
    const env = { WOLFPACK_KB_ROOT: "/srv/kb", WOLFPACK_HOME_ROOT: "/srv/wolves", WOLFPACK_USER_PREFIX: "w-" };
    expect(kbBase(env)).toBe("/srv/kb/base");
    expect(kbOps(env)).toBe("/srv/kb/ops");
    expect(wolfHome("x", env)).toBe("/srv/wolves/w-x");
    expect(kbBase({ ...env, KB_BASE: "/k/b" })).toBe("/k/b");
  });
});
