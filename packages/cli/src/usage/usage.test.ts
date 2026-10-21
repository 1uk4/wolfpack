import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "@wolfpack/engine";
import { aggregate, localDay, parseSince } from "./aggregate.js";
import { collectUsage } from "./collect.js";
import { ingestUsage, readState, statePath } from "./ingest.js";
import { readLedger } from "./ledger.js";
import { engineEventId, readEngineLog } from "./read-engine.js";
import { usagePlist } from "../usage-schedule.js";
import { catalogModel, priceEvent, priceLoggedEvent } from "./pricing.js";
import { readDurableStore } from "./read-durable.js";
import { findSessionFiles, readPiSessionFile } from "./read-pi.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const T1 = Date.parse("2026-10-20T12:00:00Z");
const T2 = Date.parse("2026-10-21T09:00:00Z");

function assistant(provider: string, model: string, ts: number, usage: object): object {
  return { role: "assistant", provider, model, content: [{ type: "text", text: "hi" }], usage, timestamp: ts };
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const bridgeMsg = assistant("claude-bridge", "claude-sonnet-4-5", T1, {
  input: 1000,
  output: 2000,
  cacheRead: 1_000_000,
  cacheWrite: 10_000,
  totalTokens: 1_013_000,
  cost: zeroCost,
});
const apiMsg = assistant("anthropic", "claude-opus-4-8", T2, {
  input: 10,
  output: 20,
  cacheRead: 300,
  cacheWrite: 40,
  totalTokens: 370,
  cost: { ...zeroCost, total: 0.42 },
});

function piSession(id: string, messages: object[]): string {
  const lines: object[] = [
    { type: "session", version: 3, id, timestamp: new Date(T1).toISOString(), cwd: "/x" },
    { type: "model_change", id: "a", provider: "claude-bridge", modelId: "claude-sonnet-4-5" },
    { type: "message", id: "b", timestamp: new Date(T1).toISOString(), message: { role: "user", content: "hello" } },
    ...messages.map((m, i) => ({ type: "message", id: `m${i}`, timestamp: new Date(T1).toISOString(), message: m })),
    // an assistant message without usage (e.g. aborted before any token)
    { type: "message", id: "z", timestamp: new Date(T1).toISOString(), message: { role: "assistant", content: [] } },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function durableStore(file: string, records: object[]): void {
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL)",
  );
  const ins = db.prepare("INSERT INTO entries (conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?)");
  records.forEach((r, i) => ins.run(1, null, i, JSON.stringify(r)));
  db.close();
}

describe("pricing", () => {
  it("keeps a reported cost", () => {
    const e = priceEvent(
      { ts: "x", wolf: "w", source: "pi", use: "main", provider: "anthropic", billing: "api", model: "claude-opus-4-8", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      0.5,
    );
    expect(e).toMatchObject({ costUsd: 0.5, costSource: "reported" });
  });

  it("prices subscription calls at the anthropic API rate (notional)", () => {
    const m = catalogModel("anthropic", "claude-sonnet-4-5")!;
    const e = priceEvent({ ts: "x", wolf: "w", source: "pi", use: "main", provider: "claude-bridge", billing: "subscription", model: "claude-sonnet-4-5", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 0);
    expect(e.costSource).toBe("notional");
    expect(e.costUsd).toBeCloseTo(m.cost.input, 6);
  });

  it("computes unreported api cost and marks unknown models", () => {
    const base = { ts: "x", wolf: "w", source: "engine" as const, use: "main", input: 100, output: 100, cacheRead: 0, cacheWrite: 0 };
    expect(priceEvent({ ...base, provider: "anthropic", billing: "api", model: "claude-opus-4-8" }).costSource).toBe("computed");
    const unknown = priceEvent({ ...base, provider: "anthropic", billing: "api", model: "no-such-model" });
    expect(unknown).toMatchObject({ costSource: "unknown" });
    expect(unknown.costUsd).toBeUndefined();
  });

  it("fills engine events that arrive unpriced, keeps priced ones", () => {
    const base: UsageEvent = { ts: "x", wolf: "w", source: "engine", use: "step:x", provider: "claude-agent-sdk", billing: "subscription", model: "claude-sonnet-4-5", input: 100, output: 100, cacheRead: 0, cacheWrite: 0, costSource: "unknown" };
    expect(priceLoggedEvent(base).costSource).toBe("notional");
    expect(priceLoggedEvent({ ...base, costUsd: 1, costSource: "notional" }).costUsd).toBe(1);
  });
});

describe("pi session reader", () => {
  it("reads one event per assistant message with usage", async () => {
    const file = path.join(tmp, "s.jsonl");
    fs.writeFileSync(file, piSession("sess-1", [bridgeMsg, apiMsg]));
    const events = await readPiSessionFile(file, "1uk4", "main");
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.id)).toEqual(["pi:sess-1:m0", "pi:sess-1:m1"]);
    expect(events[0]).toMatchObject({
      wolf: "1uk4",
      source: "pi",
      session: "sess-1",
      use: "main",
      provider: "claude-bridge",
      billing: "subscription",
      model: "claude-sonnet-4-5",
      input: 1000,
      cacheRead: 1_000_000,
      costSource: "notional",
      ts: new Date(T1).toISOString(),
    });
    expect(events[0]!.costUsd).toBeGreaterThan(0);
    expect(events[1]).toMatchObject({ billing: "api", costUsd: 0.42, costSource: "reported" });
  });

  it("skips artifacts/ and marks registry-listed sessions as subagents", () => {
    const sessions = path.join(tmp, "sessions", "--cwd--");
    fs.mkdirSync(path.join(sessions, "artifacts", "run1"), { recursive: true });
    fs.writeFileSync(path.join(sessions, "main.jsonl"), "");
    fs.writeFileSync(path.join(sessions, "sub.jsonl"), "");
    fs.writeFileSync(path.join(sessions, "artifacts", "run1", "noise.jsonl"), "");
    fs.writeFileSync(
      path.join(sessions, "artifacts", "run1", "subagent-registry.json"),
      JSON.stringify({ worker: { sessionFile: path.join(sessions, "sub.jsonl") } }),
    );
    const found = findSessionFiles(path.join(tmp, "sessions"));
    expect(found.files.map((f) => path.basename(f))).toEqual(["main.jsonl", "sub.jsonl"]);
    expect([...found.subagent]).toEqual([path.join(sessions, "sub.jsonl")]);
  });
});

describe("durable store reader", () => {
  it("reads assistant messages with usage from entries", () => {
    const file = path.join(tmp, "session.sqlite");
    durableStore(file, [
      { kind: "pi.user", model: [{ role: "user", content: "hi", timestamp: T1 }] },
      { kind: "pi.assistant", model: [{ ...apiMsg, responseModel: "claude-opus-4-8-x" }] },
      { kind: "pi.tool-result", model: [{ role: "toolResult", content: [] }] },
    ]);
    const events = readDurableStore(file, "vps1", "hal");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "durable:vps1/hal:2:0",
      wolf: "hal",
      source: "durable",
      session: "conv-1",
      costUsd: 0.42,
      ts: new Date(T2).toISOString(),
    });
  });
});

