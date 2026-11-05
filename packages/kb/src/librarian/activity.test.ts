import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KbEvent } from "../shared/index.js";
import { ACTIVITY_OUTCOMES, BAD_MAX, listDomains, INCOMING_STAT_CAP, buildActivityIndex, foldKbActivity, pageActivity, readIncoming, scanEntryInfo } from "./activity.js";

let n = 0;
const id = () => `e${String(++n).padStart(6, "0")}`;
const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 0, m)).toISOString();
const dec = (m: number, o: Partial<Extract<KbEvent, { t: "decision" }>> = {}): KbEvent => ({ t: "decision", id: id(), at: at(m), from: "w1", denTopicId: `t${m}`, hash: `h${m}`, outcome: "create", ...o }) as KbEvent;
const written = (m: number, entryId: string, action: "create" | "merge" | "supersede" = "create"): KbEvent => ({ t: "entry_written", id: id(), at: at(m), entryId, canonicalId: entryId, action });
const contrib = (m: number, from: string): KbEvent => ({ t: "contribution", id: id(), at: at(m), from, denTopicId: `c${m}`, hash: `c${m}`, prevHash: null, domainHint: "x" }) as KbEvent;
const retired = (m: number, entryId: string): KbEvent => ({ t: "entry_retired", id: id(), at: at(m), entryId });

describe("foldKbActivity decisions", () => {
  it("latest decision per (from, denTopicId, hash) wins and counts superseded", () => {
    const f = foldKbActivity([dec(1, { denTopicId: "a", hash: "x", outcome: "parked", reason: "no" }), dec(5, { denTopicId: "a", hash: "x", outcome: "merge", entryId: "kb-1" }), dec(3, { denTopicId: "a", hash: "y" })]);
    expect(f.decisions.total).toBe(2);
    expect(f.decisions.items.map((d) => [d.hash, d.outcome, d.superseded])).toEqual([["x", "merge", 1], ["y", "create", undefined]]);
    expect(f.decisions.counts.parked).toBe(0);
  });

  it("carries all six outcomes, an unclassified one and a parked one with its reason", () => {
    const f = foldKbActivity(ACTIVITY_OUTCOMES.map((o, i) => dec(i + 1, { outcome: o, ...(o === "parked" ? { reason: "budget" } : {}) })));
    expect(f.decisions.counts).toEqual({ create: 1, merge: 1, unchanged: 1, reject: 1, parked: 1, unclassified: 1 });
    expect(f.decisions.items.find((d) => d.outcome === "parked")?.reason).toBe("budget");
    expect(f.decisions.items.some((d) => d.outcome === "unclassified")).toBe(true);
  });

  it("a legacy ledger without decisions: hasDecisions false, empty feed", () => {
    const f = foldKbActivity([written(1, "kb-1")]);
    expect(f.hasDecisions).toBe(false);
    expect(f.decisions).toEqual({ items: [], total: 0, counts: { create: 0, merge: 0, unchanged: 0, reject: 0, parked: 0, unclassified: 0 } });
  });

  it("pages by cursor without overlap, newest first", () => {
    const evs = [1, 2, 3, 4, 5].map((m) => dec(m));
    const idx = buildActivityIndex(evs);
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 5; i++) {
      const p = pageActivity(idx, { limit: 2, before });
      seen.push(...p.decisions.items.map((d) => d.denTopicId));
      expect(p.decisions.total).toBe(5);
      if (!p.decisions.nextCursor) break;
      before = p.decisions.nextCursor;
    }
    expect(seen).toEqual(["t5", "t4", "t3", "t2", "t1"]);
  });

  it("clips by window; counts follow the window", () => {
    const f = foldKbActivity([dec(1), dec(10, { outcome: "reject" })], { sinceMs: Date.parse(at(5)) });
    expect(f.decisions.total).toBe(1);
    expect(f.decisions.counts.reject).toBe(1);
    expect(f.decisions.counts.create).toBe(0);
  });

  it("filters by domain through the decision's entry", () => {
    const info = new Map([["kb-a", { domain: "alpha" }], ["kb-b", { domain: "beta" }]]);
    const f = foldKbActivity([dec(1, { entryId: "kb-a" }), dec(2, { entryId: "kb-b" }), dec(3, { outcome: "reject" })], { domain: "alpha", entryInfo: info });
    expect(f.decisions.items.map((d) => d.entryId)).toEqual(["kb-a"]);
    expect(f.changes.domains).toEqual([]);
  });

  it("redacts and caps the reason", () => {
    const f = foldKbActivity([dec(1, { outcome: "reject", reason: `leaked sk-${"a".repeat(30)} ${"z".repeat(500)}\nsecond line` })]);
    const r = f.decisions.items[0].reason!;
    expect(r).toContain("[REDACTED]");
    expect(r).not.toContain("sk-aaaa");
    expect(r).not.toContain("second line");
    expect(r.length).toBeLessThanOrEqual(240);
  });
});

