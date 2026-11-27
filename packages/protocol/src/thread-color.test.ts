import { describe, expect, it } from "vitest";
import { ThreadColorSchema, ThreadSettingsPatchSchema, ThreadSummarySchema, WolfSummarySchema } from "./schemas.js";

describe("thread colour schema", () => {
  it("accepts a newer palette key and still rejects junk", () => {
    expect(ThreadColorSchema.safeParse("indigo").success).toBe(true);
    expect(ThreadColorSchema.safeParse("teal").success).toBe(true);
    expect(ThreadColorSchema.safeParse("#ff0000").success).toBe(false);
    expect(ThreadColorSchema.safeParse("chartreuse").success).toBe(false);
  });

  it("reads degrade an unknown colour key to automatic, while the write patch stays strict", () => {
    const thread = ThreadSummarySchema.safeParse({
      id: "w/home",
      wolf: "w",
      kind: "home",
      title: "Home",
      settings: { tier: "main", autoShip: false, color: "chartreuse" },
    });
    expect(thread.success).toBe(true);
    expect(thread.success && thread.data.settings?.color).toBeUndefined();

    const wolf = WolfSummarySchema.safeParse({ id: "w1", name: "w", host: "h", status: "online", color: "chartreuse" });
    expect(wolf.success).toBe(true);
    expect(wolf.success && wolf.data.color).toBeUndefined();

    expect(ThreadSettingsPatchSchema.safeParse({ color: "chartreuse" }).success).toBe(false);
    expect(ThreadSettingsPatchSchema.safeParse({ color: "indigo" }).success).toBe(true);
  });
});
