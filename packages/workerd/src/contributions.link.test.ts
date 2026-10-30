/** Contributions and receipts over the worker link: disk outbox, idempotent delivery, receipts with ack/retry (real hubd + workerd). */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "@wolfpack/kb/shared";
import { LINK_CONTRIBUTION_MAX_BYTES, type LinkFrame } from "@wolfpack/protocol";
import { Outbox, OutboxError } from "./outbox.js";
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
    await new Promise((res) => setTimeout(res, 300));
    expect(inbox(r, "alpha")).toHaveLength(3);
    const ids = readFileSync(join(r.dataDir, "link", "contribution-ids.jsonl"), "utf8").trim().split("\n");
    expect(ids).toHaveLength(3);
  });

  it("a replay of an acknowledged id after a worker restart is a duplicate even when the inbox file is gone (persisted ids)", async () => {
    const r = await rig();
    await r.waitPresence("online");
    const ob = new Outbox(r.outboxDir);
    ob.enqueue("alpha", contribution("alpha", "dup"), "fixed-id-1");
    r.workerd.link!.kick(); // flush
    await r.eventually(() => inbox(r, "alpha").length === 1 && outboxIds(r).length === 0, "first delivery");
    rmSync(join(r.inboxRoot, "alpha", inbox(r, "alpha")[0]!)); // as if the curator had moved it away
    ob.enqueue("alpha", contribution("alpha", "dup"), "fixed-id-1"); // the ack was "lost": the same id is still in the outbox
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
    await r.eventually(() => outboxIds(r).length === 0, "rejections leave the outbox");
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
    await new Promise((res) => setTimeout(res, 200));
    expect(r.hub.link.sendToWolf("alpha", { t: "ping", n: 1 })).toBe(false);
    const w = await r.rawLink(r.token);
    w.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w.until(() => receipts(w).length >= 2, "queued receipts flushed");
    expect(new Set(receipts(w).map((x) => x.name))).toEqual(new Set(["r1.md", "r2.md"]));
    // no ack yet: resent
    const before = receipts(w).length;
    await w.until(() => receipts(w).length > before, "resent without ack");
    for (const x of receipts(w)) w.send({ t: "receipt.ack", id: x.id });
    await new Promise((res) => setTimeout(res, 150));
    const after = receipts(w).length;
    await new Promise((res) => setTimeout(res, 800));
    expect(receipts(w).length).toBe(after); // acked: no more
    // delivered set persists across a hub restart
    await r.restartHub();
    const w2 = await r.rawLink(r.token);
    w2.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w2.until(() => w2.frames.some((f) => f.t === "welcome"), "welcome 2");
    await new Promise((res) => setTimeout(res, 500));
    expect(receipts(w2)).toHaveLength(0);
  });

  it("history older than the hub's first start is not replayed", async () => {
    const r = await rig({ noHub: true });
    writeReceipt(r, "alpha", "old.md");
    const old = new Date(Date.now() - 3600_000);
    (await import("node:fs")).utimesSync(join(r.receiptsRoot, "alpha", "old.md"), old, old);
    const w = await r.rawLink(r.token);
    w.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w.until(() => w.frames.some((f) => f.t === "welcome"), "welcome");
    await new Promise((res) => setTimeout(res, 300));
    expect(receipts(w)).toHaveLength(0);
  });
});
