import { describe, expect, it } from "vitest";
import { resolveKbOps } from "./run.js";

describe("workerd kb ops location", () => {
  const HOME = "/h";
  it("with nothing set and --wolves ~/wolves/local it is ~/wolves/librarian", () => {
    expect(resolveKbOps({ wolvesDir: "/h/wolves/local" }, { HOME })).toBe("/h/wolves/librarian");
  });
  it("an explicit wolvesDir does not hide WOLFPACK_KB_OPS", () => {
    expect(resolveKbOps({ wolvesDir: "/h/wolves/local" }, { HOME, WOLFPACK_KB_OPS: "/app/ops" })).toBe("/app/ops");
  });
  it("an option beats KB_OPS, and KB_OPS beats WOLFPACK_KB_OPS", () => {
    const env = { HOME, KB_OPS: "/e1", WOLFPACK_KB_OPS: "/e2" };
    expect(resolveKbOps({ kbOps: "/o", wolvesDir: "/w/local" }, env)).toBe("/o");
    expect(resolveKbOps({ wolvesDir: "/w/local" }, env)).toBe("/e1");
  });
  it("empty KB_OPS and WOLFPACK_KB_OPS count as unset", () => {
    expect(resolveKbOps({ wolvesDir: "/h/wolves/local" }, { HOME, KB_OPS: "", WOLFPACK_KB_OPS: " " })).toBe("/h/wolves/librarian");
    expect(resolveKbOps({ wolvesDir: "/h/wolves/local" }, { HOME, KB_OPS: "", WOLFPACK_KB_OPS: "/e2" })).toBe("/e2");
  });
  it("without a wolvesDir it uses the resolver default", () => {
    expect(resolveKbOps({}, { HOME, WOLFPACK_WOLVES_ROOT: "/r" })).toBe("/r/librarian");
  });
  it("WOLFPACK_HOME does not move it", () => {
    expect(resolveKbOps({ wolvesDir: "/h/wolves/local" }, { HOME, WOLFPACK_HOME: "/app" })).toBe("/h/wolves/librarian");
  });
});