describe("foldKbActivity changes", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-activity-"));
    for (const [d, i, t] of [["alpha", "kb-1", "One"], ["alpha", "kb-2", "Two"], ["beta", "kb-3", "Three"]]) {
      mkdirSync(join(base, "domains", d, "entries"), { recursive: true });
      writeFileSync(join(base, "domains", d, "entries", `${i}.md`), `---\nid: ${i}\ntitle: "${t}"\n---\n\nBody\n`);
    }
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("maps create/merge/supersede/retire, joins the decision, resolves domain from files then entry_placed, else (unplaced)", () => {
    const evs: KbEvent[] = [
      written(1, "kb-1", "create"),
      dec(1, { from: "w1", denTopicId: "tA", entryId: "kb-1" }),
      written(2, "kb-1", "merge"),
      written(3, "kb-3", "supersede"),
      { t: "section_created", id: id(), at: at(4), sectionId: "s1", domain: "gamma", parent: null, label: "G" },
      { t: "entry_placed", id: id(), at: at(4), entryId: "kb-4", sectionId: "s1", basis: "routed", fit: 1 },
      written(4, "kb-4"),
      retired(5, "kb-2"),
      written(6, "kb-ghost"),
    ];
    const f = foldKbActivity(evs, { entryInfo: scanEntryInfo(base) });
    const by = Object.fromEntries(f.changes.domains.map((d) => [d.domain, d.items]));
    expect(f.changes.domains.map((d) => d.domain)).toEqual(["alpha", "beta", "gamma", "(unplaced)"]);
    expect(by.alpha.map((c) => c.action)).toEqual(["retire", "merge", "create"]);
    expect(by.alpha[2]).toMatchObject({ entryId: "kb-1", title: "One", from: "w1", denTopicId: "tA" });
    expect(by.alpha[0].from).toBeUndefined();
    expect(by.beta[0]).toMatchObject({ action: "supersede", title: "Three" });
    expect(by.gamma[0].entryId).toBe("kb-4");
    expect(by["(unplaced)"][0].entryId).toBe("kb-ghost");
  });

  it("keeps the latest 10 per domain, newest first", () => {
    const evs = Array.from({ length: 14 }, (_, i) => [contrib(i + 1, "w1"), written(i + 1, "kb-1")]).flat(); // a contribution between writes: separate batches
    const items = foldKbActivity(evs, { entryInfo: scanEntryInfo(base) }).changes.domains[0].items;
    expect(items).toHaveLength(10);
    expect(items[0].at).toBe(at(14));
    expect(items[9].at).toBe(at(5));
  });
});

