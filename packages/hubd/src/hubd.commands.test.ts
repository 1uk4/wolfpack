/** Command channel at the hub: POST /v1/machines/:hostId/commands -> cmd frame -> cmd.result. A fake worker plays the machine. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { LINK_PROTOCOL_VERSION, parseLinkFrame, type LinkFrame } from "@wolfpack/protocol";
import { createTokenStore } from "./auth.js";
import { createHubServer, type HubServer } from "./server.js";
import { seedTokens } from "./testing/tokens.js";

let dir = "";
let hub: HubServer;
let store: ReturnType<typeof createTokenStore>;
const open: WebSocket[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hubd-cmd-"));
  seedTokens(dir);
  hub = await createHubServer({ dataDir: dir, port: 0, authPollMs: 30, commandTimeoutMs: 300 });
  store = createTokenStore(dir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const w of open.splice(0)) w.terminate();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

function mint(kind: "worker" | "console", hostId?: string) {
  const { code } = store.mintPairingCode({ kind, ...(hostId ? { hostId } : {}) });
  return store.redeem(code, "t", kind, hostId);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually(cond: () => unknown, what: string) {
  const end = Date.now() + 4000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(15);
  }
}

/** A fake machine: connects, says hello (with `commands` unless omitted), collects frames. */
async function machine(hostId: string, extra: Record<string, unknown> = {}) {
  const w = mint("worker", hostId);
  const ws = new WebSocket(hub.url.replace("http", "ws") + "/v1/link", { headers: { Authorization: `Bearer ${w.token}` } });
  open.push(ws);
  const frames: LinkFrame[] = [];
  ws.on("message", (d) => {
    const p = parseLinkFrame(d.toString());
    if (p.ok) frames.push(p.frame);
  });
  await new Promise<void>((res, rej) => (ws.once("open", () => res()), ws.once("error", rej)));
  ws.send(JSON.stringify({ t: "hello", v: LINK_PROTOCOL_VERSION, hostId, laptop: false, wolves: [], kbRevisions: {}, ...extra }));
  await eventually(() => frames.some((f) => f.t === "welcome"), "welcome");
  return { ws, frames, cmds: () => frames.filter((f) => f.t === "cmd") as Extract<LinkFrame, { t: "cmd" }>[] };
}
const post = (hostId: string, token: string, body: unknown) =>
  fetch(`${hub.url}/v1/machines/${hostId}/commands`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const LOGS = { kind: "logs.fetch", args: { service: "workerd", lines: 5 } };

describe("hubd command channel", () => {
  it("rejects a revoked device with 401 and a worker token with 403", async () => {
    const c = mint("console");
    const w = mint("worker", "box");
    expect((await post("box", w.token, LOGS)).status).toBe(403);
    store.revoke(c.tokenId);
    expect((await post("box", c.token, LOGS)).status).toBe(401);
  });

  it("answers not_sent_offline at once when the machine has no link", async () => {
    const c = mint("console");
    const r = await post("ghost", c.token, LOGS);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, code: "not_sent_offline" });
  });

  it("answers not_sent_unsupported, sending nothing, when the hello did not advertise the command", async () => {
    const c = mint("console");
    const old = await machine("old-box"); // no commands field
    const r = await post("old-box", c.token, LOGS);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, code: "not_sent_unsupported" });
    const partial = await machine("part-box", { commands: ["wolves.restart"] });
    expect((await post("part-box", c.token, LOGS)).status).toBe(409);
    await sleep(50);
    expect(old.cmds()).toEqual([]);
    expect(partial.cmds()).toEqual([]);
  });

  it("sends the cmd frame to that machine and returns its cmd.result", async () => {
    const c = mint("console");
    const m = await machine("box", { commands: ["logs.fetch"] });
    const other = await machine("other", { commands: ["logs.fetch"] });
    const pending = post("box", c.token, LOGS);
    await eventually(() => m.cmds().length === 1, "cmd frame");
    const cmd = m.cmds()[0]!;
    expect(cmd).toMatchObject({ kind: "logs.fetch", args: { service: "workerd", lines: 5 } });
    expect(cmd.id).toMatch(/^c-/);
    m.ws.send(JSON.stringify({ t: "cmd.result", id: cmd.id, ok: true, data: { lines: ["a"], truncated: false } }));
    const r = await pending;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: cmd.id, ok: true, data: { lines: ["a"], truncated: false } });
    expect(other.cmds()).toEqual([]);
  });

  it("answers timeout (504) when the machine never replies", async () => {
    const c = mint("console");
    await machine("box", { commands: ["logs.fetch"] });
    const r = await post("box", c.token, LOGS);
    expect(r.status).toBe(504);
    expect(await r.json()).toMatchObject({ ok: false, code: "timeout" });
  });

  it("resolves every pending command not_sent_offline when the link drops", async () => {
    const c = mint("console");
    const m = await machine("box", { commands: ["logs.fetch"] });
    const a = post("box", c.token, LOGS);
    const b = post("box", c.token, LOGS);
    await eventually(() => m.cmds().length === 2, "both cmds");
    m.ws.terminate();
    for (const r of await Promise.all([a, b])) {
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ code: "not_sent_offline" });
    }
  });

  it("never logs sealed bytes, and logs only hostId, kind, id, ok and code", async () => {
    const lines: string[] = [];
    for (const k of ["log", "error", "warn", "info"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const c = mint("console");
    const m = await machine("box", { commands: ["key.set"] });
    const pending = post("box", c.token, { kind: "key.set", args: { slot: "anthropic" }, sealed: "SEALEDSECRETBYTES" });
    await eventually(() => m.cmds().length === 1, "cmd frame");
    expect(m.cmds()[0]!.sealed).toBe("SEALEDSECRETBYTES"); // it did pass through
    m.ws.send(JSON.stringify({ t: "cmd.result", id: m.cmds()[0]!.id, ok: false, code: "bad_seal" }));
    await pending;
    expect(lines.join("\n")).not.toContain("SEALEDSECRETBYTES");
    const cmdLine = lines.find((l) => l.includes("key.set"));
    expect(cmdLine).toContain("box");
    expect(cmdLine).toContain("bad_seal");
  });

  it("ignores a result from another host, and a duplicate result; the first right answer wins", async () => {
    const c = mint("console");
    const m = await machine("box", { commands: ["logs.fetch"] });
    const evil = await machine("evil", { commands: ["logs.fetch"] });
    const pending = post("box", c.token, LOGS);
    await eventually(() => m.cmds().length === 1, "cmd frame");
    const id = m.cmds()[0]!.id;
    evil.ws.send(JSON.stringify({ t: "cmd.result", id, ok: true, data: { lines: ["forged"], truncated: false } }));
    await sleep(60);
    m.ws.send(JSON.stringify({ t: "cmd.result", id, ok: true, data: { lines: ["real"], truncated: false } }));
    m.ws.send(JSON.stringify({ t: "cmd.result", id, ok: false, code: "internal" }));
    expect(await (await pending).json()).toEqual({ id, ok: true, data: { lines: ["real"], truncated: false } });
  });

  it("ignores a result that arrives after the timeout, and later commands still work", async () => {
    const c = mint("console");
    const m = await machine("box", { commands: ["logs.fetch"] });
    const first = await post("box", c.token, LOGS);
    expect(first.status).toBe(504);
    m.ws.send(JSON.stringify({ t: "cmd.result", id: m.cmds()[0]!.id, ok: true }));
    const next = post("box", c.token, LOGS);
    await eventually(() => m.cmds().length === 2, "second cmd");
    m.ws.send(JSON.stringify({ t: "cmd.result", id: m.cmds()[1]!.id, ok: true, data: { lines: ["b"], truncated: false } }));
    expect((await next).status).toBe(200);
  });

  it("rewrites a hub-only code sent by a worker to internal", async () => {
    const c = mint("console");
    const m = await machine("box", { commands: ["logs.fetch"] });
    const pending = post("box", c.token, LOGS);
    await eventually(() => m.cmds().length === 1, "cmd frame");
    m.ws.send(JSON.stringify({ t: "cmd.result", id: m.cmds()[0]!.id, ok: false, code: "not_sent_offline", message: "lie" }));
    const r = await pending;
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: false, code: "internal" });
  });

  it("treats a link drop while workerd.restart is pending as success", async () => {
    const c = mint("console");
    const m = await machine("box", { commands: ["workerd.restart"] });
    const pending = post("box", c.token, { kind: "workerd.restart", args: {} });
    await eventually(() => m.cmds().length === 1, "cmd frame");
    m.ws.terminate();
    const r = await pending;
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, message: "restarting; the machine will reconnect" });
  });

  it("refuses a body whose args do not fit the kind with 400", async () => {
    const c = mint("console");
    await machine("box", { commands: ["logs.fetch"] });
    expect((await post("box", c.token, { kind: "logs.fetch", args: { service: "workerd", lines: 99999 } })).status).toBe(400);
  });
});
