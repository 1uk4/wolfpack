import { describe, it, expect } from "vitest";
import {
  extractDistilled,
  upsertRollupBlock,
  recomputeTotals,
  parseKeyedValue,
  sumKeys,
  rollupToParent,
  hasRollupZone,
  stripRollupMarkers,
  totalsSummary,
  type ChildMeta,
  type RollupClient,
} from "./rollup.js";

describe("extractDistilled", () => {
  it("prefers an explicit ## Rollup section", () => {
    const body = `# My Task

## Plan
blah

## Rollup
This is the distilled form.
Still inside.

## Notes
scratch`;
    expect(extractDistilled(body)).toBe("This is the distilled form.\nStill inside.");
  });

  it("falls back to whole body minus the H1 when no ## Rollup", () => {
    const body = `# Lower A — Oct 15

### Lifts
| Exercise | Reps |
|----------|------|
| Squat | 8 |

### Summary
Sets: 20 | Volume: 21,300 lb | Duration: 1:44`;
    const got = extractDistilled(body);
    expect(got.startsWith("### Lifts")).toBe(true);
    expect(got).toContain("Sets: 20 | Volume: 21,300 lb | Duration: 1:44");
  });

  it("returns empty when body is empty", () => {
    expect(extractDistilled("")).toBe("");
  });

  it("terminates ## Rollup at the next ## section", () => {
    const body = `# T\n\n## Rollup\ninner\n\n## Appendix\nnot in rollup`;
    expect(extractDistilled(body)).toBe("inner");
  });
});

describe("upsertRollupBlock", () => {
  const parent = (inner = "") => `# Week 42

## Sessions

<!-- rollup:children -->${inner}<!-- /rollup:children -->

## Totals
whatever`;

  const child = (id: string, when: string, title: string): ChildMeta => ({
    taskId: id,
    when,
    title,
  });

  it("inserts the first block when zone is empty", () => {
    const out = upsertRollupBlock(parent(""), child("t1", "2026-10-15", "Lower A"), "body A");
    expect(out).toContain("<!-- rollup:item id=t1 when=2026-10-15 -->");
    expect(out).toContain("### Thu 10/15 — Lower A");
    expect(out).toContain("body A");
    expect(out).toContain("<!-- /rollup:item -->");
  });

  it("replaces an existing block keyed by taskId", () => {
    let body = parent("");
    body = upsertRollupBlock(body, child("t1", "2026-10-15", "Lower A"), "v1");
    body = upsertRollupBlock(body, child("t1", "2026-10-15", "Lower A"), "v2 (corrected)");
    expect(body.match(/<!-- rollup:item id=t1 when=/g)?.length).toBe(1);
    expect(body).toContain("v2 (corrected)");
    expect(body).not.toContain("v1\n");
  });

  it("orders blocks chronologically", () => {
    let body = parent("");
    body = upsertRollupBlock(body, child("tC", "2026-10-18", "Lower B"), "C");
    body = upsertRollupBlock(body, child("tA", "2026-10-15", "Lower A"), "A");
    body = upsertRollupBlock(body, child("tB", "2026-10-16", "Upper Pull"), "B");
    const posA = body.indexOf("id=tA");
    const posB = body.indexOf("id=tB");
    const posC = body.indexOf("id=tC");
    expect(posA).toBeGreaterThan(0);
    expect(posA).toBeLessThan(posB);
    expect(posB).toBeLessThan(posC);
  });

  it("returns body unchanged when no rollup:children zone exists", () => {
    const body = "# Week with no zone\n\nsome content";
    const out = upsertRollupBlock(body, child("t1", "2026-10-15", "x"), "d");
    expect(out).toBe(body);
  });
});