describe("readIncoming", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-incoming-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("groups top-level .md by wolf and ignores _processed, _bad contents, dotfiles", () => {
    const now = Date.now();
    mkdirSync(join(root, "w1", "_processed"), { recursive: true });
    mkdirSync(join(root, "w1", "_bad"), { recursive: true });
    mkdirSync(join(root, "w2"), { recursive: true });
    mkdirSync(join(root, "_x"), { recursive: true });
    writeFileSync(join(root, "w1", "topic-one-abcdef0123.md"), "x");
    writeFileSync(join(root, "w1", "topic-two-0123456789.md"), "x");
    utimesSync(join(root, "w1", "topic-one-abcdef0123.md"), new Date(now - 60_000), new Date(now - 60_000));
    writeFileSync(join(root, "w1", "_processed", "old-0000000000.md"), "x");
    writeFileSync(join(root, "w1", "_bad", "b-1111111111.md"), "x");
    writeFileSync(join(root, "w1", "_bad", "b-1111111111.md.reason.txt"), "why");
    writeFileSync(join(root, "w1", ".sweep-lease"), "{}");
    writeFileSync(join(root, "w1", ".t.abcd.tmp"), "x");
    writeFileSync(join(root, "w2", "note.txt"), "x");
    const r = readIncoming(root, now);
    expect(r.total).toBe(2);
    expect(r.wolves.map((w) => w.wolf)).toEqual(["w1"]);
    const w = r.wolves[0];
    expect(w).toMatchObject({ pending: 2, bad: 1 });
    expect(w.oldestAgeMs).toBeGreaterThanOrEqual(59_000);
    expect(w.items[0]).toMatchObject({ denTopicId: "topic-one", hash: "abcdef0123" });
  });

  it("caps items at 20 per wolf and tolerates a missing root", () => {
    mkdirSync(join(root, "w1"));
    for (let i = 0; i < 25; i++) writeFileSync(join(root, "w1", `t${i}-0123456789.md`), "x");
    const r = readIncoming(root);
    expect(r.wolves[0].pending).toBe(25);
    expect(r.wolves[0].items).toHaveLength(20);
    expect(readIncoming(join(root, "nope"))).toEqual({ total: 0, wolves: [], bad: [], waitingByDomain: new Map() });
  });

  it("reads domain_hint from the file head and counts waiting per domain", () => {
    mkdirSync(join(root, "w1"));
    writeFileSync(join(root, "w1", "a-0123456789.md"), "---\nfrom: w1\ndomain_hint: alpha\n---\nbody\n");
    writeFileSync(join(root, "w1", "b-0123456788.md"), "---\ndomain_hint: alpha\n---\n");
    writeFileSync(join(root, "w1", "c-0123456787.md"), "no frontmatter");
    const r = readIncoming(root);
    expect(Object.fromEntries(r.waitingByDomain)).toEqual({ alpha: 2 });
    expect(r.wolves[0].items.filter((i) => i.domain === "alpha")).toHaveLength(2);
  });

  it("lists _bad contributions with hint and reason, newest first, capped", () => {
    mkdirSync(join(root, "w1", "_bad"), { recursive: true });
    writeFileSync(join(root, "w1", "_bad", "s1.raw"), JSON.stringify({ denTopicId: "topic-x", domainHint: "nope" }));
    writeFileSync(join(root, "w1", "_bad", "s1.raw.reason.txt"), "domain_hint \"nope\" is not subscribed\nsha256: x\n");
    writeFileSync(join(root, "w1", "_bad", "s2.raw"), "{truncated");
    const r = readIncoming(root);
    expect(r.wolves[0].bad).toBe(2);
    expect(r.bad).toHaveLength(2);
    const one = r.bad.find((b) => b.denTopicId === "topic-x")!;
    expect(one).toMatchObject({ wolf: "w1", domainHint: "nope", reason: "domain_hint \"nope\" is not subscribed" });
    expect(r.bad.find((b) => b.denTopicId === undefined)?.reason).toBe("quarantined");
  });
});

