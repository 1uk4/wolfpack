import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderRetiredContext } from "./prompt-context.js";
import { updateTopicState } from "./promote-state.js";

const dens: string[] = [];
afterEach(() => { for (const d of dens.splice(0)) rmSync(d, { recursive: true, force: true }); });
const den = () => { const d = mkdtempSync(join(tmpdir(), "retired-ctx-")); dens.push(d); return d; };

describe("renderRetiredContext", () => {
  it("lists the KB entries of retired topics, following aliases, dropping dead ones and duplicates", () => {
    const d = den();
    const retired = { promotedAt: "2026-11-01T00:00:00.000Z", retiredAt: "2026-11-02T00:00:00.000Z" };
    updateTopicState(d, "a", { ...retired, receipt: { outcome: "create", entryIds: ["old-1"] } });
    updateTopicState(d, "b", { ...retired, receipt: { outcome: "merge", entryIds: ["e2", "dead"] } });
    updateTopicState(d, "c", { ...retired, receipt: { outcome: "create", entryIds: ["e2"] } });
    updateTopicState(d, "live", { promotedAt: "2026-11-01T00:00:00.000Z", receipt: { outcome: "create", entryIds: ["e9"] } });
    const out = renderRetiredContext(d, {
      resolveEntry: (id) => (id === "old-1" ? "e1" : id === "dead" ? null : id),
      readEntry: (id) => ({ title: `Title ${id}`, summary: `About ${id}` }),
    })!;
    expect(out).toContain("- Title e1 (e1): About e1");
    expect(out).toContain("- Title e2 (e2): About e2");
    expect(out.match(/\(e2\)/g)).toHaveLength(1);
    expect(out).not.toContain("dead");
    expect(out).not.toContain("e9");
  });

  it("is null when nothing was retired", () => {
    expect(renderRetiredContext(den(), { resolveEntry: (i) => i, readEntry: () => null })).toBeNull();
  });
});