const engineEvent: UsageEvent = { ts: new Date(T2).toISOString(), wolf: "me", source: "engine", use: "step:consolidate", provider: "anthropic", billing: "api", model: "claude-haiku-4-5", input: 5, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.01, costSource: "reported" };

/** <tmp>/wolves: local wolf `me` (one pi session, one engine log), VPS wolf vps1/hal (a store). */
function wolvesTree(): string {
  const root = path.join(tmp, "wolves");
  const local = path.join(root, "local", "me");
  fs.mkdirSync(path.join(local, "agent", "sessions", "--cwd--"), { recursive: true });
  fs.writeFileSync(path.join(local, "wolf.yaml"), "id: w1\nname: me\nruntime: pi\n");
  fs.writeFileSync(path.join(local, "agent", "sessions", "--cwd--", "a.jsonl"), piSession("s", [bridgeMsg]));
  fs.mkdirSync(path.join(local, "den", "usage"), { recursive: true });
  fs.writeFileSync(path.join(local, "den", "usage", "2026-10.jsonl"), JSON.stringify(engineEvent) + "\n");
  const den = path.join(root, "vps1", "hal", "den");
  fs.mkdirSync(den, { recursive: true });
  durableStore(path.join(den, "session.sqlite"), [{ kind: "pi.assistant", model: [apiMsg] }]);
  return root;
}

