import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "@wolfpack/engine";
import { consolidateSession, refuseTagged } from "./consolidate.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "promote-guard-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function topic(id: string, extra = ""): void {
  const dir = join(root, ".memory", "sess-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: ${id}\nsummary: s\nupdated: 2026-10-20 10:00\n${extra}---\n\n${id} body\n`);
}

describe("promote guard", () => {
  it("refuseTagged drops anything with a work or feature tag", () => {
    const lines: string[] = [];
    expect(refuseTagged([{ n: 1 }, { n: 2, work: "w" }, { n: 3, feature: "f" }], (m) => lines.push(m))).toEqual([{ n: 1 }]);
    expect(lines[0]).toContain("refused 2");
  });

  it("promote never reads a tagged session topic", async () => {
    topic("tagged", "work: work-wolfpack-AAAAAAA\n");
    const engine = { call: async () => { throw new Error("no LLM call expected"); } } as unknown as Engine;
    const r = await consolidateSession({ engine, den: { denRoot: join(root, "den"), wolfName: "w" }, memoryRoot: join(root, ".memory"), sessionId: "sess-1", skipClaims: true });
    expect(r.topicsProcessed).toBe(0);
    expect(existsSync(join(root, "den", "memory", "topics", "tagged.md"))).toBe(false);
  });
});
