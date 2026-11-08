import { describe, expect, it } from "vitest";
import { resolveWolfHome } from "./wolf-home.js";

describe("resolveWolfHome", () => {
  it("WOLF_HOME wins; otherwise the parent of WOLF_DEN (<wolf-home>/den); otherwise undefined", () => {
    expect(resolveWolfHome({ WOLF_HOME: "/w/a", WOLF_DEN: "/w/b/den" })).toBe("/w/a");
    expect(resolveWolfHome({ WOLF_DEN: "/w/b/den" })).toBe("/w/b");
    expect(resolveWolfHome({})).toBeUndefined();
  });
});
