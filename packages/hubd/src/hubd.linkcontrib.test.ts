import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "@wolfpack/kb/shared";
import { createLinkContributions } from "./link-contributions.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const c = (n: number) => ({ from: "alpha", denTopicId: `t${n}`, change: "create", contentHash: contentHash(`b${n}`), prevHash: null, domainHint: "wolfpack", summary: "s", submitted: "2026-10-01 12:00", body: `b${n}`, origin: "crawl", sourcePath: "/s" });

describe("link contributions id set", () => {
  it("is bounded: only the newest ids are kept across a reload, and kept ids still dedup", () => {
    const dir = mkdtempSync(join(tmpdir(), "lc-"));
    dirs.push(dir);
    let t = 1000;
    const mk = () => createLinkContributions({ dataDir: dir, inboxRoot: join(dir, "in"), receiptsRoot: join(dir, "rc"), hostOf: () => "box", send: () => false, seenMax: 4, receiptPollMs: 0, now: () => t++, log: () => {} });
    const a = mk();
    for (let i = 0; i < 12; i++) expect(a.onContribute("box", { t: "contribute", id: `id${i}`, wolf: "alpha", contribution: c(i) }).status).toBe("accepted");
    const b = mk(); // reload compacts to the newest 4
    const lines = readFileSync(join(dir, "link", "contribution-ids.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(b.onContribute("box", { t: "contribute", id: "id11", wolf: "alpha", contribution: c(11) }).status).toBe("duplicate");
    a.stop();
    b.stop();
  });
});
