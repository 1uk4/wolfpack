import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTOR_HEADER } from "@wolfpack/protocol";
import { createHubServer, type HubServer } from "./server.js";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";

const KEY = "k";
const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});
async function start(eventBufferSize?: number) {
  const d = mkdtempSync(join(tmpdir(), "hubd-events-"));
  tmp.push(d);
  seedFixture(d);
  const h = await createHubServer({ dataDir: d, apiKey: KEY, eventBufferSize });
  servers.push(h);
  return h;
}
const create = (h: HubServer) =>
  fetch(h.url + "/v1/work", {
    method: "POST",
    headers: { "X-API-Key": KEY, "Content-Type": "application/json", [ACTOR_HEADER]: JSON.stringify({ id: "1uk4", kind: "operator" }) },
    body: JSON.stringify({ kind: "task", domain: FIXTURE_DOMAIN, title: "t", assignee: "1uk4" }),
  }).then((r) => r.json() as Promise<{ id: string }>);

async function frames(h: HubServer, headers: Record<string, string>, n: number, bootOnly?: false): Promise<{ id?: string; data: any }[]>;
async function frames(h: HubServer, headers: Record<string, string>, n: number, bootOnly: true): Promise<{ boot: string }>;
async function frames(h: HubServer, headers: Record<string, string>, n: number, bootOnly = false): Promise<any> {
  const ctl = new AbortController();
  const res = await fetch(h.url + "/v1/events", { headers: { "X-API-Key": KEY, ...headers }, signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: { id?: string; data: any }[] = [];
  if (bootOnly) {
    // A cursor from no hub boot is stale: the resync frame's id carries this hub's boot.
    ctl.abort();
    const c2 = await frames(h, { "Last-Event-ID": "zz:1" }, 1);
    return { boot: c2[0].id!.split(":")[0] };
  }
  while (out.length < n) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const d = /^data: (.*)$/m.exec(chunk);
      if (d) out.push({ id: /^id: (.*)$/m.exec(chunk)?.[1], data: JSON.parse(d[1]) });
    }
  }
  ctl.abort();
  return out;
}

describe("hubd /v1/events", () => {
  it("requires the API key", async () => {
    const h = await start();
    expect((await fetch(h.url + "/v1/events")).status).toBe(401);
  });

  it("emits kb.changed through emitKbChanged", async () => {
    const h = await start();
    const p = frames(h, {}, 1);
    await new Promise((r) => setTimeout(r, 100));
    h.emitKbChanged(["a", "b"]);
    const [f] = await p;
    expect(f.data).toMatchObject({ type: "kb.changed", entryIds: ["a", "b"] });
  });

  it("one work.changed per ledger event, in order, with consecutive ids", async () => {
    const h = await start();
    const p = frames(h, {}, 1);
    await new Promise((r) => setTimeout(r, 100));
    const { id } = await create(h);
    const [f] = await p;
    expect(f.data).toMatchObject({ type: "work.changed", itemId: id, id: 1 });
  });

  it("resumes within the buffer and answers resync beyond it", async () => {
    const h = await start(2);
    const boot = async () => (await frames(h, {}, 0, true)).boot;
    const bootId = await boot();
    for (let i = 0; i < 3; i++) await create(h); // >= 3 ledger events; the buffer keeps the last 2
    const total = (await frames(h, { "Last-Event-ID": `${bootId}:0` }, 1))[0];
    expect(total.data.type).toBe("resync"); // seq 0 is older than the 2-event buffer
    const hi = Number(total.id?.split(":")[1] ?? total.data.id);
    const replay = await frames(h, { "Last-Event-ID": `${bootId}:${hi - 1}` }, 1);
    expect(replay[0].data).toMatchObject({ type: "work.changed", id: hi });
  });
});