describe("attribution, redaction, ordering", () => {
  it("attributes each change to its own batch's decision, not the entry's latest contributor", () => {
    // sweep order: entry_written first (commitKb), then the batch's decision.
    const evs: KbEvent[] = [
      written(1, "kb-1", "create"),
      dec(1, { from: "w1", denTopicId: "tA", hash: "a", outcome: "create", entryId: "kb-1" }),
      written(5, "kb-1", "merge"),
      dec(5, { from: "w2", denTopicId: "tB", hash: "b", outcome: "merge", entryId: "kb-1" }),
      dec(7, { from: "w3", denTopicId: "tC", hash: "c", outcome: "unchanged", entryId: "kb-1" }),
    ];
    const items = foldKbActivity(evs, { entryInfo: new Map([["kb-1", { domain: "alpha" }]]) }).changes.domains[0].items;
    expect(items.map((c) => [c.action, c.from])).toEqual([["merge", "w2"], ["create", "w1"]]); // the later unchanged never overwrites
  });

  it("also attributes when the decision precedes the write; falls back to the latest earlier decision; retire has none", () => {
    const evs: KbEvent[] = [written(2, "kb-1", "create"), dec(2, { from: "w1", entryId: "kb-1" }), contrib(3, "w1"), written(3, "kb-1", "supersede"), contrib(4, "w1"), retired(4, "kb-1")];
    const items = foldKbActivity(evs, { entryInfo: new Map([["kb-1", { domain: "alpha" }]]) }).changes.domains[0].items;
    expect(items.map((c) => [c.action, c.from])).toEqual([["retire", undefined], ["supersede", "w1"], ["create", "w1"]]);
  });

  it("redacts and caps routing.subject.reason, routing.confirm.reason and routing.warning", () => {
    const secret = `Bearer ${"x".repeat(30)} ${"y".repeat(500)}`;
    const f = foldKbActivity([
      dec(1, { routing: { route: "similarity", candidates: [], subject: { match: "m", valid: false, reason: secret }, confirm: { candidate: "c", score: 1, merge: false, valid: false, reason: secret }, warning: secret } }),
    ]);
    const r = f.decisions.items[0].routing!;
    for (const t of [r.subject!.reason!, r.confirm!.reason!, r.warning!]) {
      expect(t).toContain("[REDACTED]");
      expect(t.length).toBeLessThanOrEqual(240);
    }
  });

  it("counts an unchanged outcome and keeps it in the feed", () => {
    const f = foldKbActivity([dec(1, { outcome: "unchanged", entryId: "kb-1" })]);
    expect(f.decisions.counts.unchanged).toBe(1);
    expect(f.decisions.items[0].outcome).toBe("unchanged");
  });

  it("pages events with an equal `at` without overlap (id tiebreak)", () => {
    const evs = [1, 2, 3, 4, 5].map((i) => dec(1, { denTopicId: `t${i}`, hash: `h${i}` }));
    const idx = buildActivityIndex(evs);
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 6; i++) {
      const p = pageActivity(idx, { limit: 2, before });
      seen.push(...p.decisions.items.map((d) => d.denTopicId));
      if (!p.decisions.nextCursor) break;
      before = p.decisions.nextCursor;
    }
    expect(seen).toEqual(["t5", "t4", "t3", "t2", "t1"]);
  });

  it("compares parsed times: equal instants in different notations tie and fall to the id", () => {
    const a = { ...dec(1, { denTopicId: "a", hash: "a" }), at: "2026-11-01T00:01:00.000Z" } as KbEvent;
    const b = { ...dec(1, { denTopicId: "b", hash: "b" }), at: "2026-11-01T00:01:00Z" } as KbEvent;
    expect(foldKbActivity([a, b]).decisions.items.map((d) => d.denTopicId)).toEqual(["b", "a"]);
  });

  it("selects the (unplaced) domain: entries with no resolvable domain; decisions without an entry are excluded", () => {
    const f = foldKbActivity([dec(1, { entryId: "kb-ghost" }), dec(2, { outcome: "reject" }), written(3, "kb-ghost")], { domain: "(unplaced)" });
    expect(f.decisions.items.map((d) => d.entryId)).toEqual(["kb-ghost"]);
    expect(f.changes.domains.map((d) => d.domain)).toEqual(["(unplaced)"]);
  });

  it("bounds the stat work in readIncoming: counts every file, describes at most the first 200 by name", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-incoming-cap-"));
    try {
      mkdirSync(join(root, "w1"));
      const n = INCOMING_STAT_CAP + 30;
      for (let i = 0; i < n; i++) writeFileSync(join(root, "w1", `t${String(i).padStart(4, "0")}-0123456789.md`), "x");
      const r = readIncoming(root);
      expect(r.total).toBe(n);
      expect(r.wolves[0].pending).toBe(n);
      expect(r.wolves[0].items).toHaveLength(20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("attribution safety, dedupe, routing ids", () => {
  const info = new Map([["kb-1", { domain: "alpha" }]]);

  it("does not credit another wolf through a fallback decision", () => {
    // w1 created kb-1 earlier; a later merge write has no decision of its own and its batch is from w2.
    const evs: KbEvent[] = [
      written(1, "kb-1", "create"),
      contrib(1, "w1"),
      dec(1, { from: "w1", entryId: "kb-1", outcome: "create" }),
      written(5, "kb-1", "merge"),
      contrib(5, "w2"),
    ];
    const items = foldKbActivity(evs, { entryInfo: info }).changes.domains[0].items;
    expect(items[0]).toMatchObject({ action: "merge" });
    expect(items[0].from).toBeUndefined();
    expect(items[0].denTopicId).toBeUndefined();
    expect(items[1]).toMatchObject({ action: "create", from: "w1" });
  });

  it("still uses a fallback decision from the batch's own sender", () => {
    const evs: KbEvent[] = [written(1, "kb-1", "create"), contrib(1, "w1"), dec(1, { from: "w1", entryId: "kb-1", outcome: "create" }), written(5, "kb-1", "merge"), contrib(5, "w1")];
    expect(foldKbActivity(evs, { entryInfo: info }).changes.domains[0].items[0].from).toBe("w1");
  });

  it("collapses the two writes of one sweep write into one change", () => {
    const evs: KbEvent[] = [written(1, "kb-1", "create"), written(1, "kb-1", "create"), contrib(1, "w1"), dec(1, { from: "w1", entryId: "kb-1" })];
    const items = foldKbActivity(evs, { entryInfo: info }).changes.domains[0].items;
    expect(items).toHaveLength(1);
    expect(items[0].from).toBe("w1");
    // the same action in a later batch is a separate change
    const two = foldKbActivity([...evs, written(9, "kb-1", "merge"), written(9, "kb-1", "merge"), contrib(9, "w2"), dec(9, { from: "w2", entryId: "kb-1", outcome: "merge" })], { entryInfo: info }).changes.domains[0].items;
    expect(two.map((c) => [c.action, c.from])).toEqual([["merge", "w2"], ["create", "w1"]]);
  });

  it("redacts and caps routing identifiers", () => {
    const long = `${"z".repeat(300)}`;
    const f = foldKbActivity([dec(1, { routing: { route: "similarity", candidates: [{ id: long, score: 1 }], band: long, subject: { match: `Bearer ${"x".repeat(30)} ${long}`, valid: true }, confirm: { candidate: long, score: 1, merge: true, valid: true } } })]);
    const r = f.decisions.items[0].routing!;
    expect(r.candidates[0].id.length).toBeLessThanOrEqual(120);
    expect(r.band!.length).toBeLessThanOrEqual(120);
    expect(r.confirm!.candidate.length).toBeLessThanOrEqual(120);
    expect(r.subject!.match).toContain("[REDACTED]");
    expect(r.subject!.match.length).toBeLessThanOrEqual(120);
  });
});

describe("readIncoming hardening", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "act-hard-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("never follows a symlinked sidecar, body or inbox file, and skips a FIFO without blocking", () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "TOP-SECRET first line\n");
    mkdirSync(join(root, "w1", "_bad"), { recursive: true });
    const bad = join(root, "w1", "_bad");
    writeFileSync(join(bad, "a.raw"), JSON.stringify({ denTopicId: "t-a" }));
    symlinkSync(secret, join(bad, "a.raw.reason.txt")); // sidecar -> secret
    symlinkSync(secret, join(bad, "b.raw")); // body -> secret
    execFileSync("mkfifo", [join(bad, "c.raw")]);
    writeFileSync(join(bad, "d.raw"), JSON.stringify({ denTopicId: "t-d" }));
    execFileSync("mkfifo", [join(bad, "d.raw.reason.txt")]);
    symlinkSync(secret, join(root, "w1", "linked-0123456789.md"));
    execFileSync("mkfifo", [join(root, "w1", "pipe-0123456788.md")]);
    const r = readIncoming(root);
    const text = JSON.stringify(r.bad);
    expect(text).not.toContain("TOP-SECRET");
    expect(r.bad.map((b) => b.denTopicId).sort()).toEqual(["t-a", "t-d"]); // symlink and FIFO bodies are not listed
    expect(r.bad.every((b) => b.reason === "quarantined")).toBe(true);
    expect(r.wolves[0].items).toEqual([]); // neither the symlink nor the FIFO is a pending item
  });

  it("waitingByDomain is a Map of known domains only; prototype-ish hints are ignored", () => {
    mkdirSync(join(root, "w1"));
    const f = (n: string, hint: string) => writeFileSync(join(root, "w1", `${n}-0123456789.md`), `---\ndomain_hint: ${hint}\n---\n`);
    f("a", "alpha"); f("b", "__proto__"); f("c", "constructor"); f("d", "ghost"); f("e", '"alpha"');
    const r = readIncoming(root, Date.now(), new Set(["alpha"]));
    expect([...r.waitingByDomain]).toEqual([["alpha", 2]]);
    expect(r.wolves[0].items.map((i) => i.domain).filter(Boolean)).toEqual(["alpha", "alpha"]);
    expect(Object.keys(r.waitingByDomain)).toEqual([]);
  });

  it("takes domain_hint from the frontmatter only, in inbox files and bad .md files", () => {
    mkdirSync(join(root, "w1", "_bad"), { recursive: true });
    writeFileSync(join(root, "w1", "x-0123456789.md"), "---\nfrom: w1\n---\ndomain_hint: alpha\n");
    writeFileSync(join(root, "w1", "_bad", "y-0123456788.md"), "---\nfrom: w1\n---\ndomain_hint: beta\n");
    writeFileSync(join(root, "w1", "_bad", "z-0123456787.md"), "---\ndomain_hint: 'gamma'\n---\n");
    const r = readIncoming(root);
    expect(r.waitingByDomain.size).toBe(0);
    expect(r.bad.find((b) => b.denTopicId === "y")?.domainHint).toBeUndefined();
    expect(r.bad.find((b) => b.denTopicId === "z")?.domainHint).toBe("gamma");
  });

  it("bad: newest first across all files and the cap applies before any file is read", () => {
    mkdirSync(join(root, "w1", "_bad"), { recursive: true });
    mkdirSync(join(root, "w2", "_bad"), { recursive: true });
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < BAD_MAX + 5; i++) {
      const w = i % 2 ? "w1" : "w2";
      const f = join(root, w, "_bad", `s${String(i).padStart(3, "0")}.raw`);
      writeFileSync(f, JSON.stringify({ denTopicId: `t${i}` }));
      utimesSync(f, new Date(base + i * 1000), new Date(base + i * 1000));
    }
    const r = readIncoming(root);
    expect(r.bad).toHaveLength(BAD_MAX);
    expect(r.bad[0].denTopicId).toBe(`t${BAD_MAX + 4}`);
    expect(r.bad[1].denTopicId).toBe(`t${BAD_MAX + 3}`);
    expect(r.bad.map((b) => b.at)).toEqual([...r.bad.map((b) => b.at)].sort().reverse());
    expect(r.bad[0].id).toMatch(/^s\d{3}\.raw$/);
  });

  it("listDomains drops names the hub would refuse", () => {
    for (const d of ["good", "bad name", ".hid", "_x", "ok.1"]) mkdirSync(join(root, "domains", d), { recursive: true });
    expect(listDomains(root).sort()).toEqual(["good", "ok.1"]);
  });
});

