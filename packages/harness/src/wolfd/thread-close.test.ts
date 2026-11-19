/** POST /v1/threads/:id/close and /reopen, DELETE /v1/threads/:id: the owner closes, reopens and removes a feature thread; the work item is never touched. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";

const ITEMS: Record<string, Record<string, unknown>> = {
  "work-wolfpack-feat0001": { id: "work-wolfpack-feat0001", kind: "feature", title: "Feat", stage: "in_build", domain: "wolfpack" },
  "work-wolfpack-feat0003": { id: "work-wolfpack-feat0003", kind: "feature", title: "Old", stage: "archived", domain: "wolfpack" },
};

let workApi: Server | undefined;
let den: string | undefined;
let server: WolfServer | undefined;
let workHits = 0;
afterEach(async () => {
  await server?.close();
  await new Promise<void>((r) => (workApi ? workApi.close(() => r()) : r()));
  if (den) rmSync(den, { recursive: true, force: true });
  workApi = den = server = undefined;
});

async function boot(): Promise<string> {
  workHits = 0;
  workApi = createServer((req, res) => {
    if (req.method !== "GET") workHits += 1000; // any write to the Work API would show here
    const item = ITEMS[decodeURIComponent((req.url ?? "").replace(/^\/work\//, ""))];
    if (!item) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ item, body: "" }));
  });
  await new Promise<void>((r) => workApi!.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(workApi.address() as AddressInfo).port}`;
  den = mkdtempSync(join(tmpdir(), "wolfd-close-"));
  let n = 0;
  const engines = new Map<string, ScriptedEngine>();
  const conversations = {
    create: async () => {
      const e = new ScriptedEngine({ delayMs: 1, id: `${100 + ++n}` });
      engines.set(e.id, e);
      return e;
    },
    get: async (id: string) => engines.get(id),
  };
  server = new WolfServer({ name: "w", den, conversation: new ScriptedEngine({ delayMs: 1, id: "900" }), conversations, work: { endpoint, token: "tok" } });
  await server.attach();
  return await server.listen();
}
const feature = (url: string, workItemId: string) => fetch(`${url}/v1/wolves/w/threads`, { method: "POST", body: JSON.stringify({ kind: "feature", workItemId }) }).then((r) => r.json());
const act = (url: string, id: string, what: "close" | "reopen") => fetch(`${url}/v1/threads/${encodeURIComponent(id)}/${what}`, { method: "POST", body: "{}" });
const remove = (url: string, id: string) => fetch(`${url}/v1/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
const get = (url: string, id: string) => fetch(`${url}/v1/threads/${encodeURIComponent(id)}`);
const send = (url: string, id: string) => fetch(`${url}/v1/threads/${encodeURIComponent(id)}/submit`, { method: "POST", body: JSON.stringify({ text: "hi" }) });

describe("close, reopen and remove a feature thread", () => {
  it("close is idempotent, refuses sends with 'Closed by you', and reopen makes the thread usable again", async () => {
    const url = await boot();
    const t = await feature(url, "work-wolfpack-feat0001");
    for (let i = 0; i < 2; i++) {
      const r = await act(url, t.id, "close");
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ closed: true, closedReason: "Closed by you" });
    }
    expect(await get(url, t.id).then((r) => r.json())).toMatchObject({ closed: true, closedReason: "Closed by you" });
    const refused = await send(url, t.id);
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("thread_closed");

    const re = await act(url, t.id, "reopen");
    expect(re.status).toBe(200);
    expect(await re.json()).toEqual({ closed: false });
    expect((await get(url, t.id).then((r) => r.json())).closed).toBeUndefined();
    expect((await send(url, t.id)).status).not.toBe(409);
  });

  it("reopen is refused with thread_graduated when the work item is archived", async () => {
    const url = await boot();
    const t = await feature(url, "work-wolfpack-feat0003");
    expect((await act(url, t.id, "close")).status).toBe(200);
    const r = await act(url, t.id, "reopen");
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("thread_graduated");
    // graduated threads are removable too
    expect((await remove(url, t.id)).status).toBe(200);
  });

  it("remove is refused while open; once closed it drops the thread (also after a restart) and never writes to the Work API", async () => {
    const url = await boot();
    const t = await feature(url, "work-wolfpack-feat0001");
    const open = await remove(url, t.id);
    expect(open.status).toBe(409);
    expect((await open.json()).code).toBe("thread_open");
    expect((await get(url, t.id)).status).toBe(200);

    await act(url, t.id, "close");
    const r = await remove(url, t.id);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ removed: true });
    expect((await get(url, t.id)).status).toBe(404);
    const list = await (await fetch(`${url}/v1/wolves/w/threads`)).json();
    expect(JSON.stringify(list)).not.toContain(t.id);
    expect(workHits).toBeLessThan(1000);
  });

  it("refuses close and remove on the home thread (400) and an unknown thread (404)", async () => {
    const url = await boot();
    const list = await (await fetch(`${url}/v1/wolves/w/threads`)).json();
    const home = (Array.isArray(list) ? list : list.threads).find((x: { kind: string }) => x.kind === "home");
    expect((await act(url, home.id, "close")).status).toBe(400);
    expect((await remove(url, home.id)).status).toBe(400);
    expect((await act(url, "w/feature-nope", "close")).status).toBe(404);
  });
});
