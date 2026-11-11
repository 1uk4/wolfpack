/** Pack inventory: link reports, console heartbeats, GET /v1/inventory (work-wolfpack-ZproKxi). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { LINK_PROTOCOL_VERSION, parseLinkFrame, type LinkFrame } from "@wolfpack/protocol";
import { createHubServer, type HubServer } from "./server.js";
import { mintOperatorToken, mintWorkerToken, bearer, seedTokens } from "./testing/tokens.js";

let dir = "";
let hub: HubServer;
let clock = 1_000_000;
const open: WebSocket[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hubd-inv-"));
  clock = 1_000_000;
  process.env.WOLFPACK_MACHINE = "Hub-Box";
  seedTokens(dir);
  hub = await createHubServer({ dataDir: dir, port: 0, authPollMs: 30, now: () => clock, linkTimers: { heartbeatMs: 100, deadAfterMs: 5000, helloTimeoutMs: 400, asleepOfflineMs: 600 } });
});
afterEach(async () => {
  delete process.env.WOLFPACK_MACHINE;
  for (const w of open.splice(0)) w.terminate();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => unknown | Promise<unknown>, what: string) {
  const end = Date.now() + 4000;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(15);
  }
}
async function worker(hostId: string, machine: string | undefined, hello: Record<string, unknown> = {}) {
  const ws = new WebSocket(hub.url.replace("http", "ws") + "/v1/link", { headers: bearer(mintWorkerToken(dir, hostId)) });
  open.push(ws);
  const frames: LinkFrame[] = [];
  ws.on("message", (d) => {
    const p = parseLinkFrame(d.toString());
    if (p.ok) frames.push(p.frame);
  });
  await new Promise<void>((res, rej) => (ws.once("open", () => res()), ws.once("error", rej)));
  ws.send(JSON.stringify({ t: "hello", v: LINK_PROTOCOL_VERSION, hostId, laptop: false, wolves: [], kbRevisions: {}, ...(machine ? { machine } : {}), ...hello }));
  await until(() => frames.find((f) => f.t === "welcome"), "welcome");
  return { ws, frames, report: (entries: unknown[]) => ws.send(JSON.stringify({ t: "report", entries })) };
}
const operator = () => ({ ...bearer(mintOperatorToken(dir)), "Content-Type": "application/json" });
const list = async (headers: Record<string, string> = operator()) => (await (await fetch(hub.url + "/v1/inventory", { headers })).json()) as { entries: any[]; hubMachine: string };
const post = (headers: Record<string, string>, entry: unknown, raw?: string) => fetch(hub.url + "/v1/inventory/report", { method: "POST", headers, body: raw ?? JSON.stringify({ entry }) });
const consoleEntry = (over: Record<string, unknown> = {}) => ({ machine: "mac", kind: "console", id: "console", version: "0.1.19", channel: "main", ...over });

describe("hubd inventory", () => {
  it("the welcome advertises inventory; a worker's report is listed under the host's hello machine; disconnect clears it", async () => {
    const w = await worker("sfo-01-wolves", "SFO-01");
    expect(w.frames.find((f) => f.t === "welcome")).toMatchObject({ inventory: true });
    w.report([
      { machine: "liar", kind: "workerd", id: "sfo-01-wolves", version: "0.1.5", channel: "main" },
      { machine: "liar", kind: "wolfd", id: "hal", parent: "sfo-01-wolves", version: "0.1.15", responseMs: 3 },
      { machine: "liar", kind: "hubd", id: "evil", version: "9.9.9" },
    ]);
    await until(async () => (await list()).entries.some((e) => e.kind === "wolfd"), "report listed");
    const { entries, hubMachine } = await list();
    expect(hubMachine).toBe("hub-box");
    expect(entries.filter((e) => e.id !== "hubd" || e.machine !== "hub-box").map((e) => [e.machine, e.kind, e.id, e.version])).toEqual([
      ["sfo-01", "workerd", "sfo-01-wolves", "0.1.5"],
      ["sfo-01", "wolfd", "hal", "0.1.15"],
    ]);
    expect(entries.find((e) => e.kind === "hubd")).toMatchObject({ machine: "hub-box", id: "hubd" });
    w.ws.close();
    await until(async () => !(await list()).entries.some((e) => e.kind === "workerd"), "cleared on disconnect");
  });

  it("reports expire after the workerd TTL and console heartbeats after the console TTL (injected clock)", async () => {
    const w = await worker("box", "box");
    w.report([{ machine: "box", kind: "workerd", id: "box", version: "1.0.0" }]);
    expect((await post(operator(), consoleEntry())).status).toBe(200);
    await until(async () => (await list()).entries.some((e) => e.kind === "workerd"), "listed");
    clock += 46_000;
    let kinds = (await list()).entries.map((e) => e.kind);
    expect(kinds).toContain("workerd");
    expect(kinds).not.toContain("console");
    clock += 45_000;
    kinds = (await list()).entries.map((e) => e.kind);
    expect(kinds).not.toContain("workerd");
    expect(kinds).toContain("hubd");
  });

  it("needs a token; /healthz carries no versions; a worker that never reports is unaffected", async () => {
    expect((await fetch(hub.url + "/v1/inventory")).status).toBe(401);
    expect((await post({ "Content-Type": "application/json" }, consoleEntry())).status).toBe(401);
    await worker("quiet", "quiet");
    const hz = await (await fetch(hub.url + "/healthz")).text();
    expect(hz).not.toContain("inventory");
    expect(Object.keys(JSON.parse(hz)).filter((k) => k === "entries")).toEqual([]);
    expect((await list()).entries.map((e) => e.kind)).toEqual(["hubd"]);
  });

  it("a console heartbeat is bound to its token: another token cannot overwrite it; non-console kinds and bad bodies are refused", async () => {
    const a = operator();
    expect((await post(a, consoleEntry({ version: "0.1.19" }))).status).toBe(200);
    expect((await post(a, consoleEntry({ version: "0.1.20" }))).status).toBe(200);
    expect((await post(operator(), consoleEntry({ version: "6.6.6" }))).status).toBe(403);
    expect((await list()).entries.find((e) => e.kind === "console")).toMatchObject({ version: "0.1.20", machine: "mac" });
    expect((await post(a, consoleEntry({ kind: "workerd" }))).status).toBe(400);
    expect((await post(a, undefined, "{nope")).status).toBe(400);
    expect((await post(a, consoleEntry({ version: "x".repeat(5000) }))).status).toBe(400);
  });

  it("an oversized but otherwise valid heartbeat body is refused and not stored", async () => {
    const r = await post(operator(), undefined, JSON.stringify({ entry: consoleEntry() }) + " ".repeat(5000));
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("too large");
    expect((await list()).entries.map((e) => e.kind)).toEqual(["hubd"]);
  });

  it("a console heartbeat with an invalid machine is a 400, not a 403", async () => {
    expect((await post(operator(), consoleEntry({ machine: "Not A Machine!" }))).status).toBe(400);
    expect((await list()).entries.map((e) => e.kind)).toEqual(["hubd"]);
  });

  it("a worker token cannot read the inventory", async () => {
    expect((await fetch(hub.url + "/v1/inventory", { headers: bearer(mintWorkerToken(dir, "w1")) })).status).toBe(403);
  });

  it("a host whose hello had no machine contributes nothing, even if its entries name a machine", async () => {
    const w = await worker("old-box", undefined);
    w.report([{ machine: "liar", kind: "workerd", id: "old-box", version: "0.1.0" }]);
    await sleep(150);
    expect((await list()).entries.map((e) => e.kind)).toEqual(["hubd"]);
  });

  it("a replaced link's close does not wipe the newer link's entries", async () => {
    const first = await worker("box", "box");
    const second = await worker("box", "box");
    second.report([{ machine: "box", kind: "workerd", id: "box", version: "1.0.0" }]);
    await until(async () => (await list()).entries.some((e) => e.kind === "workerd"), "listed");
    first.ws.terminate();
    await sleep(200);
    expect((await list()).entries.map((e) => e.kind)).toContain("workerd");
  });
});
