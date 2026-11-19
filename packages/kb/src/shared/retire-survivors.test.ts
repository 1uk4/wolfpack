import { describe, it, expect } from "vitest";
import { ev, KbEventSchema } from "./index.js";

describe("entry_retired survivors field", () => {
  it("parses an old event without survivors and keeps survivors on a new one", () => {
    const old = { t: "entry_retired", id: "e1", at: "2026-11-01T00:00:00.000Z", entryId: "kb-wp-Old1111", reason: "merged into kb-wp-New2222" };
    const parsed = KbEventSchema.parse(old);
    expect(parsed).not.toHaveProperty("survivors");

    const next = ev.entryRetired("kb-wp-Old1111", "merged into kb-wp-New2222", ["kb-wp-New2222"]);
    expect(KbEventSchema.parse(next)).toMatchObject({ entryId: "kb-wp-Old1111", survivors: ["kb-wp-New2222"] });
  });

  it("emits an explicit empty survivors list when the retire has no replacement", () => {
    expect(ev.entryRetired("kb-wp-Old1111", "no longer true", [])).toMatchObject({ survivors: [] });
    expect(ev.entryRetired("kb-wp-Old1111", "no longer true")).not.toHaveProperty("survivors");
  });
});
