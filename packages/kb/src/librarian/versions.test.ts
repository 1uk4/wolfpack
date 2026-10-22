import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { PRODUCE_SYSTEM } from "@wolfpack/engine";
import { commitEntry } from "./commit.js";
import { retireEntries } from "./retire.js";
import { writeEntrySection } from "./reorg.js";
import { currentEntryHashes } from "./embed.js";
import { produceEntry } from "./produce.js";
import { listVersions, readVersion } from "./versions.js";
import { appendLedger } from "./ledger.js";
import { ev, entryVersionsDir, type KbRoots, type ParsedContribution } from "../shared/index.js";
import { type Entry, EntryId, DomainId, SectionId, IsoDate, type RelationResolver } from "../schema/knowledge.js";

const ID = "kb-wolfpack-abc1234";

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: EntryId.parse(ID),
    domain: DomainId.parse("wolfpack"),
    title: "Test Entry",
    kind: { type: "architecture" },
    summary: "Test summary",
    detail: "Test detail",
    confidence: "high",
    facets: {},
    properties: {},
    section: SectionId.parse("sec-wolfpack-abc123"),
    placement: { basis: "routed", fit: 0.85 },
    relations: [],
    authority: "curated",
    maturity: "active",
    currency: "live",
    verified: false,
    created: IsoDate.parse("2026-01-01"),
    updated: IsoDate.parse("2026-01-02"),
    contentHash: "h1",
    ...over,
  };
}