describe("parseKeyedValue", () => {
  it("parses H:MM as minutes with time flag", () => {
    const v = parseKeyedValue("Duration: 1:44", "Duration");
    expect(v).toEqual({ n: 104, unit: "min", isTime: true });
  });

  it("parses commas in large numbers", () => {
    const v = parseKeyedValue("Volume: 21,300 lb", "Volume");
    expect(v).toEqual({ n: 21300, unit: "lb", isTime: false });
  });

  it("parses bare integers", () => {
    const v = parseKeyedValue("Sets: 20", "Sets");
    expect(v).toEqual({ n: 20, unit: "", isTime: false });
  });

  it("works case-insensitively on the key", () => {
    expect(parseKeyedValue("sets: 10", "Sets")?.n).toBe(10);
  });

  it("handles the Hal summary line with pipe separators", () => {
    const line = "Sets: 24 | Volume: 13,543 lb | Duration: 2:18";
    expect(parseKeyedValue(line, "Sets")?.n).toBe(24);
    expect(parseKeyedValue(line, "Volume")?.n).toBe(13543);
    expect(parseKeyedValue(line, "Duration")?.n).toBe(138);
  });

  it("ignores markdown bold around the value", () => {
    const v = parseKeyedValue("Sets: **24**", "Sets");
    expect(v?.n).toBe(24);
  });

  it("returns null on missing key", () => {
    expect(parseKeyedValue("Sets: 10", "Volume")).toBeNull();
  });
});

describe("sumKeys / recomputeTotals", () => {
  const buildParent = (childrenInner: string, totalsKeys = "Sets,Volume,Duration") =>
    `# W\n\n## Sessions\n<!-- rollup:children -->${childrenInner}<!-- /rollup:children -->\n\n## Totals\n<!-- rollup:totals keys="${totalsKeys}" -->placeholder<!-- /rollup:totals -->\n`;

  it("sums declared keys across all child blocks", () => {
    let body = buildParent("");
    body = upsertRollupBlock(body, { taskId: "a", when: "2026-10-15", title: "Lower A" },
      "**Sets: 20 | Volume: 21,300 lb | Duration: 1:44**");
    body = upsertRollupBlock(body, { taskId: "b", when: "2026-10-16", title: "Upper Pull" },
      "**Sets: 24 | Volume: 13,543 lb | Duration: 2:18**");
    body = recomputeTotals(body);

    expect(body).toContain("- Sessions: **2**");
    expect(body).toContain("- Sets: **44**");
    expect(body).toContain("- Volume: **34,843 lb**");
    expect(body).toContain("- Duration: **4:02**");
  });

  it("renders '—' when a declared key has no data", () => {
    let body = buildParent("", "Sets,Volume");
    body = upsertRollupBlock(body, { taskId: "a", when: "2026-10-15", title: "T" },
      "no keyed data here");
    body = recomputeTotals(body);
    expect(body).toContain("- Sets: **—**");
  });

  it("is idempotent: recomputing twice yields the same body", () => {
    let body = buildParent("");
    body = upsertRollupBlock(body, { taskId: "a", when: "2026-10-15", title: "T" }, "Sets: 10");
    const once = recomputeTotals(body);
    const twice = recomputeTotals(once);
    expect(twice).toBe(once);
  });

  it("no-op when totals zone missing", () => {
    const body = `# W\n<!-- rollup:children --><!-- /rollup:children -->\n`;
    expect(recomputeTotals(body)).toBe(body);
  });
});

