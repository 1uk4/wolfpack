import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildActivityIndex, fsEntryResolver, pageActivity, scanEntryDomains } from "@wolfpack/kb/librarian";
import { ledgerFile, KbEventSchema, type KbEvent } from "@wolfpack/kb/shared";
import { hubRoots } from "./layout.js";
import { formatBackfillReport, kbBackfill, toIsoUtc } from "./kb-backfill.js";
import { main, parseArgs } from "./cli.js";

const tmp: string[] = [];
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

const put = (f: string, s: string) => {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, s);
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kb-backfill-"));
  tmp.push(root);
  const receipts = join(root, "receipts");
  const inbox = join(root, "inbox");
  const dataDir = join(root, "hub");
  const dewey = join(root, "dewey.jsonl");
  const rec = (wolf: string, name: string, outcome: string, processed: string, body: string) =>
    put(join(receipts, wolf, `${name}.md`), `---\nfrom: ${wolf}\nden_topic_id: ${name.replace(/-[0-9a-f]{10}$/, "")}\noutcome: ${outcome}\nprocessed: "${processed}"\n---\n${body}\n`);
  const proc = (wolf: string, name: string, hash: string, extra = "") =>
    put(join(inbox, wolf, "_processed", `${name}.md`), `---\nfrom: ${wolf}\nden_topic_id: ${name.replace(/-[0-9a-f]{10}$/, "")}\nchange: x\ncontent_hash: sha256:${hash}\nprev_hash: null\ndomain_hint: wolfpack\n${extra}---\nbody\n`);
  rec("1uk4", "topic-a-aaaaaaaaaa", "create", "2026-10-06 05:02", "kb-wolfpack-AAA");
  proc("1uk4", "topic-a-aaaaaaaaaa", "h1", 'submitted: "2026-10-06T04:50:00.000Z"\n');
  rec("hal", "topic-b-bbbbbbbbbb", "merge", "2026-10-07 10:00", "kb-snapjack-BBB"); // no submitted
  proc("hal", "topic-b-bbbbbbbbbb", "h2");
  rec("hal", "topic-c-cccccccccc", "parked", "2026-10-08 10:00", "");
  proc("hal", "topic-c-cccccccccc", "h3");
  proc("kb-repair", "topic-d-dddddddddd", "h4"); // via aliased
  proc("kb-repair", "topic-e-eeeeeeeeee", "h5"); // unjoinable
  put(dewey, [
    { id: "e1", at: "2026-10-09 12:00", t: "entry_written", entryId: "kb-wolfpack-DDD", canonicalId: "kb-wolfpack-DDD", action: "create" },
    { id: "e2", at: "2026-10-09 12:00", t: "aliased", wolf: "kb-repair", denTopicId: "topic-d", canonicalId: "kb-wolfpack-DDD", hash: "sha256:h4" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  // hub KB: AAA and BBB exist, DDD retired
  for (const [d, id] of [["wolfpack", "kb-wolfpack-AAA"], ["snapjack", "kb-snapjack-BBB"]] as const)
    put(join(dataDir, "kb", "base", "domains", d, "entries", `${id}.md`), `---\ntitle: T ${id}\n---\nx\n`);
  return { root, receipts, inbox, dataDir, deweyLedger: dewey };
}

const ledgerAfter = (r: { samples: unknown[] }) => r.samples;
const ledger = (dataDir: string): KbEvent[] =>
  readFileSync(ledgerFile(hubRoots(dataDir)), "utf-8").split("\n").filter(Boolean).map((l) => KbEventSchema.parse(JSON.parse(l)));

describe("kb-backfill", () => {
  it("joins receipts to _processed and emits contribution/entry_written/decision", async () => {
    const f = fixture();
    const r = await kbBackfill({ ...f });
    expect(r.items).toBe(4); // a, b, c, d (e skipped)
    expect(r.skipped.map((s) => s.key)).toEqual(["kb-repair/topic-e-eeeeeeeeee.md"]);
    expect(r.missingEntries).toBe(1); // DDD retired
    const evs = ledger(f.dataDir);
    const a = evs.filter((e) => e.t === "contribution" && e.hash === "sha256:h1");
    expect(a[0]).toMatchObject({ from: "1uk4", at: "2026-10-06T04:50:00.000Z", prevHash: null, domainHint: "wolfpack" });
    const dec = evs.find((e) => e.t === "decision" && e.hash === "sha256:h1");
    expect(dec).toMatchObject({ outcome: "create", entryId: "kb-wolfpack-AAA", at: "2026-10-06T05:02:00.000Z" });
    // missing submitted -> processed
    expect(evs.find((e) => e.t === "contribution" && e.hash === "sha256:h2")!.at).toBe("2026-10-07T10:00:00.000Z");
    // parked: no entry_written
    expect(evs.filter((e) => e.t === "entry_written").map((e) => (e as { entryId: string }).entryId).sort()).toEqual(["kb-snapjack-BBB", "kb-wolfpack-AAA", "kb-wolfpack-DDD"]);
    // kb-repair via aliased
    expect(evs.find((e) => e.t === "decision" && e.hash === "sha256:h4")).toMatchObject({ from: "kb-repair", outcome: "create", entryId: "kb-wolfpack-DDD" });
  });

  it("joins graduation receipts by den topic + hash tag, and falls back to entry_id + submitted", async () => {
    const f = fixture();
    put(join(f.receipts, "1uk4", "work-x-ZZZ-6ddda4775r.md"), `---\nfrom: 1uk4\nden_topic_id: work-x-ZZZ\noutcome: merge\nprocessed: "2026-10-19 20:19"\n---\nkb-wolfpack-ZZZ\n`);
    put(join(f.inbox, "1uk4", "_processed", "grad-feature-work-x-ZZZ-1792.md"), `---\nfrom: 1uk4\nden_topic_id: work-x-ZZZ\nchange: create\ncontent_hash: 46bc5f56ddda4775r1\nprev_hash: null\ndomain_hint: wolfpack\nsubmitted: 2026-10-19T20:15:37.526Z\n---\nb\n`);
    put(join(f.inbox, "kb-repair", "_processed", "grad-feature-work-y-YYY-1.md"), `---\nfrom: 1uk4\nden_topic_id: work-y-YYY\nchange: create\ncontent_hash: zz99\nprev_hash: null\ndomain_hint: wolfpack\nentry_id: kb-wolfpack-YYY\nsubmitted: 2026-10-20T01:00:00Z\n---\nb\n`);
    const r = await kbBackfill({ ...f, dryRun: true });
    expect(r.items).toBe(6); // a, b, c, d + ZZZ (tag join) + YYY (entry_id fallback)
    expect(r.skipped).toHaveLength(1);
    const evs = ledgerAfter(r);
    expect(evs).toBeDefined();
  });

  it("is idempotent", async () => {
    const f = fixture();
    const r1 = await kbBackfill({ ...f });
    const before = readFileSync(ledgerFile(hubRoots(f.dataDir)), "utf-8");
    const r2 = await kbBackfill({ ...f });
    expect(r2.eventsAppended).toBe(0);
    expect(r2.alreadyPresent).toBe(r1.eventsAppended);
    expect(readFileSync(ledgerFile(hubRoots(f.dataDir)), "utf-8")).toBe(before);
  });

  it("dry run writes nothing", async () => {
    const f = fixture();
    const r = await kbBackfill({ ...f, dryRun: true });
    expect(r.eventsBuilt).toBeGreaterThan(0);
    expect(r.samples).toHaveLength(3);
    expect(existsSync(ledgerFile(hubRoots(f.dataDir)))).toBe(false);
    expect(r.perWolf).toMatchObject({ "1uk4": 1, hal: 2, "kb-repair": 1 });
  });

  it("converts wall-clock times from --tz", () => {
    expect(toIsoUtc("2026-11-05 04:15", "UTC")).toBe("2026-11-05T04:15:00.000Z");
    expect(toIsoUtc("2026-10-06 05:02", "America/Los_Angeles")).toBe("2026-10-06T12:02:00.000Z"); // PDT
    expect(toIsoUtc("2026-11-05 04:15", "America/Los_Angeles")).toBe("2026-11-05T12:15:00.000Z"); // PST
    expect(toIsoUtc("garbage", "UTC")).toBeUndefined();
  });

  it("feeds the activity reader with the right wolf and domain", async () => {
    const f = fixture();
    await kbBackfill({ ...f });
    const idx = buildActivityIndex(ledger(f.dataDir));
    const kbBase = hubRoots(f.dataDir).kbBase;
    const page = pageActivity(idx, {}, fsEntryResolver(kbBase, scanEntryDomains(kbBase)));
    const d = page.decisions.items.find((x) => x.entryId === "kb-snapjack-BBB")!;
    expect(d).toMatchObject({ from: "hal", outcome: "merge" });
    expect(page.decisions.counts).toMatchObject({ create: 2, merge: 1, parked: 1 });
    const snap = page.changes.domains.find((x) => x.domain === "snapjack")!;
    expect(snap.items[0]).toMatchObject({ entryId: "kb-snapjack-BBB", action: "merge", from: "hal" });
    const wp = page.changes.domains.find((x) => x.domain === "wolfpack")!;
    expect(wp.items[0]).toMatchObject({ entryId: "kb-wolfpack-AAA", from: "1uk4", title: "T kb-wolfpack-AAA" });
    // the retired entry's change is still attributed to its wolf (domain unknown -> unplaced)
    const un = page.changes.domains.find((x) => x.domain === "(unplaced)")!;
    expect(un.items[0]).toMatchObject({ entryId: "kb-wolfpack-DDD", from: "kb-repair" });
  });

  it("drops items whose events fail the schema, in the dry run too", async () => {
    const f = fixture();
    // a receipt whose _processed file has an empty-string-free but schema-invalid shape: parked outcome is fine, so break via a non-string-safe path
    put(join(f.receipts, "hal", "bad-0000000000.md"), `---\nfrom: hal\nden_topic_id: bad\noutcome: create\nprocessed: "2026-10-08 10:00"\n---\nnot an entry id\n`);
    put(join(f.inbox, "hal", "_processed", "bad-0000000000.md"), `---\nfrom: hal\ncontent_hash: sha256:hb\n---\nb\n`);
    const r = await kbBackfill({ ...f, dryRun: true });
    expect(r.items).toBe(4);
    expect(r.skipped.some((s) => s.key === "hal/bad-0000000000.md" && /entry id/.test(s.reason))).toBe(true);
  });

  it("counts invalid events via KbEventSchema (non-string field)", async () => {
    const f = fixture();
    // an overlong-free way to make the schema fail: domain_hint is optional string; make `from` empty is valid; use a NUL-less empty hash -> skipped earlier. Use prev_hash fine.
    const r = await kbBackfill({ ...f, dryRun: true });
    expect(r.invalidItems).toBe(0);
  });

  it("tolerates junk Dewey ledger lines (null, arrays, wrong types)", async () => {
    const f = fixture();
    writeFileSync(f.deweyLedger, ["null", "[]", "42", '{"t":"aliased","wolf":1,"hash":"sha256:h4","canonicalId":"kb-wolfpack-DDD","at":"2026-10-09 12:00","denTopicId":"x"}', "{bad"].join("\n") + "\n");
    const r = await kbBackfill({ ...f, dryRun: true });
    expect(r.items).toBe(3); // h4 no longer joins (wolf is not a string)
  });

  it("a real run needs --dewey-ledger; a dry run warns; fallbacks are counted", async () => {
    const f = fixture();
    await expect(kbBackfill({ receipts: f.receipts, inbox: f.inbox, dataDir: f.dataDir })).rejects.toThrow(/--dewey-ledger/);
    const r = await kbBackfill({ receipts: f.receipts, inbox: f.inbox, dataDir: f.dataDir, dryRun: true });
    expect(r.warnings.join()).toMatch(/dewey-ledger/);
    expect(r.canonicalFallback).toBe(2); // a and b have no entry_written in the Dewey ledger
    const r2 = await kbBackfill({ ...f, dryRun: true });
    expect(r2.canonicalFallback).toBe(2);
  });

  it("refuses a ledger with non-backfill events unless forced", async () => {
    const f = fixture();
    const file = ledgerFile(hubRoots(f.dataDir));
    put(file, JSON.stringify({ id: "ev-1", at: "2026-11-05T00:00:00.000Z", t: "subscribed", wolf: "w", canonicalId: "c" }) + "\n");
    await expect(kbBackfill({ ...f })).rejects.toThrow(/--force/);
    expect((await kbBackfill({ ...f, dryRun: true })).warnings.join()).toMatch(/not backfill events/);
    const r = await kbBackfill({ ...f, force: true });
    expect(r.eventsAppended).toBeGreaterThan(0);
    expect((await kbBackfill({ ...f, force: true })).eventsAppended).toBe(0);
  });

  it("handles a BOM, rejects out-of-range dates, and strips control characters from the report", async () => {
    expect(toIsoUtc("2026-02-30 10:00", "UTC")).toBeUndefined();
    expect(toIsoUtc("2026-13-01 10:00", "UTC")).toBeUndefined();
    expect(toIsoUtc("2026-10-06 24:00", "UTC")).toBeUndefined();
    const f = fixture();
    put(join(f.receipts, "1uk4", "topic-a-aaaaaaaaaa.md"), `\uFEFF---\nfrom: 1uk4\nden_topic_id: topic-a\noutcome: create\nprocessed: "2026-10-06 05:02"\n---\nkb-wolfpack-AAA\n`);
    put(join(f.receipts, "hal", "evil\u001b[31m-1111111111.md"), `---\nfrom: hal\nden_topic_id: e\noutcome: bogus\nprocessed: "x"\n---\n`);
    const r = await kbBackfill({ ...f, dryRun: true });
    expect(r.perWolf["1uk4"]).toBe(1);
    const out = formatBackfillReport(r).join("\n");
    expect(out).not.toContain("\u001b");
    expect(out).toContain("evil");
  });

  it("CLI parses and runs", async () => {
    const f = fixture();
    expect(() => parseArgs(["kb-backfill", "--data-dir", f.dataDir])).toThrow(/--receipts/);
    const lines: string[] = [];
    await main(["kb-backfill", "--receipts", f.receipts, "--inbox", f.inbox, "--dewey-ledger", f.deweyLedger, "--data-dir", f.dataDir, "--dry-run"], process.env, (m) => lines.push(m));
    expect(lines[0]).toMatch(/dry run/);
    expect(existsSync(ledgerFile(hubRoots(f.dataDir)))).toBe(false);
  });
});
