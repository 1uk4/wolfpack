/** task_claim / task_release / task_bind-on-a-feature against a real hubd over HTTP (127.0.0.1, port 0, temp data dir, throwaway tokens). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWork } from "@wolfpack/kb/client";
import { createHubServer, type HubServer } from "../../packages/hubd/src/server.js";
import { hubRoots } from "../../packages/hubd/src/layout.js";
import { FIXTURE_DOMAIN, seedFixture } from "../../packages/hubd/src/testing/fixture.js";
import { OP, seedTokens, workerTokenFor } from "../../packages/hubd/src/testing/tokens.js";
import createTasksExtension, { hubErrorText } from "./unified-tasks.js";

const KEY = workerTokenFor("h-wolf-a"); // wolf-a's worker token: must never show up in error text
type Item = Record<string, any>;
const dirs: string[] = [];
let hub: HubServer;
let featureId: string;
let taskId: string;
let local: Map<string, Item>;
const realFetch = globalThis.fetch;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const LOCAL = "http://127.0.0.1:1";

/** The wolf's local Work API (fake) for /work on LOCAL; everything else (the hub) goes over the real network. */
async function fetchImpl(url: string | URL, init: RequestInit = {}) {
  if (!String(url).startsWith(LOCAL)) return realFetch(url, init);
  const m = new URL(String(url)).pathname.replace(/^\/work\/?/, "");
  if (init.method === "GET" && m === "") return json({ items: [...local.values()] });
  const it = local.get(m);
  if (!it) return json({ error: "not found" }, 404);
  if (init.method === "GET") return json({ item: it, body: it.body });
  if (init.method === "PATCH") return json({ item: it });
  return json({ error: "unsupported" }, 400);
}

