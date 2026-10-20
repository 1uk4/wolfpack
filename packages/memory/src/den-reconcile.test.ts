import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contentHash, type KbRoots } from "@wolfpack/kb/shared";
import { writeDenTopic } from "./den.js";
import { reconcileDen } from "./den-reconcile.js";
import { renderDenContext } from "./prompt-context.js";

const WOLF = "w1";
let root: string;
let den: string;
let roots: KbRoots;

const hex10 = (body: string) => contentHash(body).slice(7, 17);

function topic(id: string, body = `${id} body`, summary = `${id} summary`): string {
  writeDenTopic(den, { id, title: id, summary, updated: "2026-10-20 10:00", body });
  return body;
}

function receipt(id: string, body: string, outcome: string, detail: string): void {
  const dir = join(roots.opsRoot, "receipts", WOLF);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-${hex10(body)}.md`),
    `---\nfrom: ${WOLF}\nden_topic_id: ${id}\noutcome: ${outcome}\nprocessed: 2026-10-19 20:20\n---\n\n${detail}\n`,
  );
}

function inboxFile(id: string, body: string): void {
  const dir = join(roots.opsRoot, "inbox", WOLF);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}-${hex10(body)}.md`), "---\n---\n");
}

const topicsDir = () => join(den, "memory", "topics");
const archiveDir = () => join(den, "memory", "archive");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "den-reconcile-"));
  den = join(root, "den");
  roots = { kbBase: join(root, "kb"), opsRoot: join(root, "ops"), denLocal: join(den, "kb") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("reconcileDen", () => {
  it("archives topics whose current content has a create, merge or reject receipt", () => {
    receipt("created", topic("created"), "create", "kb-wolfpack-AAAAAAA");
    receipt("merged", topic("merged"), "merge", "kb-wolfpack-BBBBBBB");
    receipt("rejected", topic("rejected"), "reject", "archived-older-than-live: 2026-09-01 < 2026-10-01");

    const r = reconcileDen(den, roots, WOLF);

    expect(r.archived.map((a) => a.id).sort()).toEqual(["created", "merged", "rejected"]);
    expect(r.pending).toEqual([]);
    expect(readdirSync(topicsDir())).toEqual([]);
    expect(readdirSync(archiveDir()).sort()).toEqual(["created.md", "merged.md", "rejected.md"]);
  });

  it("records absorbed_into and absorbed_at on the archived file, keeping the original content", () => {
    receipt("t", topic("t", "original body"), "merge", "kb-wolfpack-ZMeaEMA");
    reconcileDen(den, roots, WOLF);

    const archived = readFileSync(join(archiveDir(), "t.md"), "utf-8");
    expect(archived).toMatch(/^---\nid: t\n/);
    expect(archived).toContain("absorbed_into: kb-wolfpack-ZMeaEMA");
    expect(archived).toContain("absorbed_at: 2026-10-19 20:20");
    expect(archived).toContain("original body");
    // reject receipts carry a reason, not an entry id
    receipt("r", topic("r"), "reject", "archived-older-than-live");
    reconcileDen(den, roots, WOLF);
    expect(readFileSync(join(archiveDir(), "r.md"), "utf-8")).toContain("absorbed_into: null");
  });

  it("keeps everything the KB does not hold yet, with a status", () => {
    receipt("unclassified", topic("unclassified"), "unclassified", "pending domain: fitness");
    receipt("parked", topic("parked"), "parked", "over budget. Re-run with: wolfpack-kb unpark ...");
    receipt("changed", topic("changed", "old body"), "merge", "kb-wolfpack-CCCCCCC");
    topic("changed", "new body since the receipt");
    inboxFile("queued", topic("queued"));
    topic("fresh");

    const r = reconcileDen(den, roots, WOLF);

    expect(r.archived).toEqual([]);
    const byId = Object.fromEntries(r.pending.map((p) => [p.id, p.status]));
    expect(byId).toEqual({
      unclassified: { kind: "awaiting-domain", domain: "fitness" },
      parked: { kind: "parked" },
      changed: { kind: "pending-promote" },
      queued: { kind: "awaiting-sweep" },
      fresh: { kind: "pending-promote" },
    });
    expect(readdirSync(topicsDir())).toHaveLength(5);
  });

  it("treats a hash in emitted.json as awaiting sweep", () => {
    const body = topic("emitted");
    mkdirSync(roots.denLocal, { recursive: true });
    writeFileSync(join(roots.denLocal, "emitted.json"), JSON.stringify({ emitted: contentHash(body) }));
    expect(reconcileDen(den, roots, WOLF).pending).toEqual([{ id: "emitted", status: { kind: "awaiting-sweep" } }]);
  });

  it("is idempotent", () => {
    receipt("t", topic("t"), "create", "kb-wolfpack-AAAAAAA");
    topic("p");
    reconcileDen(den, roots, WOLF);
    const second = reconcileDen(den, roots, WOLF);
    expect(second.archived).toEqual([]);
    expect(second.pending.map((p) => p.id)).toEqual(["p"]);
    expect(readdirSync(archiveDir())).toEqual(["t.md"]);
  });

  it("keeps an earlier archive of a returning subject", () => {
    receipt("t", topic("t", "first stint"), "create", "kb-wolfpack-AAAAAAA");
    reconcileDen(den, roots, WOLF);
    const second = topic("t", "second stint");
    receipt("t", second, "merge", "kb-wolfpack-AAAAAAA");
    reconcileDen(den, roots, WOLF);

    expect(readdirSync(archiveDir()).sort()).toEqual([`t-${hex10(second)}.md`, "t.md"]);
    expect(readFileSync(join(archiveDir(), "t.md"), "utf-8")).toContain("first stint");
  });

  it("archives nothing without KB roots", () => {
    topic("t");
    const r = reconcileDen(den, undefined, WOLF);
    expect(r).toEqual({ archived: [], pending: [{ id: "t", status: { kind: "pending-promote" } }] });
    expect(existsSync(archiveDir())).toBe(false);
  });
});

describe("renderDenContext", () => {
  it("lists only pending topics: folder once, filename, status and summary", () => {
    receipt("absorbed", topic("absorbed"), "merge", "kb-wolfpack-AAAAAAA");
    inboxFile("queued", topic("queued", "q", "queued work"));
    receipt("homeless", topic("homeless", "h", "needs a domain"), "unclassified", "pending domain: fitness");

    const out = renderDenContext(den, WOLF, roots)!;

    expect(out.split("\n")).toEqual([
      `Wolf w1's den topics not yet in the shared KB (2), in ${topicsDir()}/:`,
      "- homeless.md [awaiting domain: fitness] -- needs a domain",
      "- queued.md [awaiting sweep] -- queued work",
      "Read a topic file when you need its details. Everything else lives in the KB.",
    ]);
  });

  it("hides absorbed topics even before reconcile moves them", () => {
    receipt("absorbed", topic("absorbed"), "create", "kb-wolfpack-AAAAAAA");
    expect(renderDenContext(den, WOLF, roots)).toBeNull();
    expect(existsSync(join(topicsDir(), "absorbed.md"))).toBe(true);
  });

  it("returns null when nothing is pending", () => {
    expect(renderDenContext(den, WOLF, roots)).toBeNull();
    receipt("t", topic("t"), "create", "kb-wolfpack-AAAAAAA");
    reconcileDen(den, roots, WOLF);
    expect(renderDenContext(den, WOLF, roots)).toBeNull();
  });
});
