/** Contributions and receipts over the worker link: disk outbox, idempotent delivery, receipts with ack/retry (real hubd + workerd). */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "@wolfpack/kb/shared";
import { LINK_CONTRIBUTION_MAX_BYTES, LINK_RECEIPT_MAX_BYTES, type LinkFrame } from "@wolfpack/protocol";
import { WebSocketServer } from "ws";
import { HubLink } from "./link.js";
import { Outbox, OutboxError, outboxFileId, writeReceiptFile } from "./outbox.js";
import { until } from "./testing/helpers.js";
import { startLinkRig, type LinkRig, type RawLink } from "./testing/link-rig.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function rig(o: Parameters<typeof startLinkRig>[0] = {}): Promise<LinkRig> {
  const r = await startLinkRig(o);
  cleanup.push(() => r.close());
  return r;
}
const contribution = (from: string, topic: string, body = "The body.") => ({
  from, denTopicId: topic, change: "create", contentHash: contentHash(body), prevHash: null,
  domainHint: "wolfpack", summary: "Summary line.", submitted: "2026-10-01 12:00", body, origin: "crawl", sourcePath: "/src",
});
const inbox = (r: LinkRig, wolf: string) => {
  try {
    return readdirSync(join(r.inboxRoot, wolf)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
};
const fileLines = (f: string): string[] => {
  try {
    return readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const outboxIds = (r: LinkRig) => new Outbox(r.outboxDir).list().map((i) => i.id);
const acks = (l: RawLink) => l.frames.filter((f): f is Extract<LinkFrame, { t: "contribute.ack" }> => f.t === "contribute.ack");
const receipts = (l: RawLink) => l.frames.filter((f): f is Extract<LinkFrame, { t: "receipt" }> => f.t === "receipt");

describe("contributions over the link", () => {
  it("delivers into the librarian inbox (Dewey's file name) and empties the outbox", async () => {
    const r = await rig();
    await r.waitPresence("online");
    const id = r.workerd.link!.contribute("alpha", contribution("alpha", "topic-a"));
    await r.eventually(() => inbox(r, "alpha").length === 1 && outboxIds(r).length === 0, "delivered and acked");
    expect(inbox(r, "alpha")).toEqual([`topic-a-${contentHash("The body.").slice(7, 17)}.md`]);
    expect(readFileSync(join(r.inboxRoot, "alpha", inbox(r, "alpha")[0]!), "utf8")).toMatch(/^---\nfrom: alpha\nden_topic_id: topic-a\n/);
    expect(id).toBeTruthy();
    expect(existsSync(join(r.dataDir, "kb", "ops", "contributions"))).toBe(false); // the configured root was used, not the default
  });

  it("items queued while the hub is down survive on disk and are delivered once on reconnect, never twice", async () => {
    const r = await rig();
    await r.waitPresence("online");
    await r.stopHub();
    await r.eventually(() => r.workerd.link!.status().state !== "online", "link down");
    for (const t of ["t1", "t2", "t3"]) r.workerd.link!.contribute("alpha", contribution("alpha", t, `body ${t}`));
    expect(outboxIds(r)).toHaveLength(3);
    expect(inbox(r, "alpha")).toHaveLength(0);
    await r.startHub();
    await r.eventually(() => inbox(r, "alpha").length === 3 && outboxIds(r).length === 0, "all delivered");
    r.workerd.link!.kick();
    await r.waitPresence("online");
    // a sentinel sent after the reconnect: once it lands, any wrongly replayed item would have landed too
    r.workerd.link!.contribute("alpha", contribution("alpha", "t4", "body t4"));
    await r.eventually(() => inbox(r, "alpha").length === 4 && outboxIds(r).length === 0, "sentinel delivered");
    expect(inbox(r, "alpha")).toHaveLength(4);
    const ids = readFileSync(join(r.dataDir, "link", "contribution-ids.jsonl"), "utf8").trim().split("\n");
    expect(ids).toHaveLength(4);
  });

  it("a replay of an acknowledged id after a worker restart is a duplicate even when the inbox file is gone (persisted ids)", async () => {
    const r = await rig();
    await r.waitPresence("online");
    r.workerd.link!.contribute("alpha", contribution("alpha", "dup"), "fixed-id-1");
    await r.eventually(() => inbox(r, "alpha").length === 1 && outboxIds(r).length === 0, "first delivery");
    rmSync(join(r.inboxRoot, "alpha", inbox(r, "alpha")[0]!)); // as if the curator had moved it away
    await r.workerd.close(); // the outbox is only ever opened by one process: edit it while workerd is down
    new Outbox(r.outboxDir).enqueue("alpha", contribution("alpha", "dup"), "fixed-id-1"); // the ack was "lost": the same id is still queued
    await r.restartWorkerd();
    await r.eventually(() => outboxIds(r).length === 0, "replay acked");
    expect(inbox(r, "alpha")).toHaveLength(0); // not stored again
  });

  it("the seen set survives a hub restart", async () => {
    const r = await rig({ noHub: true });
    const w = await r.rawLink(r.token);
    w.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w.until(() => w.frames.some((f) => f.t === "welcome"), "welcome");
    const item = { t: "contribute", id: "same-id", wolf: "alpha", contribution: contribution("alpha", "restart") };
    w.send(item);
    await w.until(() => acks(w).length === 1, "ack 1");
    expect(acks(w)[0]).toMatchObject({ id: "same-id", status: "accepted" });
    await r.restartHub();
    rmSync(join(r.inboxRoot, "alpha"), { recursive: true });
    const w2 = await r.rawLink(r.token);
    w2.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w2.until(() => w2.frames.some((f) => f.t === "welcome"), "welcome 2");
    w2.send(item);
    await w2.until(() => acks(w2).length === 1, "ack 2");
    expect(acks(w2)[0]).toMatchObject({ id: "same-id", status: "duplicate" });
    expect(inbox(r, "alpha")).toHaveLength(0);
  });

  it("refuses contributions for wolves the host does not own (foreign, unowned, unknown)", async () => {
    const r = await rig({ preRegister: ["gamma"] });
    await r.waitPresence("online");
    const other = r.mintWorker("evil");
    await r.registerWolf("beta");
    const e = await r.rawLink(other.token);
    e.hello({ hostId: "evil", wolves: [{ name: "beta", domains: [] }] });
    await e.until(() => e.frames.some((f) => f.t === "welcome"), "welcome evil");
    // evil owns beta; it may not write for alpha (owned by box)
    e.send({ t: "contribute", id: "x1", wolf: "alpha", contribution: contribution("alpha", "steal") });
    await e.until(() => acks(e).length === 1, "ack");
    expect(acks(e)[0]).toMatchObject({ id: "x1", status: "rejected", code: "foreign_wolf" });
    // box via the real link: unowned and unknown wolves
    r.workerd.link!.contribute("gamma", contribution("gamma", "g"));
    r.workerd.link!.contribute("nobody", contribution("nobody", "n"));
    await r.eventually(() => outboxIds(r).length === 0 && existsSync(join(r.outboxDir, "rejected")) && readdirSync(join(r.outboxDir, "rejected")).length === 2, "rejections leave the outbox after the retries", 8000);
    expect(readdirSync(join(r.outboxDir, "rejected"))).toHaveLength(2); // kept for the operator, not retried
    expect(inbox(r, "alpha")).toHaveLength(0);
    expect(inbox(r, "gamma")).toHaveLength(0);
    expect(inbox(r, "nobody")).toHaveLength(0);
  });

  it("an invalid contribution is rejected with a clear code and not retried", async () => {
    const r = await rig();
    await r.waitPresence("online");
    r.workerd.link!.contribute("alpha", { from: "alpha", body: "no hash" });
    await r.eventually(() => outboxIds(r).length === 0 && existsSync(join(r.outboxDir, "rejected")), "dead-lettered");
    expect(inbox(r, "alpha")).toHaveLength(0);
  });

  it("oversized items: refused at enqueue by the worker, and by the hub with a too_large error ack", async () => {
    const r = await rig();
    await r.waitPresence("online");
    const big = contribution("alpha", "big", "x".repeat(LINK_CONTRIBUTION_MAX_BYTES + 10));
    expect(() => r.workerd.link!.contribute("alpha", big)).toThrow(OutboxError);
    expect(outboxIds(r)).toHaveLength(0);
    const raw = await r.rawLink(r.mintWorker("evil").token);
    raw.hello({ hostId: "evil", wolves: [] });
    await raw.until(() => raw.frames.some((f) => f.t === "welcome"), "welcome");
    raw.send({ t: "contribute", id: "big-1", wolf: "alpha", contribution: big });
    await raw.until(() => acks(raw).length === 1, "ack");
    // ownership is checked first, so use the owning host for the size check
    expect(acks(raw)[0]).toMatchObject({ status: "rejected" });
    const r2 = await rig({ noHub: true });
    const w = await r2.rawLink(r2.token);
    w.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w.until(() => w.frames.some((f) => f.t === "welcome"), "welcome");
    w.send({ t: "contribute", id: "big-2", wolf: "alpha", contribution: big });
    await w.until(() => acks(w).length === 1, "ack big");
    expect(acks(w)[0]).toMatchObject({ id: "big-2", status: "rejected", code: "too_large" });
    expect(inbox(r2, "alpha")).toHaveLength(0);
  });
});

describe("receipts over the link", () => {
  const writeReceipt = (r: LinkRig, wolf: string, name: string, text = "---\noutcome: committed\n---\n\nok\n") => {
    mkdirSync(join(r.receiptsRoot, wolf), { recursive: true });
    writeFileSync(join(r.receiptsRoot, wolf, name), text);
  };

  it("a librarian receipt reaches the owning wolf's receipts dir on the worker", async () => {
    const r = await rig();
    await r.waitPresence("online");
    writeReceipt(r, "alpha", "topic-a-abc.md");
    await r.eventually(() => existsSync(join(r.kbOps, "receipts", "alpha", "topic-a-abc.md")), "receipt written");
    expect(readFileSync(join(r.kbOps, "receipts", "alpha", "topic-a-abc.md"), "utf8")).toContain("outcome: committed");
  });

  it("receipts for an offline host queue on the hub, flush on reconnect, are resent until acked and then stop", async () => {
    const r = await rig({ noHub: true });
    writeReceipt(r, "alpha", "r1.md");
    // register the wolf on the host first via a short-lived link, then go offline
    const w0 = await r.rawLink(r.token);
    w0.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w0.until(() => w0.frames.some((f) => f.t === "welcome"), "welcome 0");
    w0.ws.close();
    await r.eventually(() => r.presence() !== "online", "offline");
    writeReceipt(r, "alpha", "r2.md");
    expect(r.hub.link.sendToWolf("alpha", { t: "ping", n: 1 })).toBe(false);
    const w = await r.rawLink(r.token);
    w.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w.until(() => receipts(w).length >= 2, "queued receipts flushed");
    expect(new Set(receipts(w).map((x) => x.name))).toEqual(new Set(["r1.md", "r2.md"]));
    // no ack yet: resent
    const before = receipts(w).length;
    await w.until(() => receipts(w).length > before, "resent without ack");
    for (const x of receipts(w)) w.send({ t: "receipt.ack", id: x.id });
    await r.eventually(() => fileLines(join(r.dataDir, "link", "receipts-delivered.jsonl")).length === 2, "both receipts recorded as delivered");
    // a sentinel receipt: once it arrives, the scans that would have resent r1/r2 have run
    writeReceipt(r, "alpha", "r3.md");
    await w.until(() => receipts(w).some((x) => x.name === "r3.md"), "sentinel receipt");
    const mark = receipts(w).length;
    for (const x of receipts(w).filter((x) => x.name === "r3.md")) w.send({ t: "receipt.ack", id: x.id });
    await r.eventually(() => fileLines(join(r.dataDir, "link", "receipts-delivered.jsonl")).length === 3, "sentinel delivered");
    expect(mark).toBeGreaterThan(0);
    // delivered set persists across a hub restart; the high-water mark persists too
    await r.restartHub();
    const w2 = await r.rawLink(r.token);
    w2.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w2.until(() => w2.frames.some((f) => f.t === "welcome"), "welcome 2");
    writeReceipt(r, "alpha", "r4.md");
    await w2.until(() => receipts(w2).some((x) => x.name === "r4.md"), "new receipt arrives");
    expect(receipts(w2).map((x) => x.name)).toEqual(["r4.md"]); // r1..r3 not replayed
  });

  it("the high-water mark keeps old receipts from being re-sent even if the delivered-id set forgets them", async () => {
    const r = await rig({ noHub: true });
    const w = await r.rawLink(r.token);
    w.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w.until(() => w.frames.some((f) => f.t === "welcome"), "welcome");
    writeReceipt(r, "alpha", "h1.md");
    await w.until(() => receipts(w).length === 1, "h1");
    w.send({ t: "receipt.ack", id: receipts(w)[0]!.id });
    await r.eventually(() => Number(fileLines(join(r.dataDir, "link", "receipts-since"))[0]) >= statSync(join(r.receiptsRoot, "alpha", "h1.md")).mtimeMs, "mark moved past h1");
    await r.stopHub();
    rmSync(join(r.dataDir, "link", "receipts-delivered.jsonl")); // expiry: the id set forgot everything
    await r.startHub();
    const w2 = await r.rawLink(r.token);
    w2.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w2.until(() => w2.frames.some((f) => f.t === "welcome"), "welcome 2");
    writeReceipt(r, "alpha", "h2.md");
    await w2.until(() => receipts(w2).some((x) => x.name === "h2.md"), "h2");
    expect(receipts(w2).map((x) => x.name)).toEqual(["h2.md"]);
  });

  it("an oversized receipt is skipped and does not block the others", async () => {
    const r = await rig({ noHub: true });
    const w = await r.rawLink(r.token);
    w.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w.until(() => w.frames.some((f) => f.t === "welcome"), "welcome");
    writeReceipt(r, "alpha", "big.md", "x".repeat(LINK_RECEIPT_MAX_BYTES + 1));
    writeReceipt(r, "alpha", "small.md");
    await w.until(() => receipts(w).some((x) => x.name === "small.md"), "small arrives");
    expect(receipts(w).some((x) => x.name === "big.md")).toBe(false);
    expect(readdirSync(join(r.receiptsRoot, "alpha")).sort()).toEqual(["big.md", "small.md"]);
  });

  it("history older than the hub's first start is not replayed", async () => {
    const r = await rig({ noHub: true });
    writeReceipt(r, "alpha", "old.md");
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(r.receiptsRoot, "alpha", "old.md"), old, old);
    const w = await r.rawLink(r.token);
    w.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w.until(() => w.frames.some((f) => f.t === "welcome"), "welcome");
    writeReceipt(r, "alpha", "new.md"); // sentinel
    await w.until(() => receipts(w).some((x) => x.name === "new.md"), "sentinel");
    expect(receipts(w).map((x) => x.name)).toEqual(["new.md"]);
  });
});

describe("non-terminal rejections and crash safety", () => {
  it("internal is not dead-lettered: the item stays queued, retries with backoff and is delivered once the cause clears", async () => {
    const r = await rig();
    await r.waitPresence("online");
    mkdirSync(r.inboxRoot, { recursive: true });
    writeFileSync(join(r.inboxRoot, "alpha"), "in the way"); // the wolf's lane cannot be created: the hub answers internal
    r.workerd.link!.contribute("alpha", contribution("alpha", "later"));
    await r.eventually(() => r.logs.some((l) => l.includes("will retry")), "an internal rejection was seen");
    expect(outboxIds(r)).toHaveLength(1);
    expect(existsSync(join(r.outboxDir, "rejected"))).toBe(false);
    rmSync(join(r.inboxRoot, "alpha"));
    await r.eventually(() => inbox(r, "alpha").length === 1 && outboxIds(r).length === 0, "delivered after the retry", 8000);
    expect(existsSync(join(r.outboxDir, "rejected"))).toBe(false);
  });

  it("a crash between storing and recording the id delivers exactly one inbox file", async () => {
    let n = 0;
    const r = await rig({ hubOptions: { linkFaults: { beforeSeenAdd: () => { if (n++ === 0) throw new Error("boom"); } } } });
    await r.waitPresence("online");
    r.workerd.link!.contribute("alpha", contribution("alpha", "crash"));
    await r.eventually(() => outboxIds(r).length === 0, "delivered after one internal answer", 8000);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(inbox(r, "alpha")).toHaveLength(1);
    expect(readFileSync(join(r.dataDir, "link", "contribution-ids.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("foreign_wolf is retried before it is dead-lettered (ownership can lag)", async () => {
    const r = await rig({ preRegister: ["gamma"], linkOptions: { foreignRetries: 100 } });
    await r.waitPresence("online");
    r.workerd.link!.contribute("gamma", contribution("gamma", "lag"));
    await r.eventually(() => r.logs.some((l) => l.includes("not on this host")), "first foreign_wolf answer");
    expect(outboxIds(r)).toHaveLength(1);
    r.workerd.link!.wolfAdded({ name: "gamma", domains: [] }); // the registry now gives this host the wolf
    await r.eventually(() => inbox(r, "gamma").length === 1 && outboxIds(r).length === 0, "delivered after ownership arrived", 8000);
    expect(existsSync(join(r.outboxDir, "rejected"))).toBe(false);
  });

  it("contribution.from must equal the frame's wolf; path-like wolf names are refused", async () => {
    const r = await rig({ noHub: true });
    const w = await r.rawLink(r.token);
    w.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w.until(() => w.frames.some((f) => f.t === "welcome"), "welcome");
    w.send({ t: "contribute", id: "f1", wolf: "alpha", contribution: contribution("beta", "spoof") });
    w.send({ t: "contribute", id: "f2", wolf: "../escape", contribution: contribution("../escape", "x") });
    w.send({ t: "contribute", id: "f3", wolf: "a/b", contribution: contribution("a/b", "x") });
    await w.until(() => acks(w).length === 3, "three acks");
    expect(acks(w).find((a) => a.id === "f1")).toMatchObject({ status: "rejected", code: "invalid" });
    expect(acks(w).find((a) => a.id === "f2")).toMatchObject({ status: "rejected", code: "foreign_wolf" });
    expect(acks(w).find((a) => a.id === "f3")).toMatchObject({ status: "rejected", code: "foreign_wolf" });
    expect(inbox(r, "alpha")).toHaveLength(0);
    expect(existsSync(join(r.inboxRoot, "..", "escape"))).toBe(false);
  });
});

describe("outbox", () => {
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "outbox-"));
    cleanup.push(() => rmSync(d, { recursive: true, force: true }));
    return d;
  };
  it("matches ids exactly: ids a-b and b do not collide", () => {
    const ob = new Outbox(tmp());
    ob.enqueue("alpha", { n: 1 }, "a-b");
    ob.enqueue("alpha", { n: 2 }, "b");
    expect(outboxFileId(readdirSync(ob.dir).find((f) => f.endsWith("-a-b.json"))!)).toBe("a-b");
    ob.remove("b");
    expect(ob.list().map((i) => i.id)).toEqual(["a-b"]);
    expect(new Outbox(ob.dir).list().map((i) => i.id)).toEqual(["a-b"]); // a reload agrees
    ob.remove("a-b");
    expect(new Outbox(ob.dir).list()).toEqual([]);
  });
  it("reject keeps the original until the dead letter is durable", () => {
    const dir = tmp();
    const ob = new Outbox(dir);
    ob.enqueue("alpha", { n: 1 }, "x1");
    writeFileSync(join(dir, "rejected"), "a file where the directory should be");
    expect(() => ob.reject("x1", "invalid: nope")).toThrow();
    expect(ob.list().map((i) => i.id)).toEqual(["x1"]);
    rmSync(join(dir, "rejected"));
    ob.reject("x1", "invalid: nope");
    expect(ob.list()).toEqual([]);
    const dead = readdirSync(join(dir, "rejected"));
    expect(dead).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "rejected", dead[0]!), "utf8"))).toMatchObject({ id: "x1", reason: "invalid: nope" });
  });
  it("receipt names cannot escape the receipts dir", () => {
    const ko = tmp();
    for (const [wolf, name] of [["..", "a.md"], ["a/b", "a.md"], ["alpha", "../../x.md"], ["alpha", "a/b.md"], ["alpha", ".hidden.md"], ["alpha", "a.txt"]] as const) {
      expect(() => writeReceiptFile(ko, wolf, name, "x")).toThrow();
    }
    expect(readdirSync(ko)).toEqual([]);
    expect(writeReceiptFile(ko, "alpha", "ok-1.md", "x")).toBe(join(ko, "receipts", "alpha", "ok-1.md"));
  });
  it("sends at most sendWindow unacked items and resumes as acks arrive", async () => {
    const wss = new WebSocketServer({ port: 0 });
    cleanup.push(() => new Promise<void>((res) => wss.close(() => res())));
    const got: string[] = [];
    let sock: import("ws").WebSocket | undefined;
    wss.on("connection", (ws) => {
      sock = ws;
      ws.on("message", (d) => {
        const f = JSON.parse(d.toString());
        if (f.t === "hello") ws.send(JSON.stringify({ t: "welcome", v: 1, heartbeatMs: 10_000, deadAfterMs: 30_000, retired: [], rejected: [], domainMismatch: [], hubRevisions: {} }));
        if (f.t === "contribute") got.push(f.id);
      });
    });
    const ob = new Outbox(tmp());
    for (let i = 0; i < 5; i++) ob.enqueue("alpha", { n: i }, `i${i}`);
    const link = new HubLink({ hubUrl: `http://127.0.0.1:${(wss.address() as any).port}`, token: "t", hostId: "box", wolves: () => [], outbox: ob, sendWindow: 2, ackTimeoutMs: 60_000 });
    cleanup.push(() => link.stop());
    link.start();
    await until(() => got.length === 2, 5000, "window of 2");
    sock!.send(JSON.stringify({ t: "contribute.ack", id: "i0", status: "accepted" }));
    await until(() => ob.size === 4, 5000, "i0 removed");
    link.contribute("alpha", { n: 9 }, "i9"); // triggers a flush
    await until(() => got.length === 3 && got.includes("i2"), 5000, "window slides");
    expect(got).toEqual(["i0", "i1", "i2"]);
  });
});