function wolf(name: string, hubEnv: Record<string, string>, shared?: string) {
  const den = shared ?? mkdtempSync(join(tmpdir(), `hubclaim-${name}-`));
  if (!shared) dirs.push(den);
  const env = { PATH: process.env.PATH, WORK_ENDPOINT: LOCAL, WORK_TOKEN: "t", PI_SUBAGENT_AGENT: "", ...hubEnv } as NodeJS.ProcessEnv; // minimal base: a WOLFPACK_HUB_TOKEN in the shell must not leak in
  const ext = createTasksExtension({ kbRoots: { kbBase: join(den, "kb"), opsRoot: join(den, "ops"), denLocal: join(den, "kbl") } } as never, { wolfDen: den, wolfName: name, domains: [FIXTURE_DOMAIN], wolfConfig: {}, env } as never);
  const run = async (tool: string, args: Record<string, unknown>, conversationId = 1) => {
    const r = await ext.tools!.find((t) => t.name === tool)!.execute(args as never, { cwd: den, wolfDen: den, wolfName: name, conversationId } as never);
    return { text: (r.content[0] as { text: string }).text, isError: r.isError === true };
  };
  return { run, den };
}

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchImpl);
  const dir = mkdtempSync(join(tmpdir(), "hubclaim-hub-"));
  dirs.push(dir);
  seedFixture(dir);
  const roots = hubRoots(dir);
  const mk = (kind: string, extra: Record<string, unknown> = {}) =>
    createWork(roots, { kind, domain: FIXTURE_DOMAIN, title: `${kind} x`, assignee: "1uk4", successCriteria: "ok", ...extra } as never).id as string;
  featureId = mk("feature", { stage: "approved" });
  taskId = mk("task", { partOf: featureId });
  seedTokens(dir, ["h-wolf-a", "h-wolf-b"]);
  hub = await createHubServer({ dataDir: dir, host: "127.0.0.1", port: 0 });
  // each wolf is registered on its own host, so its host's worker token may act for it
  for (const n of ["wolf-a", "wolf-b"]) {
    const post = (path: string, body: unknown) => realFetch(`${hub.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...OP }, body: JSON.stringify(body) });
    expect((await post("/v1/registry/hosts", { name: `h-${n}` })).status).toBe(201);
    expect((await post("/v1/registry/wolves", { name: n, host: `h-${n}` })).status).toBe(201);
  }
  local = new Map([
    [featureId, { id: featureId, kind: "feature", title: "feature x", stage: "approved", domain: FIXTURE_DOMAIN, log: [], container: true, partOf: null, body: null }],
    [taskId, { id: taskId, kind: "task", title: "task x", stage: "plan", domain: FIXTURE_DOMAIN, log: [], container: false, partOf: featureId, body: null }],
  ]);
});
afterEach(async () => {
  await hub.close();
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("hub claim tools", () => {
  const cfg = (wolfName: string) => ({ WOLFPACK_HUB_URL: hub.url, WOLFPACK_HUB_TOKEN: workerTokenFor(`h-${wolfName}`) });

  it("task_claim, a 409 naming the holder for a second wolf, task_release, then the second wolf can claim", async () => {
    const a = wolf("wolf-a", cfg("wolf-a"));
    const b = wolf("wolf-b", cfg("wolf-b"));
    const c = await a.run("task_claim", { id: featureId });
    expect(c).toMatchObject({ isError: false });
    expect(c.text).toContain(`Claimed ${featureId}`);
    const conflict = await b.run("task_claim", { id: featureId });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toBe(`${featureId} is held by wolf-a`);
    expect((await b.run("task_bind", { id: featureId })).text).toBe(`${featureId} is held by wolf-a`);
    expect((await a.run("task_release", { id: featureId })).isError).toBe(false);
    expect((await b.run("task_claim", { id: featureId })).isError).toBe(false);
    expect(conflict.text).not.toContain(KEY);
  });

  it("task_bind on a feature claims it and binds locally; a task under it binds without a claim", async () => {
    const a = wolf("wolf-a", cfg("wolf-a"));
    const b = wolf("wolf-b", cfg("wolf-b"));
    const bound = await a.run("task_bind", { id: featureId });
    expect(bound.isError).toBe(false);
    expect(bound.text).toContain(`Claimed and bound to: [${featureId}]`);
    expect((await a.run("task_current", {})).text).toContain(featureId);
    // wolf-a holds the feature: a second wolf cannot claim it
    expect((await b.run("task_claim", { id: featureId })).text).toBe(`${featureId} is held by wolf-a`);
    // a task is bound locally, no claim (wolf-b would 409 if it called one, as the feature is held by wolf-a)
    const t = await b.run("task_bind", { id: taskId });
    expect(t.isError).toBe(false);
    expect(t.text).toContain(`Bound to: [${taskId}]`);
  });

  it("passes the hub's 404 through, and a transport failure hides credentials", async () => {
    const a = wolf("wolf-a", cfg("wolf-a"));
    expect((await a.run("task_claim", { id: "work-wolfpack-nope0000" })).isError).toBe(true);
    const down = wolf("wolf-a", { WOLFPACK_HUB_URL: "http://user:secret@127.0.0.1:1", WOLFPACK_HUB_TOKEN: KEY });
    const r = await down.run("task_claim", { id: featureId });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("secret");
    expect(r.text).not.toContain(KEY);
  });

  it("shows the stage from the claim response (approved -> in_build), not the local copy", async () => {
    const a = wolf("wolf-a", cfg("wolf-a"));
    expect((await a.run("task_bind", { id: featureId })).text).toContain("Stage: in_build");
  });

  it("a second conversation of the holder is refused locally and the hub claim stays", async () => {
    const a = wolf("wolf-a", cfg("wolf-a"));
    const b = wolf("wolf-b", cfg("wolf-b"));
    expect((await a.run("task_bind", { id: featureId }, 1)).isError).toBe(false);
    const refused = await a.run("task_bind", { id: featureId }, 2);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(featureId);
    expect(refused.text).not.toContain("still claimed");
    // no release happened: the hub still holds it for wolf-a
    expect((await b.run("task_claim", { id: featureId })).text).toBe(`${featureId} is held by wolf-a`);
  });

  // Intended: with a hub configured, an invalid wolf id blocks a feature bind (and claim/release) rather than falling back to local behaviour.
  it("an invalid wolf id is refused before any request", async () => {
    const bad = wolf("Bad_Wolf", cfg("Bad_Wolf"));
    const r = await bad.run("task_claim", { id: featureId });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not a valid wolf id");
  });
});

describe("without a hub", () => {
  it("task_bind on a feature still fails as before; claim and release say no hub is configured", async () => {
    const w = wolf("wolf-a", { WOLFPACK_HUB_URL: "" });
    const b = await w.run("task_bind", { id: featureId });
    expect(b.isError).toBe(true);
    expect(b.text).toContain("Cannot bind to feature");
    for (const tool of ["task_claim", "task_release"]) {
      const r = await w.run(tool, { id: featureId });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("No hub configured");
    }
  });
});

describe("hubErrorText", () => {
  it("names the holder on conflict and scrubs credentials", () => {
    expect(hubErrorText({ code: "conflict", message: "m", details: { holder: "w1" } }, "work-x", "http://h")).toBe("work-x is held by w1");
    const echoed = hubErrorText({ code: "invalid_request", message: "bad key throwaway-key-1234 at http://h/x?api_key=throwaway-key-1234&a=1" }, "work-x", "http://h", "throwaway-key-1234");
    expect(echoed).not.toContain("throwaway-key-1234");
    expect(echoed).not.toContain("?");
    expect(hubErrorText(new TypeError("fetch failed http://u:p@h/x"), "work-x", "http://u:p@h:1/")).not.toMatch(/u:p/);
  });
});
