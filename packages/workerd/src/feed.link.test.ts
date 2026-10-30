/** Contribution files written by emitDelta reach the hub over the link (real hubd + workerd), and move to sent/. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contributionFileName, renderContribution } from "@wolfpack/kb/client";
import { contentHash, type Contribution } from "@wolfpack/kb/shared";
import { chmodSync, symlinkSync } from "node:fs";
import { feedContributions, feedDisabledReason, feedId } from "./feed.js";
import { OutboxError } from "./outbox.js";
import { Outbox } from "./outbox.js";
import { startLinkRig, type LinkRig } from "./testing/link-rig.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function rig(o: Parameters<typeof startLinkRig>[0] = {}): Promise<LinkRig> {
  const r = await startLinkRig(o);
  cleanup.push(() => r.close());
  return r;
}
const make = (wolf: string, topic: string, body = "The body.", extra: Partial<Contribution> = {}): Contribution => ({
  from: wolf, denTopicId: topic, change: "create", contentHash: contentHash(body), prevHash: null,
  domainHint: "wolfpack", summary: "Summary line.", submitted: "2026-10-01 12:00", body, ...extra,
});
const lane = (r: LinkRig, wolf: string) => join(r.kbOps, "inbox", wolf);
const emit = (r: LinkRig, c: Contribution): string => {
  mkdirSync(lane(r, c.from), { recursive: true });
  const name = contributionFileName(c.denTopicId, c.contentHash);
  writeFileSync(join(lane(r, c.from), name), renderContribution(c));
  return name;
};
const hubInbox = (r: LinkRig, wolf: string) => {
  try {
    return readdirSync(join(r.inboxRoot, wolf)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
};
const outboxIds = (r: LinkRig) => new Outbox(r.outboxDir).list().map((i) => i.id);
const top = (r: LinkRig, wolf: string) => readdirSync(lane(r, wolf)).filter((f) => f.endsWith(".md"));

describe("feeding emitDelta files into the link", () => {
  it("a file goes end to end into the hub inbox, byte identical, and the original moves to sent/", async () => {
    const r = await rig({ linkOptions: {} });
    const c = make("alpha", "topic-a", "Body with\n\nparagraphs.", { anchor: "my-anchor", verbatim: true, host: "box", source: { feature: "work-x-1", tasks: ["t1", "t2"] } });
    const name = emit(r, c);
    const text = readFileSync(join(lane(r, "alpha"), name), "utf8");
    await r.waitPresence("online");
    await r.eventually(() => hubInbox(r, "alpha").length === 1 && outboxIds(r).length === 0, "delivered");
    expect(hubInbox(r, "alpha")).toEqual([name]);
    expect(readFileSync(join(r.inboxRoot, "alpha", name), "utf8")).toBe(text);
    expect(top(r, "alpha")).toEqual([]);
    expect(readFileSync(join(lane(r, "alpha"), "sent", name), "utf8")).toBe(text);
  });

  it("without a hub link nothing is scanned or moved", async () => {
    const r = await rig({ noHub: true });
    const name = emit(r, make("alpha", "t"));
    await new Promise((res) => setTimeout(res, 300));
    expect(top(r, "alpha")).toEqual([name]);
    expect(existsSync(join(lane(r, "alpha"), "sent"))).toBe(false);
  });

  it("a crash between enqueue and move delivers exactly once", async () => {
    const r = await rig({ feedIntervalMs: 3_600_000 }); // only the explicit passes below scan
    await r.waitPresence("online");
    const c = make("alpha", "crash");
    const name = emit(r, c);
    const file = join(lane(r, "alpha"), name);
    // pass 1 "crashes" after the enqueue and before the move: the item is queued under the id the feed uses, the file stays
    let id = "";
    feedContributions(r.kbOps, ["alpha"], { contribute: (w, x, i) => { id = i; r.workerd.link!.contribute(w, x as never, i); throw new Error("crash before the move"); } }, () => {});
    expect(existsSync(file)).toBe(true);
    await r.eventually(() => hubInbox(r, "alpha").length === 1 && outboxIds(r).length === 0, "first delivery acked");
    // after the restart pass 2 finds the file again, enqueues the same id and the hub answers duplicate
    expect(feedContributions(r.kbOps, ["alpha"], { contribute: (w, x, i) => r.workerd.link!.contribute(w, x as never, i) }, () => {}).queued).toBe(1);
    await r.eventually(() => outboxIds(r).length === 0, "replay acked");
    await new Promise((res) => setTimeout(res, 200));
    expect(top(r, "alpha")).toEqual([]);
    expect(existsSync(join(lane(r, "alpha"), "sent", name))).toBe(true);
    expect(hubInbox(r, "alpha")).toEqual([name]);
    const ids = readFileSync(join(r.dataDir, "link", "contribution-ids.jsonl"), "utf8").trim().split("\n").filter((l) => l.includes(id));
    expect(ids).toHaveLength(1);
  });

  it("a move failure after the enqueue keeps the file and the next scan does not duplicate", async () => {
    const r = await rig({ noHub: true });
    const name = emit(r, make("alpha", "mv"));
    const queued: string[] = [];
    const target = { contribute: (_w: string, _c: Record<string, unknown>, id: string) => void queued.push(id) };
    writeFileSync(join(lane(r, "alpha"), "sent"), "a file where the directory should be"); // makes mkdir sent/ fail
    const logs: string[] = [];
    expect(feedContributions(r.kbOps, ["alpha"], target, (m) => logs.push(m)).queued).toBe(0);
    expect(top(r, "alpha")).toEqual([name]);
    feedContributions(r.kbOps, ["alpha"], target, () => {});
    expect(new Set(queued).size).toBe(1); // same stable id both times
    expect(logs.join("\n")).toMatch(/not moved to sent/);
  });

  it("skips dotfiles, temp files, _processed, _bad, sent/, non-.md files and wolves it does not host", async () => {
    const r = await rig({ noHub: true });
    const l = lane(r, "alpha");
    mkdirSync(join(l, "_processed"), { recursive: true });
    mkdirSync(join(l, "_bad"), { recursive: true });
    mkdirSync(join(l, "sent"), { recursive: true });
    const text = renderContribution(make("alpha", "x"));
    for (const p of [".hidden.md", "x-0123456789.md.tmp-123-456", "_processed/a.md", "_bad/b.md", "sent/c.md", "notes.txt"]) writeFileSync(join(l, p), text);
    emit(r, make("stranger", "y"));
    const queued: string[] = [];
    const res = feedContributions(r.kbOps, ["alpha"], { contribute: (_w, _c, id) => void queued.push(id) }, () => {});
    expect(res).toEqual({ queued: 0, skipped: 0 });
    expect(queued).toEqual([]);
    expect(top(r, "stranger")).toHaveLength(1);
  });

  it("files failing parse, round-trip or hash stay untouched in the lane, logged once per path, never quarantined", async () => {
    const r = await rig({ noHub: true });
    mkdirSync(lane(r, "alpha"), { recursive: true });
    const w = (n: string, t: string) => writeFileSync(join(lane(r, "alpha"), n), t);
    w("broken.md", "---\nfrom: alpha\n---\n\nno topic id\n");
    const base = renderContribution(make("alpha", "drift"));
    w("drift.md", base.replace("change: create", "change: create\nunknown_field: 1"));
    w("hash.md", renderContribution(make("alpha", "hash", "real body", { contentHash: contentHash("other body") })));
    const good = emit(r, make("alpha", "good"));
    const before = ["broken.md", "drift.md", "hash.md"].map((n) => readFileSync(join(lane(r, "alpha"), n), "utf8"));
    const queued: string[] = [];
    const logs: string[] = [];
    const warned = new Set<string>();
    const target = { contribute: (_w: string, _c: Record<string, unknown>, id: string) => void queued.push(id) };
    expect(feedContributions(r.kbOps, ["alpha"], target, (m) => logs.push(m), warned)).toEqual({ queued: 1, skipped: 3 });
    feedContributions(r.kbOps, ["alpha"], target, (m) => logs.push(m), warned);
    feedContributions(r.kbOps, ["alpha"], target, (m) => logs.push(m), warned);
    expect(logs).toHaveLength(3); // once per path
    expect(logs.find((l) => l.includes("hash.md"))).toMatch(/content_hash does not match/);
    expect(queued).toHaveLength(1);
    expect(readdirSync(lane(r, "alpha")).sort()).toEqual(["broken.md", "drift.md", "hash.md", "sent"]);
    expect(["broken.md", "drift.md", "hash.md"].map((n) => readFileSync(join(lane(r, "alpha"), n), "utf8"))).toEqual(before);
    expect(existsSync(join(lane(r, "alpha"), "_bad"))).toBe(false);
    expect(existsSync(join(lane(r, "alpha"), "sent", good))).toBe(true);
  });

  it("an I/O error is retried on the next scan, not quarantined", async () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    const r = await rig({ noHub: true });
    const name = emit(r, make("alpha", "io"));
    const file = join(lane(r, "alpha"), name);
    chmodSync(file, 0o000);
    const queued: string[] = [];
    const logs: string[] = [];
    const warned = new Set<string>();
    const target = { contribute: (_w: string, _c: Record<string, unknown>, id: string) => void queued.push(id) };
    expect(feedContributions(r.kbOps, ["alpha"], target, (m) => logs.push(m), warned)).toEqual({ queued: 0, skipped: 0 });
    expect(logs.join()).toMatch(/could not be read, will retry/);
    expect(top(r, "alpha")).toEqual([name]);
    expect(existsSync(join(lane(r, "alpha"), "_bad"))).toBe(false);
    chmodSync(file, 0o644);
    expect(feedContributions(r.kbOps, ["alpha"], target, (m) => logs.push(m), warned).queued).toBe(1);
    expect(queued).toHaveLength(1);
  });

  it("a long topic gets the deterministic fallback id and is delivered", async () => {
    const r = await rig();
    const topic = "t".repeat(150); // too long for an idempotency id (and for a path segment? 150 < 255)
    const c = make("alpha", topic);
    expect(feedId("alpha", topic, c.contentHash)).toBe(feedId("alpha", topic, c.contentHash));
    expect(feedId("alpha", topic, c.contentHash)).toMatch(/^alpha\.[0-9a-f]{16}-[0-9a-f]{10}$/);
    expect(feedId("alpha", "short", c.contentHash)).toBe(`alpha.short-${c.contentHash.slice(7, 17)}`);
    const name = emit(r, c);
    await r.waitPresence("online");
    await r.eventually(() => hubInbox(r, "alpha").length === 1 && outboxIds(r).length === 0, "delivered");
    expect(hubInbox(r, "alpha")).toEqual([name]);
    expect(existsSync(join(lane(r, "alpha"), "sent", name))).toBe(true);
  });

  it("a too-large file stays in the lane (typed error), logged once", async () => {
    const r = await rig({ noHub: true });
    const name = emit(r, make("alpha", "big"));
    const logs: string[] = [];
    const warned = new Set<string>();
    const target = { contribute: () => { throw new OutboxError("too_large", "contribution is 9 bytes; the limit is 1"); } };
    feedContributions(r.kbOps, ["alpha"], target, (m) => logs.push(m), warned);
    feedContributions(r.kbOps, ["alpha"], target, (m) => logs.push(m), warned);
    expect(top(r, "alpha")).toEqual([name]);
    expect(logs).toHaveLength(1);
  });

  it("never overwrites an existing file in sent/", async () => {
    const r = await rig({ noHub: true });
    const name = emit(r, make("alpha", "dupname"));
    mkdirSync(join(lane(r, "alpha"), "sent"), { recursive: true });
    writeFileSync(join(lane(r, "alpha"), "sent", name), "older");
    feedContributions(r.kbOps, ["alpha"], { contribute: () => {} }, () => {});
    expect(readFileSync(join(lane(r, "alpha"), "sent", name), "utf8")).toBe("older");
    expect(readdirSync(join(lane(r, "alpha"), "sent")).sort()).toEqual([name, `${name}.1`]);
    expect(top(r, "alpha")).toEqual([]);
  });

  it("the feed is skipped when kbOps/inbox is the hub's inbox (also through a symlink) or WORKERD_FEED=0", async () => {
    const r = await rig({ feed: undefined });
    expect(feedDisabledReason(r.kbOps, {})).toBeUndefined();
    expect(feedDisabledReason(r.kbOps, { WORKERD_FEED: "0" })).toMatch(/WORKERD_FEED/);
    mkdirSync(join(r.kbOps, "inbox"), { recursive: true });
    expect(feedDisabledReason(r.kbOps, {}, join(r.kbOps, "inbox"))).toMatch(/hub's inbox root/);
    expect(feedDisabledReason(r.kbOps, { HUBD_INBOX_ROOT: join(r.kbOps, "inbox") })).toMatch(/hub's inbox root/);
    const link = join(r.kbOps, "..", "inbox-link");
    symlinkSync(join(r.kbOps, "inbox"), link);
    expect(feedDisabledReason(r.kbOps, {}, link)).toMatch(/same lane/);
    expect(feedDisabledReason(r.kbOps, {}, r.inboxRoot)).toBeUndefined();
  });

  it("a running workerd with the feed off, or sharing the hub inbox, leaves files alone", async () => {
    const off = await rig({ feed: false });
    const n1 = emit(off, make("alpha", "off"));
    await off.waitPresence("online");
    await new Promise((res) => setTimeout(res, 300));
    expect(top(off, "alpha")).toEqual([n1]);
    expect(off.logs.join("\n")).toMatch(/contribution feed off: disabled by options/);
    expect(hubInbox(off, "alpha")).toEqual([]);
  });

  it("round trip: parse then render reproduces emitDelta's file for optional fields", () => {
    const cs = [
      make("alpha", "plain"),
      make("alpha", "full", "Line1\n\nLine2", { prevHash: contentHash("old"), host: "h", session: "s1", sourceCreated: "2026-01-01", sourceUpdated: "2026-02-02", dateBasis: "source", dateConfidence: "high", currency: "current", sourcePath: "/a/b", origin: "crawl", anchor: "a-b", verbatim: true, group: "g-1", groupDate: "2026-03-03", target: "kb-abc", source: { feature: "work-f", tasks: ["t1"], recordLines: ["1", "2"], recordLinesScope: "record" } } as Partial<Contribution>),
    ];
    const target = { contribute: (_w: string, c: Record<string, unknown>) => void got.push(c) };
    const got: Array<Record<string, unknown>> = [];
    const r = { kbOps: join(process.env.TMPDIR ?? "/tmp", `feed-rt-${process.pid}-${Date.now()}`) };
    for (const c of cs) {
      mkdirSync(join(r.kbOps, "inbox", "alpha"), { recursive: true });
      writeFileSync(join(r.kbOps, "inbox", "alpha", contributionFileName(c.denTopicId, c.contentHash)), renderContribution(c));
    }
    expect(feedContributions(r.kbOps, ["alpha"], target, () => {})).toEqual({ queued: 2, skipped: 0 });
    for (const c of cs) expect(renderContribution(got.find((g) => g.denTopicId === c.denTopicId)! as unknown as Contribution)).toBe(renderContribution(c));
  });
});
