import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestUsage, readState } from "./ingest.js";
import { appendLedger, readLedger } from "./ledger.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engine-usage-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const line = (ts: string, output: number): string =>
  JSON.stringify({
    ts,
    wolf: "1uk4",
    source: "engine",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    billing: "api",
    input: 10,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0.01,
    costSource: "reported",
  });

describe("ingestUsage scoped to one den", () => {
  it("writes the den's engine records to the ledger and adds only new ones on a re-run", async () => {
    const den = path.join(tmp, "den");
    const ledgerDir = path.join(tmp, "ledger");
    fs.mkdirSync(path.join(den, "usage"), { recursive: true });
    const log = path.join(den, "usage", "2026-11.jsonl");
    fs.writeFileSync(log, line("2026-11-19T10:00:00Z", 1) + "\n" + line("2026-11-19T10:01:00Z", 2) + "\n");
    const opts = {
      ledgerDir,
      wolvesRoot: path.join(tmp, "none"),
      hosts: [],
      dens: [{ den, wolf: "1uk4", host: "local" }],
    };

    const first = await ingestUsage(opts);
    expect(first.added.engine).toBe(2);
    expect(readLedger(ledgerDir)).toHaveLength(2);

    fs.appendFileSync(log, line("2026-11-20T09:00:00Z", 3) + "\n");
    const second = await ingestUsage(opts);
    expect(second.added.engine).toBe(1);
    expect(readLedger(ledgerDir)).toHaveLength(3);
  });

  it("keeps other dens' stamps when a den-scoped run finishes", async () => {
    const ledgerDir = path.join(tmp, "ledger");
    const mk = (name: string, output: number): string => {
      const den = path.join(tmp, name);
      fs.mkdirSync(path.join(den, "usage"), { recursive: true });
      fs.writeFileSync(path.join(den, "usage", "2026-11.jsonl"), line(`2026-11-19T10:0${output}:00Z`, output) + "\n");
      return den;
    };
    const base = { ledgerDir, wolvesRoot: path.join(tmp, "none"), hosts: [] };
    const a = mk("a", 1);
    const b = mk("b", 2);
    await ingestUsage({ ...base, dens: [{ den: a, wolf: "a", host: "local" }] });
    await ingestUsage({ ...base, dens: [{ den: b, wolf: "b", host: "local" }] });
    expect(Object.keys(readState(ledgerDir).files).sort()).toEqual([
      path.join(a, "usage", "2026-11.jsonl"),
      path.join(b, "usage", "2026-11.jsonl"),
    ]);
  });
});