describe("engine log reader", () => {
  it("ids each line by a stable hash of its raw text", () => {
    const file = path.join(tmp, "2026-10.jsonl");
    const line = JSON.stringify(engineEvent);
    fs.writeFileSync(file, `${line}\n{torn\n${line.replace("step:consolidate", "step:other")}\n`);
    const [a, b] = readEngineLog(file, "me");
    expect(a!.id).toMatch(/^engine:me:[0-9a-f]{64}$/);
    expect(a!.id).toBe(readEngineLog(file, "me")[0]!.id);
    expect(b!.id).not.toBe(a!.id);
  });
});

describe("ingest", () => {
  const ids = (dir: string) => readLedger(dir).map((e) => e.id).sort();

  it("is idempotent and skips unchanged files", async () => {
    const root = wolvesTree();
    const ledgerDir = path.join(tmp, "ledger");
    const opts = { wolvesRoot: root, hosts: ["vps1"], ledgerDir };
    const first = await ingestUsage(opts);
    expect(first.added).toEqual({ pi: 1, durable: 1, engine: 1 });
    expect(first.scanned).toBe(3);
    expect(Object.keys(readState(ledgerDir).files)).toHaveLength(3);
    const before = ids(ledgerDir);
    expect(before).toHaveLength(3);

    const second = await ingestUsage(opts);
    expect(second).toMatchObject({ added: { pi: 0, durable: 0, engine: 0 }, scanned: 0, unchanged: 3 });
    expect(ids(ledgerDir)).toEqual(before);

    // A changed file is rescanned whole; ids keep the old events out.
    const session = path.join(root, "local", "me", "agent", "sessions", "--cwd--", "a.jsonl");
    fs.writeFileSync(session, piSession("s", [bridgeMsg, apiMsg]));
    const third = await ingestUsage(opts);
    expect(third).toMatchObject({ added: { pi: 1, durable: 0, engine: 0 }, scanned: 1, unchanged: 2 });
    expect(ids(ledgerDir)).toHaveLength(4);

    // Even without the state file, a rerun adds nothing.
    fs.rmSync(statePath(ledgerDir));
    const fourth = await ingestUsage(opts);
    expect(fourth).toMatchObject({ added: { pi: 0, durable: 0, engine: 0 }, scanned: 3 });
    expect(ids(ledgerDir)).toHaveLength(4);
  });

  it("keeps a deleted source's events in the ledger", async () => {
    const root = wolvesTree();
    const ledgerDir = path.join(tmp, "ledger");
    const opts = { wolvesRoot: root, hosts: ["vps1"], ledgerDir };
    await ingestUsage(opts);
    fs.rmSync(path.join(root, "local", "me", "agent", "sessions"), { recursive: true });
    fs.rmSync(path.join(root, "vps1", "hal", "den", "session.sqlite"));
    const r = await ingestUsage(opts);
    expect(r.added).toEqual({ pi: 0, durable: 0, engine: 0 });
    expect(readLedger(ledgerDir).map((e) => e.source).sort()).toEqual(["durable", "engine", "pi"]);
    expect(Object.keys(readState(ledgerDir).files)).toHaveLength(1); // only the engine log is left
  });
});

