import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { survivorOf, survivorsOf, resolveAliasedEntry } from "./alias.js";
import { ev } from "../shared/index.js";
import type { KbRoots } from "../shared/index.js";

describe("retire survivors lookup", () => {
  let base: string;
  let roots: KbRoots;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-surv-"));
    roots = { kbBase: base, opsRoot: join(base, "ops"), denLocal: join(base, "den") };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("prefers the structured survivors over the reason wording and falls back to the regex", () => {
    const log = [
      ev.entryRetired("kb-wp-AAAAAAA", "merged into kb-wp-WRONG11", ["kb-wp-BBBBBBB", "kb-wp-CCCCCCC"]),
      ev.entryRetired("kb-wp-DDDDDDD", "moved to kb-wp-EEEEEEE"),
      ev.entryRetired("kb-wp-FFFFFFF", "gone", []),
    ];
    expect(survivorsOf(log, "kb-wp-AAAAAAA")).toEqual(["kb-wp-BBBBBBB", "kb-wp-CCCCCCC"]);
    expect(survivorOf(log, "kb-wp-AAAAAAA")).toBe("kb-wp-BBBBBBB");
    expect(survivorsOf(log, "kb-wp-DDDDDDD")).toEqual(["kb-wp-EEEEEEE"]);
    expect(survivorsOf(log, "kb-wp-FFFFFFF")).toEqual([]);
    expect(survivorOf(log, "kb-wp-FFFFFFF")).toBeNull();
    expect(survivorsOf(log, "kb-wp-NEVER11")).toEqual([]);
  });

  it("resolveAliasedEntry follows the first structured survivor even when the reason names none", () => {
    mkdirSync(join(base, "domains", "wp", "entries"), { recursive: true });
    writeFileSync(join(base, "domains", "wp", "entries", "kb-wp-BBBBBBB.md"), "---\nid: kb-wp-BBBBBBB\n---\nbody");
    const log = [ev.entryRetired("kb-wp-AAAAAAA", "split into parts", ["kb-wp-BBBBBBB", "kb-wp-CCCCCCC"])];
    expect(resolveAliasedEntry(roots, log, "kb-wp-AAAAAAA", "wp")).toEqual({ id: "kb-wp-BBBBBBB", domain: "wp", followedFrom: "kb-wp-AAAAAAA" });
  });
});
