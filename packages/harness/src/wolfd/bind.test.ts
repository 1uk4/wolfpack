/** POST /v1/threads/:id/bind: a feature thread rebinds to a task of its feature, never to one held elsewhere or on a closed thread. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBindingFile } from "@wolfpack/memory";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";

const ITEMS: Record<string, Record<string, unknown>> = {
  "work-wolfpack-feat0001": { id: "work-wolfpack-feat0001", kind: "feature", title: "Feat", stage: "in_build", domain: "wolfpack" },
  "work-wolfpack-task0001": { id: "work-wolfpack-task0001", kind: "task", title: "T1", stage: "plan", domain: "wolfpack", partOf: "work-wolfpack-feat0001" },
  "work-wolfpack-task0002": { id: "work-wolfpack-task0002", kind: "task", title: "T2", stage: "plan", domain: "wolfpack", partOf: "work-wolfpack-feat0001" },
  "work-wolfpack-stray001": { id: "work-wolfpack-stray001", kind: "task", title: "Stray", stage: "plan", domain: "wolfpack", partOf: "work-wolfpack-feat0009" },
  "work-wolfpack-feat0003": { id: "work-wolfpack-feat0003", kind: "feature", title: "Old", stage: "archived", domain: "wolfpack" },
  "work-wolfpack-task0003": { id: "work-wolfpack-task0003", kind: "task", title: "T3", stage: "plan", domain: "wolfpack", partOf: "work-wolfpack-feat0003" },
};

let workApi: Server | undefined;
let den: string | undefined;
let server: WolfServer | undefined;
afterEach(async () => {
  await server?.close();
  await new Promise<void>((r) => (workApi ? workApi.close(() => r()) : r()));
  if (den) rmSync(den, { recursive: true, force: true });
  workApi = den = server = undefined;
});

async function boot(): Promise<{ url: string; den: string }> {
  workApi = createServer((req, res) => {
    const item = ITEMS[decodeURIComponent((req.url ?? "").replace(/^\/work\//, ""))];
    if (!item) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ item, body: "" }));
  });
  await new Promise<void>((r) => workApi!.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(workApi.address() as AddressInfo).port}`;
  den = mkdtempSync(join(tmpdir(), "wolfd-bind-"));
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
  return { url: await server.listen(), den };
}
const feature = (url: string, workItemId: string) => fetch(`${url}/v1/wolves/w/threads`, { method: "POST", body: JSON.stringify({ kind: "feature", workItemId }) }).then((r) => r.json());
const bind = (url: string, threadId: string, workItemId: string) => fetch(`${url}/v1/threads/${encodeURIComponent(threadId)}/bind`, { method: "POST", body: JSON.stringify({ workItemId }) });

describe("bindThread", () => {
  it("binds the conversation to a task of the feature (feature id kept, boundItem reported) and back to the feature", async () => {
    const { url, den } = await boot();
    const t = await feature(url, "work-wolfpack-feat0001");
    const r = await bind(url, t.id, "work-wolfpack-task0001");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ threadId: t.id, workItemId: "work-wolfpack-task0001", previousWorkItemId: "work-wolfpack-feat0001" });
    expect(readBindingFile(den, 101)).toMatchObject({ workId: "work-wolfpack-task0001", domain: "wolfpack", featureId: "work-wolfpack-feat0001" });
    const detail = await (await fetch(`${url}/v1/threads/${encodeURIComponent(t.id)}`)).json();
    expect(detail).toMatchObject({ boundWorkItem: "work-wolfpack-feat0001", boundItem: "work-wolfpack-task0001" });
    // a second task: the previous task is reported; the feature itself clears boundItem
    expect(await (await bind(url, t.id, "work-wolfpack-task0002")).json()).toMatchObject({ previousWorkItemId: "work-wolfpack-task0001" });
    expect((await bind(url, t.id, "work-wolfpack-feat0001")).status).toBe(200);
    expect((await (await fetch(`${url}/v1/threads/${encodeURIComponent(t.id)}`)).json()).boundItem).toBeUndefined();
  });

  it("refuses an item another conversation holds, with a message naming it", async () => {
    const { url } = await boot();
    const a = await feature(url, "work-wolfpack-feat0001");
    expect((await bind(url, a.id, "work-wolfpack-task0001")).status).toBe(200);
    const home = await bind(url, "w/home", "work-wolfpack-task0001");
    expect(home.status).toBe(400);
    const body = await home.json();
    expect(body.code).toBe("invalid_request");
    expect(body.message).toMatch(/already bound in conversation 101; release it there first/);
  });

  it("refuses another feature's task, a workspace, an unknown item and a malformed id", async () => {
    const { url } = await boot();
    const t = await feature(url, "work-wolfpack-feat0001");
    expect((await (await bind(url, t.id, "work-wolfpack-stray001")).json()).message).toMatch(/not a task of this thread's feature/);
    expect((await bind(url, "w/home", "work-wolfpack-feat0001")).status).toBe(400); // a feature is a workspace
    expect((await bind(url, t.id, "work-wolfpack-nope0001")).status).toBe(404);
    expect((await bind(url, t.id, "../x")).status).toBe(400);
  });

  it("refuses on a closed (graduated) thread", async () => {
    const { url, den } = await boot();
    const t = await feature(url, "work-wolfpack-feat0003");
    const r = await bind(url, t.id, "work-wolfpack-task0003");
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("thread_closed");
    expect(readBindingFile(den, 101)?.workId).not.toBe("work-wolfpack-task0003");
  });
});