describe("entry versions", () => {
  let tmp: string;
  let roots: KbRoots;
  const entriesPath = () => join(tmp, "domains", "wolfpack", "entries");
  const file = () => join(entriesPath(), `${ID}.md`);
  const versions = () => listVersions(roots, "wolfpack", ID);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kb-versions-"));
    roots = { kbBase: tmp, opsRoot: join(tmp, "ops"), denLocal: join(tmp, "wolfden", "kb") };
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("first write makes no snapshot; an overwrite keeps the previous file", () => {
    commitEntry(roots, entry());
    expect(versions()).toEqual([]);
    const first = readFileSync(file(), "utf-8");

    commitEntry(roots, entry({ detail: "Changed detail" }));
    const v = versions();
    expect(v).toHaveLength(1);
    expect(v[0].timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z$/);
    expect(v[0].firstLine).toBe("# Test Entry");
    expect(readVersion(roots, "wolfpack", ID, v[0].timestamp)).toBe(first);
    expect(readFileSync(file(), "utf-8")).toContain("Changed detail");
  });

  it("identical content and date-only re-stamps are not versioned", () => {
    commitEntry(roots, entry());
    commitEntry(roots, entry());
    commitEntry(roots, entry({ updated: IsoDate.parse("2026-02-02"), contentHash: "h2" }));
    expect(versions()).toEqual([]);
  });

  it("skips a snapshot identical to the latest one", () => {
    commitEntry(roots, entry());
    const x = readFileSync(file(), "utf-8");
    commitEntry(roots, entry({ detail: "Y" })); // snapshots x
    writeFileSync(file(), x); // the old text comes back (e.g. a sync restore)
    commitEntry(roots, entry({ detail: "Y" })); // previous == latest snapshot
    expect(versions()).toHaveLength(1);
  });

  it("title, kind and properties changes are versioned", () => {
    commitEntry(roots, entry());
    commitEntry(roots, entry({ title: "New Title" }));
    commitEntry(roots, entry({ title: "New Title", kind: { type: "decision" } }));
    commitEntry(roots, entry({ title: "New Title", kind: { type: "decision" }, properties: { host: "a" } }));
    expect(versions()).toHaveLength(3);
  });

  it("placement-only changes (section, placement) are not versioned", () => {
    commitEntry(roots, entry());
    commitEntry(roots, entry({ section: SectionId.parse("sec-wolfpack-zzz999"), placement: { basis: "crystallized", fit: 0.5 } }));
    writeEntrySection(entriesPath(), ID, "sec-wolfpack-qqq111");
    expect(readFileSync(file(), "utf-8")).toContain("section: sec-wolfpack-qqq111");
    expect(existsSync(join(tmp, "domains", "wolfpack", "versions"))).toBe(false);
  });

  it("retire moves the file into versions/ with -retired instead of deleting it", () => {
    commitEntry(roots, entry());
    const content = readFileSync(file(), "utf-8");
    appendLedger(roots, [ev.entryWritten(ID, ID, "create")]);

    retireEntries(roots, [ID], { reason: "gone" });

    expect(existsSync(file())).toBe(false);
    const v = versions();
    expect(v).toHaveLength(1);
    expect(v[0].retired).toBe(true);
    expect(readdirSync(entryVersionsDir(roots, "wolfpack", ID))[0]).toMatch(/-retired\.md$/);
    expect(readVersion(roots, "wolfpack", ID, v[0].timestamp)).toBe(content);
  });

  it("versions/ is not seen by entry scans (embeddings) or status", () => {
    commitEntry(roots, entry());
    commitEntry(roots, entry({ detail: "Changed" }));
    mkdirSync(entriesPath(), { recursive: true });
    expect(versions()).toHaveLength(1);
    // One live entry -> one hash, though two files hold this entry's id.
    expect(currentEntryHashes(roots, "m").size).toBe(1);

    const cli = resolve(__dirname, "../../dist/cli.js");
    if (!existsSync(cli)) return; // needs `npm run build`
    appendLedger(roots, [ev.entryWritten(ID, ID, "create")]);
    const out = execFileSync("node", [cli, "status"], {
      env: { ...process.env, KB_BASE: tmp, KB_OPS: roots.opsRoot, WOLF_DEN: join(tmp, "wolfden") },
      encoding: "utf-8",
    });
    expect(out).not.toMatch(/orphan|missing/i);
  });

  it("bare CLI prints usage and writes nothing (no implicit sweep)", () => {
    const cli = resolve(__dirname, "../../dist/cli.js");
    if (!existsSync(cli)) return; // needs `npm run build`
    const env = { ...process.env, KB_BASE: tmp, KB_OPS: roots.opsRoot, WOLF_DEN: join(tmp, "wolfden") };
    let status = 0;
    let stderr = "";
    try {
      execFileSync("node", [cli], { env, encoding: "utf-8", stdio: "pipe" });
    } catch (e: unknown) {
      status = (e as { status?: number }).status ?? -1;
      stderr = String((e as { stderr?: string }).stderr ?? "");
    }
    expect(status).toBe(2);
    expect(stderr).toMatch(/Usage: wolfpack-kb <command>/);
    expect(existsSync(join(tmp, "wolfden"))).toBe(false);
  });

  it("history CLI lists versions and --show prints one", () => {
    commitEntry(roots, entry());
    commitEntry(roots, entry({ detail: "Changed" }));
    const cli = resolve(__dirname, "../../dist/cli.js");
    if (!existsSync(cli)) return; // needs `npm run build`
    const env = { ...process.env, KB_BASE: tmp, KB_OPS: roots.opsRoot, WOLF_DEN: join(tmp, "wolfden") };
    const out = execFileSync("node", [cli, "history", ID], { env, encoding: "utf-8" });
    const ts = versions()[0].timestamp;
    expect(out).toContain(ts);
    expect(out).toContain("# Test Entry");
    const shown = execFileSync("node", [cli, "history", ID, "--show", ts.slice(0, 16)], { env, encoding: "utf-8" });
    expect(shown).toContain("Test detail");
    expect(shown).toBe(readVersion(roots, "wolfpack", ID, ts));
  });
});

// ── History sections + supersedeable decisions (produce plumbing) ──────────

function contribution(over: Partial<ParsedContribution> = {}): ParsedContribution {
  return {
    from: "w",
    denTopicId: "t1",
    summary: "s",
    body: "b",
    contentHash: "h",
    filePath: "/tmp/x.md",
    currency: "live",
    ...over,
  } as ParsedContribution;
}

