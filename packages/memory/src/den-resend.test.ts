import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contentHash, type KbRoots } from "@wolfpack/kb/shared";
import { writeDenTopic, readArchivedDenTopics, readResendTopics } from "./den.js";
import { reconcileDen } from "./den-reconcile.js";
import { readResendSet, resendDenTopics } from "./resend.js";
import type { PromoteStats } from "./distill.js";

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

/** Write an archived stint. id/absorbedAt undefined = field left out of the frontmatter. */
function archived(file: string, id: string | undefined, body: string, absorbedAt: string | undefined, into: string | null = "kb-wolfpack-AAAAAAA", mtimeSec?: number): void {
  const dir = join(den, "memory", "archive");
  mkdirSync(dir, { recursive: true });
  const fm = [
    id !== undefined ? `id: ${id}` : null,
    `title: ${id ?? "x"}`,
    "summary: s",
    "updated: 2026-10-01 10:00",
    `absorbed_into: ${into ?? "null"}`,
    absorbedAt !== undefined ? `absorbed_at: ${absorbedAt}` : null,
  ].filter(Boolean).join("\n");
  writeFileSync(join(dir, file), `---\n${fm}\n---\n\n${body}\n`);
  if (mtimeSec !== undefined) utimesSync(join(dir, file), mtimeSec, mtimeSec);
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

  it("without an id in the frontmatter, the filename fallback drops a trailing -<hash10>", () => {
    archived("t-0123456789.md", undefined, "suffixed", "2026-10-10 10:00");
    archived("plain.md", undefined, "plain", "2026-10-10 10:00");
    expect(readArchivedDenTopics(den).map((t) => t.id).sort()).toEqual(["plain", "t"]);
  });

  it("a missing absorbed_at reads as empty", () => {
    archived("t.md", "t", "body", undefined);
    expect(readArchivedDenTopics(den)).toMatchObject([{ id: "t", absorbedAt: "" }]);
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

  it("a stint without absorbed_at counts as the oldest: it loses to a dated stint and sorts first", () => {
    archived("t.md", "t", "undated", undefined);
    archived("t-0123456789.md", "t", "dated", "2026-10-01 10:00");
    archived("u.md", "u", "u undated", undefined);
    const { archived: a } = readResendTopics(den);
    expect(a.map((t) => [t.id, t.body])).toEqual([["u", "u undated"], ["t", "dated"]]);
  });

  it("equal absorbed_at: the newer file mtime wins, whichever file is hash-suffixed", () => {
    archived("t.md", "t", "plain, newer file", "2026-10-01 10:00", "kb-wolfpack-AAAAAAA", 2_000_000_000);
    archived("t-0123456789.md", "t", "suffixed, older file", "2026-10-01 10:00", "kb-wolfpack-AAAAAAA", 1_000_000_000);
    expect(readResendTopics(den).archived.map((t) => t.body)).toEqual(["plain, newer file"]);

    archived("t.md", "t", "plain, older file", "2026-10-01 10:00", "kb-wolfpack-AAAAAAA", 1_000_000_000);
    archived("t-0123456789.md", "t", "suffixed, newer file", "2026-10-01 10:00", "kb-wolfpack-AAAAAAA", 2_000_000_000);
    expect(readResendTopics(den).archived.map((t) => t.body)).toEqual(["suffixed, newer file"]);
  });

  it("equal absorbed_at and mtime: the larger path wins, so the pick is deterministic", () => {
    archived("t.md", "t", "plain", "2026-10-01 10:00", "kb-wolfpack-AAAAAAA", 1_000_000_000);
    archived("t-0123456789.md", "t", "suffixed", "2026-10-01 10:00", "kb-wolfpack-AAAAAAA", 1_000_000_000);
    // "t.md" > "t-0123456789.md" ('.' sorts after '-')
    expect(readResendTopics(den).archived.map((t) => t.body)).toEqual(["plain"]);
  });

  it("an empty den yields nothing", () => {
    expect(readResendTopics(den)).toEqual({ archived: [], pending: [] });
  });
});

describe("resendDenTopics (the path /wolf:resend-all and --emit-den share)", () => {
  const stats: PromoteStats = { distilled: 0, split: 0, held: 0, trivialSkipped: 0, pending: 0, emitted: 3 };

  it("sends archived then pending topics, drops unpromotable ones, and forces", async () => {
    archived("a.md", "a", "archived body", "2026-10-01 10:00");
    writeDenTopic(den, { id: "p", title: "p", summary: "s", updated: "2026-10-20 10:00", body: "pending body" });
    writeDenTopic(den, { id: "h", title: "h", summary: "s", updated: "2026-10-20 10:00", body: "held", promotable: false, promotableReason: "session log" });
    const set = readResendSet(den);
    const promote = vi.fn(async () => stats);
    const opts = { engine: {} as any, roots, wolf: WOLF, defaultDomain: "wolfpack" };

    expect(await resendDenTopics(set, opts, promote)).toBe(stats);

    expect(promote).toHaveBeenCalledTimes(1);
    const [topics, passed] = promote.mock.calls[0] as unknown as [Array<{ id: string; body: string; change: string }>, Record<string, unknown>];
    expect(topics.map((t) => [t.id, t.body, t.change])).toEqual([
      ["a", "archived body", "create"],
      ["p", "pending body", "create"],
    ]);
    expect(passed).toMatchObject({ ...opts, force: true });
    expect(passed.onHold).toBeUndefined();
  });

  it("the extension and the CLI both go through readResendSet + resendDenTopics", () => {
    const src = (rel: string) => readFileSync(join(__dirname, rel), "utf-8");
    for (const file of ["../../../extensions/wolfpack-memory/index.ts", "./cli.ts"]) {
      const code = src(file);
      expect(code, file).toMatch(/readResendSet\(/);
      expect(code, file).toMatch(/resendDenTopics\(/);
      expect(code, file).not.toMatch(/readDenTopics\(|promoteTopics\(/);
    }
  });
});
