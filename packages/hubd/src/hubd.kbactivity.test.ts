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
    appendLedger(roots, [d("w1", "a", "create", "kb-1"), ev.entryWritten("kb-1", "kb-1", "create"), d("w2", "b", "reject")]);
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
    const custom = await setup({ inboxRoot: join(tmpdir(), "elsewhere-lane") });
    expect((await parse(await custom.get("/v1/kb/activity"))).source.lane).toBe("custom");

    const on = await setup({ curator: { enabled: true, pollMs: 0 } });
    const body = await parse(await on.get("/v1/kb/activity"));
    expect(body.source.curator).toBe("on");
    expect(body.sweep).toEqual({ running: false });
  });
});