const require_ = createRequire(import.meta.url);
type Db = import("node:sqlite").DatabaseSync;
const openDb = (file: string): Db => {
  const { DatabaseSync } = require_("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(file);
};

const T0 = Date.parse("2026-11-20T10:00:00Z");

/** One entry record holding one assistant message (cost.total 0: priced from the catalog). */
const record = (model: string, ts: number, usage = { input: 1000, output: 2000, cacheRead: 10000, cacheWrite: 5000 }): string =>
  JSON.stringify({
    model: [{ role: "assistant", provider: "claude-stateless", model, timestamp: ts, usage: { ...usage, cost: { total: 0 } } }],
  });

const SCHEMA = `
  CREATE TABLE conversations (id INTEGER PRIMARY KEY, owner_conversation_id INTEGER, owner_task_id INTEGER, record TEXT);
  CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL);
  INSERT INTO conversations (id) VALUES (1);
  INSERT INTO conversations (id, owner_conversation_id) VALUES (5, 1);`;

/**
 * A den with a pi-durable session.sqlite: conversation 1 is the wolf, 5 a subagent child. With `registry`,
 * the child is also named in wolfd/subagents.json.
 */
function makeDen(root: string, registry = true): string {
  const den = path.join(root, "den");
  fs.mkdirSync(den, { recursive: true });
  const db = openDb(path.join(den, "session.sqlite"));
  db.exec(SCHEMA);
  const ins = db.prepare("INSERT INTO entries VALUES (?, ?, ?)");
  ins.run(10, 1, record("claude-opus-5-5", T0));
  ins.run(11, 5, record("claude-sonnet-5-5", T0 + 300_000));
  db.close();
  if (registry) {
    fs.mkdirSync(path.join(den, "wolfd"));
    fs.writeFileSync(
      path.join(den, "wolfd", "subagents.json"),
      JSON.stringify({ children: [{ id: "1uk4/sub-x", conversationId: "5", agent: "scout" }] }),
    );
  }
  return den;
}

const addEntry = (den: string, id: number, rec = record("claude-haiku-5-5", Date.parse("2026-11-21T10:00:00Z") + id * 60_000)): void => {
  const db = openDb(path.join(den, "session.sqlite"));
  db.prepare("INSERT INTO entries VALUES (?, ?, ?)").run(id, 1, rec);
  db.close();
};

const optsFor = (den: string, ledgerDir: string) => ({ ledgerDir, wolvesRoot: "", hosts: [], dens: [{ den, wolf: "1uk4", host: "local" }] });

describe("ingestUsage reads the wolf's own session.sqlite", () => {
  it("adds notional-priced durable rows (main and subagent:<agent>), and none again on a re-run", async () => {
    const den = makeDen(tmp);
    const ledgerDir = path.join(tmp, "ledger");
    const opts = optsFor(den, ledgerDir);

    expect((await ingestUsage(opts)).added.durable).toBe(2);
    const rows = readLedger(ledgerDir).sort((a, b) => a.ts.localeCompare(b.ts));
    expect(
      rows.map((r) => [r.source, r.use, r.model, r.billing, r.costSource, r.input, r.output, r.cacheRead, r.cacheWrite]),
    ).toEqual([
      ["durable", "main", "claude-opus-5-5", "subscription", "notional", 1000, 2000, 10000, 5000],
      ["durable", "subagent:scout", "claude-sonnet-5-5", "subscription", "notional", 1000, 2000, 10000, 5000],
    ]);

    expect((await ingestUsage(opts)).added.durable).toBe(0);
    expect(readLedger(ledgerDir)).toHaveLength(2);
  });

  it("prices each current model from the catalog, cache read and write included", async () => {
    const den = path.join(tmp, "den");
    fs.mkdirSync(den);
    const db = openDb(path.join(den, "session.sqlite"));
    db.exec(SCHEMA);
    const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
    models.forEach((m, i) => db.prepare("INSERT INTO entries VALUES (?, 1, ?)").run(i + 1, record(m, T0 + i * 60_000)));
    db.close();
    const ledgerDir = path.join(tmp, "ledger");
    await ingestUsage(optsFor(den, ledgerDir));
    // 1000 in, 2000 out, 10000 cache read, 5000 cache write at $/Mtok in the catalog:
    // opus 4/20/0.2/5, sonnet 2/10/0.1/2.5, haiku 0.1/0.5/0.01/0.125, fable 10/50/0.25/12.5
    const cost = Object.fromEntries(readLedger(ledgerDir).map((r) => [r.model, r.costUsd]));
    expect(cost["claude-opus-5-5"]).toBeCloseTo(0.071, 6);
    expect(cost["claude-sonnet-5-5"]).toBeCloseTo(0.0355, 6);
    expect(cost["claude-haiku-5-5"]).toBeCloseTo(0.001825, 6);
    expect(cost["claude-fable-5-1"]).toBeCloseTo(0.175, 6);
  });

  it("still ingests engine logs when the den has no session.sqlite", async () => {
    const den = path.join(tmp, "den");
    fs.mkdirSync(path.join(den, "usage"), { recursive: true });
    fs.writeFileSync(path.join(den, "usage", "2026-11.jsonl"), line("2026-11-19T10:00:00Z", 1) + "\n");
    const r = await ingestUsage(optsFor(den, path.join(tmp, "ledger")));
    expect(r.added).toMatchObject({ engine: 1, durable: 0 });
  });

  it("labels a child conversation missing from the registry subagent:unknown, never main", async () => {
    const den = makeDen(tmp, false);
    const ledgerDir = path.join(tmp, "ledger");
    await ingestUsage(optsFor(den, ledgerDir));
    expect(readLedger(ledgerDir).map((r) => r.use).sort()).toEqual(["main", "subagent:unknown"]);
  });

  it("skips a corrupt record and still ingests the entries around it", async () => {
    const den = makeDen(tmp);
    addEntry(den, 12, '{"usage": not json');
    addEntry(den, 13);
    const ledgerDir = path.join(tmp, "ledger");
    expect((await ingestUsage(optsFor(den, ledgerDir))).added.durable).toBe(3);
  });

  it("drops a durable row a pi row already covers (same wolf, tokens, within seconds), keeps the rest", async () => {
    const den = makeDen(tmp);
    const ledgerDir = path.join(tmp, "ledger");
    // The pi launcher logged the opus call 2 s after the durable timestamp; the sonnet call has no pi twin.
    appendLedger(ledgerDir, [
      {
        id: "pi:old:1",
        ts: new Date(T0 + 2000).toISOString(),
        wolf: "1uk4",
        source: "pi",
        use: "main",
        provider: "claude-stateless",
        billing: "subscription",
        model: "claude-opus-5-5",
        input: 1000,
        output: 2000,
        cacheRead: 10000,
        cacheWrite: 5000,
        costUsd: 0.071,
        costSource: "notional",
      },
    ]);
    expect((await ingestUsage(optsFor(den, ledgerDir))).added.durable).toBe(1);
    expect(readLedger(ledgerDir).map((r) => r.source + ":" + r.model).sort()).toEqual([
      "durable:claude-sonnet-5-5",
      "pi:claude-opus-5-5",
    ]);
  });
});

describe("ingestUsage on the wolf's own live store", () => {
  it("backfills first, then adds only entries written after, and none on a re-run", async () => {
    const den = makeDen(tmp);
    const ledgerDir = path.join(tmp, "ledger");
    const opts = optsFor(den, ledgerDir);
    expect((await ingestUsage(opts)).added.durable).toBe(2);
    addEntry(den, 12);
    expect((await ingestUsage(opts)).added.durable).toBe(1);
    expect((await ingestUsage(opts)).added.durable).toBe(0);
    expect(readLedger(ledgerDir)).toHaveLength(3);
  });

  it("re-reads from the start when the store was rebuilt (older first entry, then fewer entries)", async () => {
    const den = makeDen(tmp);
    const ledgerDir = path.join(tmp, "ledger");
    const opts = optsFor(den, ledgerDir);
    await ingestUsage(opts); // ids 10, 11
    const db = openDb(path.join(den, "session.sqlite"));
    db.exec("DELETE FROM entries");
    db.close();
    addEntry(den, 5);
    addEntry(den, 6);
    addEntry(den, 12); // newest id is past the mark, but 5 and 6 are below it
    expect((await ingestUsage(opts)).added.durable).toBe(3);

    const db2 = openDb(path.join(den, "session.sqlite"));
    db2.exec("DELETE FROM entries");
    db2.close();
    addEntry(den, 2); // newest id below the mark
    expect((await ingestUsage(opts)).added.durable).toBe(1);
  });

  it("refills after the ledger is wiped even though the state file survives", async () => {
    const den = makeDen(tmp);
    const ledgerDir = path.join(tmp, "ledger");
    const opts = optsFor(den, ledgerDir);
    await ingestUsage(opts);
    for (const f of fs.readdirSync(ledgerDir)) if (f.endsWith(".jsonl")) fs.rmSync(path.join(ledgerDir, f));
    expect((await ingestUsage(opts)).added.durable).toBe(2);
  });

  it("ends the ingest early without throwing when the store is locked, and catches up once it is free", async () => {
    const den = makeDen(tmp);
    const ledgerDir = path.join(tmp, "ledger");
    const opts = optsFor(den, ledgerDir);
    const writer = openDb(path.join(den, "session.sqlite"));
    writer.exec("BEGIN EXCLUSIVE");
    const busy = await ingestUsage(opts);
    writer.exec("COMMIT");
    writer.close();
    expect(busy.added.durable).toBe(0);
    expect((await ingestUsage(opts)).added.durable).toBe(2);
  });

  it("reads a mirrored host's store whole, and does not read the local host's own den through the hosts path", async () => {
    const root = path.join(tmp, "wolves");
    makeDen(path.join(root, "vps", "w1"));
    makeDen(path.join(root, "local", "1uk4"));
    const r = await ingestUsage({
      ledgerDir: path.join(tmp, "ledger"),
      wolvesRoot: root,
      hosts: ["vps", "local"],
      localHost: "local",
    });
    expect(r.added.durable).toBe(2);
    expect(readLedger(path.join(tmp, "ledger")).every((e) => e.id?.startsWith("durable:vps/w1:"))).toBe(true);
  });
});