describe("per-domain attribution", () => {
  const hinted = (m: number, from: string, topic: string, hint: string): KbEvent => ({ t: "contribution", id: id(), at: at(m), from, denTopicId: topic, hash: `h-${topic}`, prevHash: null, domainHint: hint }) as KbEvent;
  const resolver = (map: Record<string, string>, known: string[]) => ({ domain: (i: string) => map[i], title: (i: string) => (map[i] ? `T ${i}` : undefined), known: () => new Set(known) });

  it("tags decisions with the entry's domain, else the hinted real domain, else none", () => {
    const evs = [
      hinted(1, "w1", "a", "alpha"), dec(1, { denTopicId: "a", hash: "h-a", entryId: "kb-a" }),
      hinted(2, "w2", "r", "beta"), dec(2, { from: "w2", denTopicId: "r", hash: "h-r", outcome: "reject" }),
      hinted(3, "w2", "bad", "zzz"), dec(3, { from: "w2", denTopicId: "bad", hash: "h-bad", outcome: "reject" }),
    ];
    const p = pageActivity(buildActivityIndex(evs), {}, resolver({ "kb-a": "alpha" }, ["alpha", "beta"]));
    const by = Object.fromEntries(p.decisions.items.map((d) => [d.denTopicId, d]));
    expect(by.a).toMatchObject({ domain: "alpha", title: "T kb-a" });
    expect(by.r!.domain).toBe("beta");
    expect(by.bad!.domain).toBeUndefined();
    const beta = p.domains.find((d) => d.domain === "beta")!;
    expect(beta.contributors).toEqual([]); // a rejected contribution does not make a contributor
    expect(beta).toMatchObject({ decided: 1, recent: [{ denTopicId: "r", domain: "beta" }] });
    expect(p.domains.find((d) => d.domain === "alpha")!.contributors).toEqual([{ wolf: "w1", count: 1 }]);
    expect(p.attention.map((a) => [a.wolf, a.reject, a.items.length])).toEqual([["w2", 2, 2]]);
  });

  it("domain filter pages hinted decisions with no entry; since applies to changes", () => {
    const evs = [hinted(1, "w1", "r", "beta"), dec(1, { denTopicId: "r", hash: "h-r", outcome: "reject" }), written(1, "kb-a"), written(10, "kb-b")];
    const idx = buildActivityIndex(evs);
    const res = resolver({ "kb-a": "alpha", "kb-b": "alpha" }, ["alpha", "beta"]);
    expect(pageActivity(idx, { domain: "beta" }, res).decisions.items.map((d) => d.denTopicId)).toEqual(["r"]);
    const p = pageActivity(idx, { sinceMs: Date.parse(at(5)) }, res);
    expect(p.changes.domains[0]!.items.map((c) => c.entryId)).toEqual(["kb-b"]);
    expect(p.domains.find((d) => d.domain === "alpha")!.lastChangeAt).toBe(at(10));
  });
});

