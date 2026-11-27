import { describe, expect, it } from "vitest";
import { ThreadColorSchema } from "./schemas.js";

describe("thread colour schema", () => {
  it("accepts a newer palette key and still rejects junk", () => {
    expect(ThreadColorSchema.safeParse("indigo").success).toBe(true);
    expect(ThreadColorSchema.safeParse("teal").success).toBe(true);
    expect(ThreadColorSchema.safeParse("#ff0000").success).toBe(false);
    expect(ThreadColorSchema.safeParse("chartreuse").success).toBe(false);
  });
});