describe("collectUsage", () => {
  it("reads local pi sessions, mirrored durable stores and engine logs", async () => {
    const root = wolvesTree();

    const { events, sources } = await collectUsage({ wolvesRoot: root, hosts: ["vps1", "vps2"] });
    expect(events.map((e) => `${e.wolf}:${e.source}`).sort()).toEqual(["hal:durable", "me:engine", "me:pi"]);
    expect(sources).toEqual({ pi: { me: 1 }, durable: ["hal"], engineDens: ["local/me"], skipped: ["no mirror for host vps2"] });
    expect(events.find((e) => e.source === "engine")!.id).toBe(
      engineEventId("me", JSON.stringify(engineEvent)),
    );

    const only = await collectUsage({ wolvesRoot: root, hosts: ["vps1"], wolf: "hal" });
    expect(only.events.map((e) => e.wolf)).toEqual(["hal"]);
  });
});

describe("aggregate", () => {
  const ev = (over: Partial<UsageEvent>): UsageEvent => ({
    ts: new Date(T1).toISOString(),
    wolf: "a",
    source: "pi",
    use: "main",
    provider: "anthropic",
    billing: "api",
    model: "m1",
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    costUsd: 1,
    costSource: "reported",
    ...over,
  });
  const events = [
    ev({}),
    ev({ wolf: "b", billing: "subscription", provider: "claude-bridge", costSource: "notional", costUsd: 2, input: 100 }),
    ev({ wolf: "b", billing: "openrouter", provider: "openrouter", model: "m2", source: "durable", costUsd: 3, ts: new Date(T2).toISOString() }),
    ev({ model: "m3", costUsd: undefined, costSource: "unknown", source: "engine" }),
  ];

  it("totals tokens and splits cost by billing", () => {
    const { total } = aggregate(events, "wolf");
    expect(total).toMatchObject({ calls: 4, input: 103, totalTokens: 139, apiUsd: 1, notionalUsd: 2, otherUsd: 3, unpriced: 1 });
  });

  it.each([
    ["wolf", ["b", "a"]],
    ["model", ["m1", "m2", "m3"]],
    ["billing", ["subscription", "api", "openrouter"]],
    ["source", ["pi", "durable", "engine"]],
    ["day", [localDay(new Date(T1).toISOString()), localDay(new Date(T2).toISOString())]],
  ] as const)("groups by %s", (by, keys) => {
    expect(aggregate(events, by).rows.map((r) => r.key)).toEqual(keys);
  });

  it("filters by since and wolf", () => {
    expect(aggregate(events, "wolf", { since: new Date(T2) }).total.calls).toBe(1);
    expect(aggregate(events, "wolf", { wolf: "a" }).rows.map((r) => r.key)).toEqual(["a"]);
  });
});

describe("parseSince", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  it("parses relative windows, dates and all", () => {
    expect(parseSince("24h", now)!.toISOString()).toBe("2026-10-20T12:00:00.000Z");
    expect(parseSince("7d", now)!.toISOString()).toBe("2026-10-14T12:00:00.000Z");
    expect(parseSince("2026-10-01", now)!.getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(parseSince("all", now)).toBeUndefined();
  });
  it("rejects anything else", () => {
    expect(() => parseSince("7w", now)).toThrow(/--since/);
    expect(() => parseSince("2026-02-31", now)).toThrow(/--since/);
  });
});

describe("usage schedule plist", () => {
  it("pins the installing node and puts it first on PATH", () => {
    const plist = usagePlist("/opt/nvm/v22.23.3/bin/node", "/repo/packages/cli/dist/bin/wolfpack.js");
    expect(plist).toContain("<string>/opt/nvm/v22.23.3/bin/node</string><string>/repo/packages/cli/dist/bin/wolfpack.js</string><string>usage</string><string>ingest</string>");
    expect(plist).toContain("<key>PATH</key><string>/opt/nvm/v22.23.3/bin:");
    expect(plist).toContain("<integer>3600</integer>");
  });
});
