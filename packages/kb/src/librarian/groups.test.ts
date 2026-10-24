/**
 * Entry groups: an entry that sits under another anchored entry (a standing
 * feature's under its initiative's). Reading, ordering, Delivered sync, section
 * pinning, vectors, counts, INDEX/digest and the contribution round trip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { anchorIndex, groupDateOf, groupMembers, groupOf } from "./anchors.js";
import { syncDelivered } from "./groups.js";
import { buildEntryVectors } from "./embed.js";
import { reorg, repinGroups, readSectionCounts } from "./reorg.js";
import { renderDomainDigest, renderDomainIndex, orderGroups } from "./domains.js";
import { writeSections } from "./sections.js";
import { drainInbox } from "./intake.js";
import { emitDelta } from "../client/emitDelta.js";
import { assembleEntry, type Section } from "../schema/knowledge.js";
import type { KbRoots } from "../shared/index.js";

describe("entry groups", () => {
  let base: string;
  let roots: KbRoots;
  const dir = () => join(roots.kbBase, "domains", "wp", "entries");
  const HOLDER = "kb-wp-HOLDER1";
  const KEY = "work-wp-INITI01";

  const write = (id: string, o: { title?: string; section?: string; anchor?: string; group?: string; groupDate?: string; created?: string; body?: string } = {}) =>
    writeFileSync(
      join(dir(), `${id}.md`),
      [
        "---", `id: ${id}`, `title: "${o.title ?? id}"`, "domain: wp",
        o.anchor ? `anchor: ${o.anchor}` : null,
        o.group ? `group: ${o.group}` : null,
        o.groupDate ? `groupDate: ${o.groupDate}` : null,
        `section: ${o.section ?? "sec-wp-aaaaaa"}`,
        `created: ${o.created ?? "2026-10-01"}`, "contentHash: sha256:old", "---", "",
        `# ${o.title ?? id}`, "", `Summary of ${id}.`, "", o.body ?? "## How\n\nstuff\n\n## History\n\n- 2026-10-01: made.",
      ].filter((l) => l !== null).join("\n") + "\n",
    );
  const read = (id: string) => readFileSync(join(dir(), `${id}.md`), "utf8");

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-groups-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(dir(), { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  it("reads group, group date and members in group-date order; anchorIndex reports the grouped ids", () => {
    write(HOLDER, { anchor: KEY });
    write("kb-wp-LATER01", { anchor: "f2", group: KEY, groupDate: "2026-10-20" });
    write("kb-wp-EARLY01", { anchor: "f1", group: KEY, groupDate: "2026-10-14", created: "2026-10-25" });
    write("kb-wp-OTHER01", { anchor: "g1", group: "other-key", groupDate: "2026-10-01" });
    expect(groupOf(read("kb-wp-LATER01"))).toBe(KEY);
    expect(groupDateOf(read("kb-wp-LATER01"))).toBe("2026-10-20");
    expect(groupOf(read(HOLDER))).toBeUndefined();
    expect(groupMembers(roots, "wp", KEY).map((m) => m.id)).toEqual(["kb-wp-EARLY01", "kb-wp-LATER01"]);
    const idx = anchorIndex(roots, "wp");
    expect([...idx.grouped].sort()).toEqual(["kb-wp-EARLY01", "kb-wp-LATER01", "kb-wp-OTHER01"]);
    expect(idx.byKey.get(KEY)).toBe(HOLDER);
  });

  describe("syncDelivered", () => {
    it("rebuilds the holder's Delivered list in date order, keeping other bullets and links, and refreshes contentHash", () => {
      write(HOLDER, { anchor: KEY, body: "## How\n\nstuff\n\n## Delivered\n\n- Period B: [[kb-wp-SUBJ001]]\n- Unrelated item\n\n## History\n\n- 2026-10-01: made." });
      write("kb-wp-AAAAAAA", { title: "Period A", anchor: "fa", group: KEY, groupDate: "2026-10-14" });
      write("kb-wp-BBBBBBB", { title: "Period B", anchor: "fb", group: KEY, groupDate: "2026-10-20" });
      expect(syncDelivered(roots, "wp", KEY)).toBe(true);
      const md = read(HOLDER);
      expect(md).toContain("## Delivered\n\n- Unrelated item\n- Period A: [[kb-wp-AAAAAAA]]\n- Period B: [[kb-wp-SUBJ001]], [[kb-wp-BBBBBBB]]\n\n## History");
      expect(md).toMatch(/^contentHash: sha256:[0-9a-f]{64}$/m);
      expect(md).not.toContain("contentHash: sha256:old");
      // idempotent: nothing is rewritten the second time
      const before = read(HOLDER);
      expect(syncDelivered(roots, "wp", KEY)).toBe(false);
      expect(read(HOLDER)).toBe(before);
    });

    it("does nothing without members or without a holder", () => {
      write(HOLDER, { anchor: KEY });
      expect(syncDelivered(roots, "wp", KEY)).toBe(false);
      write("kb-wp-AAAAAAA", { anchor: "fa", group: "no-holder", groupDate: "2026-10-14" });
      expect(syncDelivered(roots, "wp", "no-holder")).toBe(false);
    });

    it("keeps the contentHash produce would compute for the same text", () => {
      write(HOLDER, { anchor: KEY, title: "Holder title" });
      write("kb-wp-AAAAAAA", { title: "Period A", anchor: "fa", group: KEY, groupDate: "2026-10-14" });
      syncDelivered(roots, "wp", KEY);
      const detail = read(HOLDER).split("\n").slice(read(HOLDER).split("\n").indexOf("## How")).join("\n").trim();
      // produce hashes title, summary and detail joined by newlines
      return import("../shared/hash.js").then(({ contentHash }) => {
        expect(read(HOLDER)).toContain(`contentHash: ${contentHash(["Holder title", "Summary of kb-wp-HOLDER1.", detail].join("\n"))}`);
      });
    });
  });

  describe("sections, vectors and counts", () => {
    const sec = (id: string, memberCount: number): Section =>
      ({
        id, domain: "wp", parent: null, depth: 0, label: id, title: `Root ${id}`, centroid: [0.5, 0.5, 0], memberCount, childIds: [],
        summary: "s", summaryHash: "h", dirty: false, memberCountAtLastLabel: memberCount, created: "2026-10-01", updated: "2026-10-01",
      }) as unknown as Section;

    it("repinGroups writes the holder's section onto its followers", () => {
      write(HOLDER, { anchor: KEY, section: "sec-wp-bbbbbb" });
      write("kb-wp-AAAAAAA", { anchor: "fa", group: KEY, groupDate: "2026-10-14", section: "sec-wp-aaaaaa" });
      write("kb-wp-BBBBBBB", { anchor: "fb", group: KEY, groupDate: "2026-10-20", section: "sec-wp-bbbbbb" });
      expect(repinGroups(roots, ["wp"])).toEqual(["kb-wp-AAAAAAA"]);
      expect(read("kb-wp-AAAAAAA")).toMatch(/^section: sec-wp-bbbbbb$/m);
      expect(repinGroups(roots, ["wp"])).toEqual([]);
      expect(repinGroups(roots, ["wp"], true)).toEqual([]); // dry run writes nothing
    });

    it("buildEntryVectors leaves grouped entries out (and does not embed them)", async () => {
      write(HOLDER, { anchor: KEY });
      write("kb-wp-AAAAAAA", { anchor: "fa", group: KEY, groupDate: "2026-10-14" });
      write("kb-wp-PLAIN01");
      const embedded: string[] = [];
      const embedder = { embed: async (text: string) => (embedded.push(text), [1, 0, 0]) };
      const v = await buildEntryVectors(roots, new Map(), embedder as any);
      expect(v.map((x) => x.entryId).sort()).toEqual([HOLDER, "kb-wp-PLAIN01"].sort());
      expect(embedded).toHaveLength(2);
    });

    it("a reorg repins followers to the holder's section and counts only non-grouped entries", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [0.5, 0.5, 0] }))));
      writeSections(roots, [sec("sec-wp-aaaaaa", 5), sec("sec-wp-bbbbbb", 5)]);
      write(HOLDER, { anchor: KEY, section: "sec-wp-bbbbbb" });
      write("kb-wp-PLAIN01", { section: "sec-wp-aaaaaa" });
      write("kb-wp-AAAAAAA", { anchor: "fa", group: KEY, groupDate: "2026-10-14", section: "sec-wp-aaaaaa" });
      write("kb-wp-BBBBBBB", { anchor: "fb", group: KEY, groupDate: "2026-10-20", section: "sec-wp-aaaaaa" });
      const engine = { call: vi.fn(), usage: { summarize: () => ({}) } } as unknown as Engine;
      await reorg({ engine, roots, domains: ["wp"], rebuild: false });
      const holderSection = read(HOLDER).match(/^section: (\S+)$/m)![1];
      for (const id of ["kb-wp-AAAAAAA", "kb-wp-BBBBBBB"]) expect(read(id)).toMatch(new RegExp(`^section: ${holderSection}$`, "m"));
      // the two followers are not members of any section's count
      expect(readSectionCounts(dir()).get(holderSection)).toBe(1);
      expect([...readSectionCounts(dir()).values()].reduce((a, b) => a + b, 0)).toBe(2);
    });
  });

  describe("INDEX and digest", () => {
    it("lists followers under their holder, indented, by group date; other entries are unchanged", () => {
      write(HOLDER, { anchor: KEY, title: "Initiative" });
      write("kb-wp-LATER01", { title: "Zeta period", anchor: "f2", group: KEY, groupDate: "2026-10-20" });
      write("kb-wp-EARLY01", { title: "Alpha period", anchor: "f1", group: KEY, groupDate: "2026-10-14" });
      write("kb-wp-PLAIN01", { title: "Beta plain" });
      renderDomainIndex(roots, "wp");
      const lines = readFileSync(join(roots.kbBase, "domains", "wp", "INDEX.md"), "utf8").split("\n").filter((l) => l.includes("[["));
      expect(lines.map((l) => l.replace(/ — .*/, ""))).toEqual([
        "- [[kb-wp-PLAIN01|Beta plain]]",
        "- [[kb-wp-HOLDER1|Initiative]]",
        "  - [[kb-wp-EARLY01|Alpha period]]",
        "  - [[kb-wp-LATER01|Zeta period]]",
      ]);
    });

    it("the digest orders a section's entries holder first, then followers by group date", () => {
      writeSections(roots, [
        { id: "sec-wp-aaaaaa", domain: "wp", parent: null, depth: 0, label: "a", title: "A", centroid: [1, 0, 0], memberCount: 4, childIds: [], summary: "s", summaryHash: "h", dirty: false, memberCountAtLastLabel: 4, created: "2026-10-01", updated: "2026-10-01" } as unknown as Section,
      ]);
      write("kb-wp-LATER01", { anchor: "f2", group: KEY, groupDate: "2026-10-20" });
      write("kb-wp-EARLY01", { anchor: "f1", group: KEY, groupDate: "2026-10-14" });
      write(HOLDER, { anchor: KEY });
      write("kb-wp-PLAIN01");
      renderDomainDigest(roots, "wp");
      const digest = JSON.parse(readFileSync(join(roots.kbBase, "domains", "wp", "_digest.json"), "utf8"));
      const ids: string[] = digest.sections[0].entryIds;
      expect(ids.indexOf("kb-wp-EARLY01")).toBe(ids.indexOf(HOLDER) + 1);
      expect(ids.indexOf("kb-wp-LATER01")).toBe(ids.indexOf(HOLDER) + 2);
      expect(ids).toHaveLength(4);
    });

    it("orderGroups leaves entries with no holder where they are", () => {
      const items = [
        { id: "a", anchor: "ka", groupDate: "" },
        { id: "f", anchor: "kf", group: "missing", groupDate: "2026-01-01" },
        { id: "b", groupDate: "" },
      ];
      expect(orderGroups(items).ordered.map((i) => i.id)).toEqual(["a", "f", "b"]);
    });
  });

  describe("the contribution round trip", () => {
    it("verbatim, group and group date survive emitDelta → inbox → drainInbox", () => {
      emitDelta({
        roots, wolf: "w1", denTopicId: "work-wp-FEATA01", change: "merge", domainHint: "wp", summary: "A summary.", body: "# T\n\nbody",
        anchor: "work-wp-FEATA01", verbatim: true, group: KEY, groupDate: "2026-10-14",
      });
      const [c] = drainInbox(roots);
      expect(c).toMatchObject({ anchor: "work-wp-FEATA01", verbatim: true, group: KEY, groupDate: "2026-10-14" });
    });

    it("plain contributions carry none of them; bad values are rejected", () => {
      emitDelta({ roots, wolf: "w1", denTopicId: "plain", change: "create", domainHint: "wp", summary: "s", body: "# T\n\nbody" });
      const [c] = drainInbox(roots);
      expect(c.verbatim).toBeUndefined();
      expect(c.group).toBeUndefined();
      expect(c.groupDate).toBeUndefined();
      expect(() => emitDelta({ roots, wolf: "w1", denTopicId: "x", change: "create", domainHint: "wp", summary: "s", body: "b", group: "bad key!" })).toThrow(/invalid group/);
      expect(() => emitDelta({ roots, wolf: "w1", denTopicId: "y", change: "create", domainHint: "wp", summary: "s", body: "b", group: KEY, groupDate: "14/10/2026" })).toThrow(/invalid groupDate/);
    });

    it("assembleEntry passes group and groupDate through", () => {
      const entry = assembleEntry({
        opinion: { title: "Title", kind: { type: "fact" }, summary: "s", detail: "d", confidence: "high", facets: {}, properties: {}, proposedRelations: [] } as any,
        facts: {
          id: "kb-wp-AAAAAAA", domain: "wp", created: "2026-10-01", updated: "2026-10-01", contentHash: "h", currency: "live",
          anchor: "fa", group: KEY, groupDate: "2026-10-14", relations: [], section: "sec-wp-aaaaaa", placement: { basis: "routed", fit: 1 },
        } as any,
        resolve: () => null,
      });
      expect(entry).toMatchObject({ anchor: "fa", group: KEY, groupDate: "2026-10-14" });
    });
  });
});