describe("rollupToParent (orchestrator)", () => {
  function makeClient(items: any[], bodies: Record<string, string>): RollupClient & {
    writes: Record<string, string>;
  } {
    const writes: Record<string, string> = {};
    return {
      writes,
      async query({ ids }) {
        return items.filter((i) => (ids ?? []).includes(i.id));
      },
      async getBody(id) {
        return writes[id] ?? bodies[id] ?? "";
      },
      async updateBody(id, body) {
        writes[id] = body;
      },
    };
  }

  it("writes a rolled-up block into the parent", async () => {
    const client = makeClient(
      [
        { id: "task-1", kind: "task", title: "Upper Pull", partOf: "feat-1", updated: "2026-10-16" },
        { id: "feat-1", kind: "feature", title: "Week 42", partOf: null, updated: "2026-10-15" },
      ],
      {
        "task-1": "# Upper Pull\n\n### Summary\nSets: 24 | Volume: 13,543 lb | Duration: 2:18\n",
        "feat-1": `# Week 42\n\n## Sessions\n<!-- rollup:children -->\n<!-- /rollup:children -->\n\n## Totals\n<!-- rollup:totals keys="Sets,Volume,Duration" -->-<!-- /rollup:totals -->\n`,
      }
    );
    const r = await rollupToParent(client, "task-1");
    expect(r).toBe("written");
    expect(client.writes["feat-1"]).toContain("### Fri 10/16 — Upper Pull");
    expect(client.writes["feat-1"]).toContain("Sets: 24 | Volume: 13,543 lb | Duration: 2:18");
    expect(client.writes["feat-1"]).toContain("- Sets: **24**");
    expect(client.writes["feat-1"]).toContain("- Duration: **2:18**");
  });

  it("no-ops when the parent lacks the rollup zone", async () => {
    const client = makeClient(
      [
        { id: "task-1", kind: "task", title: "T", partOf: "feat-1", updated: "2026-10-16" },
        { id: "feat-1", kind: "feature", title: "W", partOf: null, updated: "2026-10-15" },
      ],
      { "task-1": "# T\n\nbody", "feat-1": "# W\n\nno zone here" }
    );
    const r = await rollupToParent(client, "task-1");
    expect(r).toBe("no-zone");
    expect(client.writes).toEqual({});
  });

  it("no-ops when the task has no parent feature", async () => {
    const client = makeClient(
      [{ id: "task-1", kind: "task", title: "T", partOf: null, updated: "2026-10-16" }],
      { "task-1": "# T" }
    );
    const r = await rollupToParent(client, "task-1");
    expect(r).toBe("no-parent");
  });

  it("no-ops when the parent is not a feature", async () => {
    const client = makeClient(
      [
        { id: "task-1", kind: "task", title: "T", partOf: "init-1", updated: "2026-10-16" },
        { id: "init-1", kind: "initiative", title: "I", partOf: null, updated: "2026-10-15" },
      ],
      {
        "task-1": "# T\nbody",
        "init-1": `# I\n<!-- rollup:children --><!-- /rollup:children -->`,
      }
    );
    const r = await rollupToParent(client, "task-1");
    expect(r).toBe("no-parent");
  });
});

describe("graduation helpers", () => {
  it("extractDistilled treats an untouched template body as empty", () => {
    expect(extractDistilled("# Lower A\n\n## Plan\n\n## Notes\n")).toBe("");
    expect(extractDistilled("# T\n\n## Plan\n\n## Notes\nreal note\n")).toBe("## Notes\nreal note");
  });

  it("stripRollupMarkers removes marker lines and keeps their content", () => {
    const body = "## S\n<!-- rollup:children -->\n<!-- rollup:item id=t1 when=2026-10-15 -->\n### Wed — A\nx\n<!-- /rollup:item -->\n<!-- /rollup:children -->\n";
    const out = stripRollupMarkers(body);
    expect(out).not.toContain("rollup:");
    expect(out).toContain("### Wed — A\nx");
    expect(hasRollupZone(body)).toBe(true);
    expect(hasRollupZone(out)).toBe(false);
  });

  it("totalsSummary flattens a populated totals block and skips empty keys", () => {
    const body = '<!-- rollup:totals keys="Sets,Volume,Duration" -->\n- Sessions: **4**\n- Sets: **74**\n- Volume: **—**\n- Duration: **6:32**\n<!-- /rollup:totals -->';
    expect(totalsSummary(body)).toBe("Sessions 4 · Sets 74 · Duration 6:32");
    expect(totalsSummary("# no totals")).toBeNull();
  });

  it("rollupToParent falls back to successCriteria when the task body is an empty template", async () => {
    const writes: Record<string, string> = {};
    const client: RollupClient = {
      async query({ ids }) {
        return [
          { id: "t1", kind: "task", title: "Add X", partOf: "f1", updated: "2026-10-16", successCriteria: "X works end to end" },
          { id: "f1", kind: "feature", title: "F", partOf: null, updated: "2026-10-15" },
        ].filter((i) => (ids ?? []).includes(i.id));
      },
      async getBody(id) {
        return writes[id] ?? (id === "t1" ? "# Add X\n\n## Plan\n\n## Notes\n" : "# F\n\n## Delivered\n<!-- rollup:children -->\n<!-- /rollup:children -->\n");
      },
      async updateBody(id, body) { writes[id] = body; },
    };
    expect(await rollupToParent(client, "t1")).toBe("written");
    expect(writes.f1).toContain("Delivered: X works end to end");
  });
});
