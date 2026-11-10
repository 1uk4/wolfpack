import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMemoryActions, unregisterMemoryActions, type MemoryActions } from "../memory/actions.js";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";
import { resetWorkLookupCache } from "./memory-read.js";

const servers: WolfServer[] = [];
let den: string;
let actions: MemoryActions | undefined;
const H = { "X-Protocol-Version": "1" };

beforeEach(() => {
  resetWorkLookupCache();
  den = mkdtempSync(join(tmpdir(), "tree-routes-"));
  mkdirSync(join(den, ".memory", "pool"), { recursive: true });
  const row = { timestamp: "t", recordedAt: "2026-11-09T10:00:00Z", content: "tagged", work: "work-d-TASK", feature: "work-d-FEAT" };
  writeFileSync(join(den, ".memory", "pool", "observations.jsonl"), JSON.stringify(row) + "\n");
  vi.stubGlobal("fetch", ((real) => async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("/work/")) return real(url, init);
    const id = decodeURIComponent(u.split("/work/")[1]!);
    const items: Record<string, object> = {
      "work-d-FEAT": { id: "work-d-FEAT", title: "Feature", kind: "feature", stage: "build" },
      "work-d-TASK": { id: "work-d-TASK", title: "Task", kind: "task", stage: "plan", partOf: "work-d-FEAT" },
    };
    const item = items[id];
    return item ? new Response(JSON.stringify({ item, body: "" }), { status: 200 }) : new Response("{}", { status: 404 });
  })(globalThis.fetch));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const s of servers.splice(0)) await s.close();
  if (actions) unregisterMemoryActions(den, actions);
  actions = undefined;
  rmSync(den, { recursive: true, force: true });
});

async function start(live: boolean): Promise<string> {
  if (live) {
    actions = { isBusy: () => false } as unknown as MemoryActions;
    registerMemoryActions(den, actions);
  }
  const s = new WolfServer({
    name: "w",
    conversation: new ScriptedEngine({ delayMs: 1, id: "900" }),
    den,
    memoryExtension: true,
    memoryConfig: { sandbox: true, consolidation: { threshold: 20000, poolTarget: 10000, trigger: "hybrid" } },
    work: { endpoint: "http://work.test", token: "t" },
  });
  servers.push(s);
  await s.attach();
  return await s.listen();
}
const get = (base: string, path: string) => fetch(`${base}/v1/wolves/w/memory/tree${path}`, { headers: H });

describe("memory tree routes", () => {
  it("answers memory_unavailable (409) while memory is not running", async () => {
    const base = await start(false);
    for (const path of ["", "/den"]) {
      const res = await get(base, path);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("memory_unavailable");
    }
  });

  it("returns the feature tree with its pending counts", async () => {
    const base = await start(true);
    const res = await get(base, "");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { features: Array<{ id: string; tasks: Array<{ id: string; pending: number }> }> };
    expect(body.features.map((f) => f.id)).toEqual(["work-d-FEAT"]);
    expect(body.features[0]!.tasks).toMatchObject([{ id: "work-d-TASK", pending: 1 }]);
  });

  it("returns a node's observations, accepts `den`, and rejects a bad work id or limit with 400", async () => {
    const base = await start(true);
    const node = await get(base, "/work-d-TASK?limit=5");
    expect(node.status).toBe(200);
    expect(JSON.stringify(await node.json())).toContain("tagged");
    expect((await get(base, "/den")).status).toBe(200);
    expect((await get(base, "/bad.id")).status).toBe(400);
    for (const limit of ["0", "-1", "abc"]) expect((await get(base, `/work-d-TASK?limit=${limit}`)).status).toBe(400);
  });
});
