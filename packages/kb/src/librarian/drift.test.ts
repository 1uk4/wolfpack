import { describe, it, expect } from "vitest";
import { ledgeredByDomain, driftOf } from "./drift.js";

const w = (entryId: string) => ({ t: "entry_written", entryId });
const r = (entryId: string) => ({ t: "entry_retired", entryId });

describe("drift", () => {
  it("a retired entry is neither missing nor ledgered", () => {
    const led = ledgeredByDomain([w("kb-wp-AAAAAAA"), w("kb-wp-BBBBBBB"), r("kb-wp-AAAAAAA")]).get("wp")!;
    expect([...led]).toEqual(["kb-wp-BBBBBBB"]);
    expect(driftOf(["kb-wp-BBBBBBB"], led)).toEqual({ orphans: [], missing: [] });
  });

  it("still reports real orphans and real missing files", () => {
    const led = ledgeredByDomain([w("kb-wp-AAAAAAA"), w("kb-wp-BBBBBBB"), r("kb-wp-BBBBBBB")]).get("wp")!;
    // A.md is gone (missing); C.md was never ledgered and B.md was retired but left behind (orphans).
    expect(driftOf(["kb-wp-CCCCCCC", "kb-wp-BBBBBBB"], led)).toEqual({
      orphans: ["kb-wp-CCCCCCC", "kb-wp-BBBBBBB"],
      missing: ["kb-wp-AAAAAAA"],
    });
  });

  it("a rewritten entry after retirement is live again", () => {
    const led = ledgeredByDomain([w("kb-wp-AAAAAAA"), r("kb-wp-AAAAAAA"), w("kb-wp-AAAAAAA")]).get("wp")!;
    expect(led.has("kb-wp-AAAAAAA")).toBe(true);
  });
});
