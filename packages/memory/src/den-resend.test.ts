import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contentHash, type KbRoots } from "@wolfpack/kb/shared";
import { writeDenTopic, readArchivedDenTopics, readResendTopics } from "./den.js";
import { reconcileDen } from "./den-reconcile.js";

const WOLF = "w1";
let root: string;
let den: string;
let roots: KbRoots;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "den-resend-"));
  den = join(root, "den");
  roots = { kbBase: join(root, "kb"), opsRoot: join(root, "ops"), denLocal: join(den, "kb") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function archived(file: string, id: string, body: string, absorbedAt: string, into: string | null = "kb-wolfpack-AAAAAAA"): void {
  const dir = join(den, "memory", "archive");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, file),
    `---\nid: ${id}\ntitle: ${id}\nsummary: s\nupdated: 2026-10-01 10:00\nabsorbed_into: ${into ?? "null"}\nabsorbed_at: ${absorbedAt}\n---\n\n${body}\n`,
  );
}

describe("readArchivedDenTopics", () => {
  it("reads what reconcile archived, with its receipt fields", () => {
    const body = "t body";
    writeDenTopic(den, { id: "t", title: "t", summary: "s", updated: "2026-10-20 10:00", body });
    const dir = join(roots.opsRoot, "receipts", WOLF);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `t-${contentHash(body).slice(7, 17)}.md`),
      `---\nfrom: ${WOLF}\nden_topic_id: t\noutcome: create\nprocessed: 2026-10-19 20:20\n---\n\nkb-wolfpack-AAAAAAA\n`,
    );
    reconcileDen(den, roots, WOLF);

    const [a] = readArchivedDenTopics(den);
    expect(a).toMatchObject({ id: "t", body, absorbedInto: "kb-wolfpack-AAAAAAA" });
    expect(a.absorbedAt).not.toBe("");
  });

  it("takes the id from frontmatter for a hash-suffixed stint; a reject has absorbedInto null", () => {
    archived("t-0123456789.md", "t", "second", "2026-10-10 10:00", null);
    expect(readArchivedDenTopics(den)).toMatchObject([{ id: "t", absorbedInto: null }]);
  });
});

describe("readResendTopics", () => {
  it("keeps the latest stint per id, includes rejects, orders archived oldest first", () => {
    archived("t.md", "t", "first stint", "2026-10-01 10:00");
    archived("t-0123456789.md", "t", "second stint", "2026-10-15 10:00");
    archived("r.md", "r", "rejected", "2026-10-05 10:00", null);
    const { archived: a, pending } = readResendTopics(den);
    expect(a.map((t) => [t.id, t.body])).toEqual([["r", "rejected"], ["t", "second stint"]]);
    expect(pending).toEqual([]);
  });

  it("a pending topic supersedes archived stints of the same id", () => {
    archived("t.md", "t", "old stint", "2026-10-01 10:00");
    archived("u.md", "u", "u stint", "2026-10-01 10:00");
    writeDenTopic(den, { id: "t", title: "t", summary: "s", updated: "2026-10-20 10:00", body: "returning subject" });
    const { archived: a, pending } = readResendTopics(den);
    expect(a.map((t) => t.id)).toEqual(["u"]);
    expect(pending.map((t) => [t.id, t.body])).toEqual([["t", "returning subject"]]);
  });

  it("an empty den yields nothing", () => {
    expect(readResendTopics(den)).toEqual({ archived: [], pending: [] });
  });
});