function engineReturning(opinion: Record<string, unknown>) {
  const call = vi.fn().mockResolvedValue({
    title: "Test Entry",
    kind: { type: "architecture" },
    summary: "S",
    detail: "Body",
    confidence: "high",
    facets: {},
    properties: {},
    proposedRelations: [],
    ...opinion,
  });
  return { engine: { call } as unknown as Engine, call };
}

const base = {
  domain: "wolfpack",
  section: SectionId.parse("sec-wolfpack-abc123"),
  placement: { basis: "routed" as const, fit: 0.9 },
  resolve: (() => null) as RelationResolver,
};

describe("History section", () => {
  it("PRODUCE_SYSTEM asks for a dated History line per superseded fact", () => {
    expect(PRODUCE_SYSTEM).toContain("## History");
    expect(PRODUCE_SYSTEM).toContain("- Until <YYYY-MM-DD>: <old fact>. Now <new fact>, because <reason, if known>.");
    expect(PRODUCE_SYSTEM).toMatch(/never rewrite/i);
    expect(PRODUCE_SYSTEM).toContain("15 lines");
    expect(PRODUCE_SYSTEM).toContain("supersedesDecision");
  });

  it("passes the contribution date and carries the History line through to the file", async () => {
    const detail = "Runs on sfo02.\n\n## History\n\n- Until 2026-10-01: Ran on sfo01. Now sfo02, because of a datacenter move.";
    const { engine, call } = engineReturning({ detail });
    const { entry: e } = await produceEntry(engine, {
      ...base,
      contribution: contribution({ sourceUpdated: "2026-10-01" } as Partial<ParsedContribution>),
      entryId: ID,
      existingMarkdown: "---\nid: x\nkind: architecture\n---\nRuns on sfo01.",
    });
    expect(call.mock.calls[0][2].prompt).toContain("CONTRIBUTION DATE: 2026-10-01");
    expect(call.mock.calls[0][2].system).toContain("## History");

    expect(e.detail).toContain("- Until 2026-10-01: Ran on sfo01. Now sfo02");
  });
});

describe("decision entries", () => {
  const decision = "---\nid: kb-wolfpack-abc1234\nkind: decision\ncreated: 2026-01-01\n---\nWe use Postgres.";

  it("a contradicting contribution becomes a NEW decision that supersedes the old one", async () => {
    const { engine } = engineReturning({ kind: { type: "decision" }, detail: "We use SQLite.", supersedesDecision: true });
    const r = await produceEntry(engine, { ...base, contribution: contribution(), entryId: ID, existingMarkdown: decision });
    expect(r.action).toBe("create");
    expect(r.supersedes).toBe(ID);
    expect(r.entry.id).not.toBe(ID);
    expect(r.entry.kind).toEqual({ type: "decision" });
    expect(r.entry.relations).toContainEqual({ kind: "supersedes", target: ID, source: "code", weight: 1 });
    expect(r.entry.created).not.toBe("2026-01-01");
  });

  it("an agreeing contribution leaves the decision unchanged (nothing to commit)", async () => {
    const { engine } = engineReturning({ detail: "rewritten" });
    const r = await produceEntry(engine, { ...base, contribution: contribution(), entryId: ID, existingMarkdown: decision });
    expect(r.unchanged).toBe(true);
    expect(r.entry.id).toBe(ID);
    expect(r.supersedes).toBeUndefined();
  });

  it("supersedesDecision is ignored for non-decision entries", async () => {
    const { engine } = engineReturning({ supersedesDecision: true });
    const r = await produceEntry(engine, {
      ...base,
      contribution: contribution(),
      entryId: ID,
      existingMarkdown: "---\nkind: architecture\n---\nx",
    });
    expect(r.action).toBe("merge");
    expect(r.entry.id).toBe(ID);
    expect(r.unchanged).toBeUndefined();
  });
});
