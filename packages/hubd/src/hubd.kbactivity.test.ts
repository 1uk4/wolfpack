/** GET /v1/kb/activity: answered from the hub's own ledger and lane, never relayed; no worker access. */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KbActivityResponseSchema } from "@wolfpack/protocol";
import { appendLedger } from "@wolfpack/kb/librarian";
import { ev, ledgerFile } from "@wolfpack/kb/shared";
import { createHubServer, type HubServer, type HubOptions } from "./server.js";
import { hubRoots } from "./layout.js";
import { createKbActivity, safeError } from "./kb-activity.js";
import { bearer, mintOperatorToken, mintWorkerToken, OP, seedTokens } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

async function setup(opts: Partial<HubOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hubd-kbactivity-"));
  tmp.push(dir);
  seedTokens(dir, ["h1"]);
  const hub = await createHubServer({ dataDir: dir, kbPollMs: 0, kbSettleMs: -1, ...opts });
  servers.push(hub);
  const get = (path: string, headers: Record<string, string> = OP) => fetch(hub.url + path, { headers });
  return { dir, hub, get, roots: hubRoots(dir) };
}
const parse = async (r: Response) => KbActivityResponseSchema.parse(await r.json());

describe("GET /v1/kb/activity", () => {
  it("401 without a token; operator and console 200; worker 403", async () => {
    const { dir, get } = await setup();
    expect((await get("/v1/kb/activity", {})).status).toBe(401);
    expect((await get("/v1/kb/activity")).status).toBe(200);
    expect((await get("/v1/kb/activity", bearer(mintOperatorToken(dir)))).status).toBe(200);
    const w = await get("/v1/kb/activity", bearer(mintWorkerToken(dir, "h1")));
    expect(w.status).toBe(403);
    expect(((await w.json()) as { code: string }).code).toBe("forbidden");
  });

  it("an empty hub answers the empty shape (no relay: no wolf needed)", async () => {
    const { get } = await setup();
    const body = await parse(await get("/v1/kb/activity"));
    expect(body.source).toEqual({ lane: "hub", hasDecisions: false, curator: "off" });
    expect(body.incoming).toEqual({ total: 0, wolves: [] });
    expect(body.decisions).toMatchObject({ items: [], total: 0 });
    expect(body.changes.domains).toEqual([]);
    expect(body.sweep).toBeUndefined();
  });

  it("reads the ledger and the lane; a torn line is skipped; params are validated", async () => {
    const { dir, get, roots } = await setup();
    const d = (from: string, topic: string, outcome: "create" | "reject", entryId?: string) => ev.decision({ from, denTopicId: topic, hash: `h-${topic}`, outcome, ...(entryId ? { entryId } : {}), ...(outcome === "reject" ? { reason: "token=abcdefghijklmnop why" } : {}) });
    mkdirSync(join(roots.kbBase, "domains", "alpha", "entries"), { recursive: true });
    writeFileSync(join(roots.kbBase, "domains", "alpha", "entries", "kb-1.md"), '---\nid: kb-1\ntitle: "One"\n---\nx\n');
    appendLedger(roots, [ev.entryWritten("kb-1", "kb-1", "create"), d("w1", "a", "create", "kb-1"), d("w2", "b", "reject")]);
    appendFileSync(ledgerFile(roots), '{"t":"decision","id":"torn');
    mkdirSync(join(roots.opsRoot, "contributions", "w1"), { recursive: true });
    writeFileSync(join(roots.opsRoot, "contributions", "w1", "topic-0123456789.md"), "x");

    const body = await parse(await get("/v1/kb/activity?since=all"));
    expect(body.source.hasDecisions).toBe(true);
    expect(body.decisions.total).toBe(2);
    expect(body.decisions.counts).toMatchObject({ create: 1, reject: 1 });
    expect(body.decisions.items.find((i) => i.outcome === "reject")?.reason).toContain("[REDACTED]");
    expect(body.changes.domains).toEqual([{ domain: "alpha", items: [expect.objectContaining({ entryId: "kb-1", title: "One", from: "w1", denTopicId: "a" })] }]);
    expect(body.incoming).toMatchObject({ total: 1, wolves: [{ wolf: "w1", pending: 1, items: [{ denTopicId: "topic", hash: "0123456789" }] }] });

    const paged = await parse(await get("/v1/kb/activity?since=all&limit=1"));
    expect(paged.decisions.items).toHaveLength(1);
    const next = await parse(await get(`/v1/kb/activity?since=all&limit=1&before=${encodeURIComponent(paged.decisions.nextCursor!)}`));
    expect(next.decisions.items[0].id).not.toBe(paged.decisions.items[0].id);
    expect((await parse(await get("/v1/kb/activity?since=2020-01-01T00:00:00Z&domain=alpha"))).decisions.total).toBe(1);

    for (const q of ["since=yesterday", "limit=0", "limit=abc", "before=nocursor", "domain=../x"]) {
      const r = await get(`/v1/kb/activity?${q}`);
      expect(r.status, q).toBe(400);
      expect(((await r.json()) as { code: string }).code).toBe("invalid_request");
    }
    expect((await parse(await get("/v1/kb/activity?limit=9999"))).decisions.items.length).toBeLessThanOrEqual(200);
    void dir;
  });

  it("picks up an appended event (cache refresh) and serves repeats from the cache", async () => {
    const { get, roots } = await setup();
    appendLedger(roots, [ev.decision({ from: "w1", denTopicId: "a", hash: "h1", outcome: "create" })]);
    expect((await parse(await get("/v1/kb/activity?since=all"))).decisions.total).toBe(1);
    expect((await parse(await get("/v1/kb/activity?since=all"))).decisions.total).toBe(1);
    appendLedger(roots, [ev.decision({ from: "w1", denTopicId: "b", hash: "h2", outcome: "merge" })]);
    expect((await parse(await get("/v1/kb/activity?since=all"))).decisions.total).toBe(2);
  });

  it("source reflects a custom inbox root and the curator state", async () => {
    const lane = mkdtempSync(join(tmpdir(), "dewey-inbox-"));
    tmp.push(lane);
    mkdirSync(join(lane, "w9", "_processed"), { recursive: true });
    writeFileSync(join(lane, "w9", "topic-x-0123456789.md"), "x");
    const custom = await setup({ inboxRoot: lane });
    const cb = await parse(await custom.get("/v1/kb/activity"));
    expect(cb.source.lane).toBe("custom");
    expect(cb.incoming).toMatchObject({ total: 1, wolves: [{ wolf: "w9", pending: 1, items: [{ denTopicId: "topic-x", hash: "0123456789" }] }] });

    const on = await setup({ curator: { enabled: true, pollMs: 0 } });
    const body = await parse(await on.get("/v1/kb/activity"));
    expect(body.source.curator).toBe("on");
    expect(body.sweep).toEqual({ running: false });
  });

  it("a title edit with no ledger append shows at once; a moved entry's domain after the TTL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-kbactivity-ttl-"));
    tmp.push(dir);
    const roots = hubRoots(dir);
    const entry = (domain: string, title: string) => {
      mkdirSync(join(roots.kbBase, "domains", domain, "entries"), { recursive: true });
      writeFileSync(join(roots.kbBase, "domains", domain, "entries", "kb-1.md"), `---\nid: kb-1\ntitle: "${title}"\n---\nx\n`);
    };
    entry("alpha", "Before");
    appendLedger(roots, [ev.entryWritten("kb-1", "kb-1", "create")]);
    let t = Date.parse("2026-11-05T00:00:00Z");
    const act = createKbActivity({ roots, inboxRoot: join(roots.opsRoot, "contributions"), receiptsRoot: join(roots.opsRoot, "receipts"), now: () => t });
    const first = act.read({}).changes.domains;
    expect(first).toMatchObject([{ domain: "alpha", items: [{ title: "Before" }] }]);
    entry("alpha", "After");
    t += 1_000;
    expect(act.read({}).changes.domains[0].items[0].title).toBe("After"); // no ledger append, inside the TTL
    rmSync(join(roots.kbBase, "domains", "alpha"), { recursive: true });
    entry("beta", "After");
    t += 1_000;
    expect(act.read({}).changes.domains[0].domain).toBe("alpha"); // listing cached inside the TTL
    t += 5_000;
    expect(act.read({}).changes.domains[0].domain).toBe("beta"); // rescanned after the TTL
  });

  it("safeError drops absolute host paths, secrets and extra lines", () => {
    const out = safeError("ENOENT: no such file or directory, open '/home/wolf/data/kb/base/domains/x/entries/kb-1.md'\nat stack /srv/app/x.js");
    expect(out).not.toContain("/home");
    expect(out).not.toContain("stack");
    expect(out).toContain("kb-1.md");
    expect(safeError("failed at /var/lib/hubd/secret-dir/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toContain("<path>");
  });

  it("generatedAt follows the injected clock", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-kbactivity-now-"));
    tmp.push(dir);
    const roots = hubRoots(dir);
    const act = createKbActivity({ roots, inboxRoot: join(roots.opsRoot, "contributions"), receiptsRoot: join(roots.opsRoot, "receipts"), now: () => Date.parse("2026-02-03T04:05:06Z") });
    expect(act.read({}).generatedAt).toBe("2026-02-03T04:05:06.000Z");
  });
});
