import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRebuildRequester, planHash, type PlanSummary, type RebuildRequest } from "./rebuild-requests.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const plan = (planId: string, assignment: Array<[string, string]>): PlanSummary => ({ planId, domain: "wp", sectionIds: [...new Set(assignment.map((a) => a[1]))], assignment });

describe("sweep-driven rebuild requests", () => {
  it("files once per new plan hash and not again for the same domain within 24h", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rebuild-req-"));
    dirs.push(dir);
    let clock = Date.parse("2026-11-21T00:00:00Z");
    let next = plan("wp-1", [["e1", "s1"], ["e2", "s2"]]);
    const filed: RebuildRequest[] = [];
    let previews = 0;
    const mk = () => createRebuildRequester({ dataDir: dir, now: () => clock, log: () => {}, preview: async () => (previews++, next), notify: (r) => void filed.push(r) });
    const over = [{ id: "s0", count: 31 }];

    expect(await mk().onSplitDue("wp", over)).toBe("filed");
    expect(filed[0]).toMatchObject({ domain: "wp", planId: "wp-1", sections: 2, entries: 2 });

    clock += 60 * 60 * 1000; // 1h later (a new requester: the limit survives a restart via the file)
    expect(await mk().onSplitDue("wp", over)).toBe("rate-limited");
    expect(previews).toBe(1);

    clock += 24 * 60 * 60 * 1000;
    expect(await mk().onSplitDue("wp", over)).toBe("duplicate"); // same shape: previewed, not filed again
    expect(filed).toHaveLength(1);

    clock += 25 * 60 * 60 * 1000;
    next = plan("wp-2", [["e1", "s1"], ["e2", "s1"], ["e3", "s3"]]);
    expect(await mk().onSplitDue("wp", over)).toBe("filed");
    expect(filed.map((r) => r.planId)).toEqual(["wp-1", "wp-2"]);
  });

  it("hashes the same plan the same regardless of order, and a changed assignment differently", () => {
    const a = planHash({ sectionIds: ["b", "a"], assignment: [["e2", "b"], ["e1", "a"]] });
    expect(planHash({ sectionIds: ["a", "b"], assignment: [["e1", "a"], ["e2", "b"]] })).toBe(a);
    expect(planHash({ sectionIds: ["a", "b"], assignment: [["e1", "b"], ["e2", "a"]] })).not.toBe(a);
  });
});