describe("backfill-shaped ledger", () => {
  it("contribution (with domainHint) + entry_written + decision per item, bf- ids, old dates, reads per domain with the right wolf", () => {
    const old = (d: number, m: number) => new Date(Date.UTC(2025, 0, d, 0, m)).toISOString();
    const evs: KbEvent[] = [];
    const item = (k: number, wolf: string, hint: string, entry: string | null, outcome: "create" | "reject") => {
      evs.push({ t: "contribution", id: `bf-c${k}`, at: old(k, 0), from: wolf, denTopicId: `topic-${k}`, hash: `hash-${k}`, prevHash: null, domainHint: hint } as KbEvent);
      if (entry) evs.push({ t: "entry_written", id: `bf-w${k}`, at: old(k, 1), entryId: entry, canonicalId: entry, action: "create" } as KbEvent);
      evs.push({ t: "decision", id: `bf-d${k}`, at: old(k, 2), from: wolf, denTopicId: `topic-${k}`, hash: `hash-${k}`, outcome, ...(entry ? { entryId: entry } : { reason: "backfilled" }) } as KbEvent);
    };
    item(1, "hal2", "alpha", "kb-alpha-1", "create");
    item(2, "1uk4", "beta", "kb-beta-1", "create");
    item(3, "1uk4", "beta", "kb-beta-2", "create");
    item(4, "hal2", "beta", null, "reject");
    const res = { domain: (i: string) => ({ "kb-alpha-1": "alpha", "kb-beta-1": "beta", "kb-beta-2": "beta" })[i], title: (i: string) => `T ${i}`, known: () => new Set(["alpha", "beta", "gamma"]) };
    const p = pageActivity(buildActivityIndex(evs), {}, res);
    const alpha = p.domains.find((d) => d.domain === "alpha")!;
    const beta = p.domains.find((d) => d.domain === "beta")!;
    expect(alpha.contributors).toEqual([{ wolf: "hal2", count: 1 }]);
    expect(beta.contributors).toEqual([{ wolf: "1uk4", count: 2 }]); // hal2's rejected item is not a contribution
    expect(beta.decided).toBe(3);
    expect(beta.recent.map((d) => d.denTopicId)).toEqual(["topic-4", "topic-3", "topic-2"]);
    expect(beta.recent[0].domain).toBe("beta"); // the reject lands in the hinted domain
    // changes fold into the same item: one change per entry, attributed to the wolf
    const ch = p.changes.domains.find((d) => d.domain === "beta")!.items;
    expect(ch.map((c) => [c.entryId, c.from])).toEqual([["kb-beta-2", "1uk4"], ["kb-beta-1", "1uk4"]]);
    expect(p.attention).toMatchObject([{ wolf: "hal2", reject: 1 }]);
  });
});
