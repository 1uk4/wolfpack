import { describe, it, expect } from "vitest";
import { once } from "./entry-cache.js";

describe("once", () => {
  it("rethrows on every call while the computation keeps failing, and caches only a success", () => {
    let calls = 0;
    const f = once(() => {
      calls++;
      if (calls < 3) throw new Error("bad entry");
      return "ok";
    });
    expect(() => f()).toThrow("bad entry");
    expect(() => f()).toThrow("bad entry");
    expect(f()).toBe("ok");
    expect(f()).toBe("ok");
    expect(calls).toBe(3);
  });
});
