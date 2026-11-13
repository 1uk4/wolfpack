/** Machine keys at the hub: fingerprint from hello.pubkey, key-change flag, and sealed keys never stored. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { LINK_PROTOCOL_VERSION, keyFingerprint, parseLinkFrame, type LinkFrame } from "@wolfpack/protocol";
import { createTokenStore } from "./auth.js";
import { createHubServer, type HubServer } from "./server.js";
import { seedTokens } from "./testing/tokens.js";

let dir = "";
let hub: HubServer;
let store: ReturnType<typeof createTokenStore>;
const open: WebSocket[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PK1 = "A".repeat(43);
const PK2 = "B".repeat(43);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hubd-mk-"));
  seedTokens(dir);
  hub = await createHubServer({ dataDir: dir, port: 0, authPollMs: 30, commandTimeoutMs: 300 });
  store = createTokenStore(dir);
});
afterEach(async () => {
  for (const w of open.splice(0)) w.terminate();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

function mint(kind: "worker" | "console", hostId?: string) {
  const { code } = store.mintPairingCode({ kind, ...(hostId ? { hostId } : {}) });
  return store.redeem(code, "t", kind, hostId);
}
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
  const end = Date.now() + 4000;
  while (!frames.some((f) => f.t === "welcome")) {
    if (Date.now() > end) throw new Error("no welcome");
    await sleep(15);
  }
  return { ws, frames };
}
const keys = async (token: string) => (await (await fetch(`${hub.url}/v1/machines/keys`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { keys: Record<string, { pubkey: string; fingerprint: string; changed: boolean }> };

describe("machine keys", () => {
  it("records the fingerprint of a hello pubkey; the same key again is not a change", async () => {
    const c = mint("console");
    const m = await machine("box", { pubkey: PK1 });
    expect((await keys(c.token)).keys.box).toEqual({ pubkey: PK1, fingerprint: await keyFingerprint(PK1), changed: false });
    m.ws.close();
    await sleep(50);
    await machine("box", { pubkey: PK1 });
    expect((await keys(c.token)).keys.box!.changed).toBe(false);
  });

  it("raises the key-change flag when a known machine presents another key, until acknowledged", async () => {
    const c = mint("console");
    const m = await machine("box", { pubkey: PK1 });
    m.ws.close();
    await sleep(50);
    await machine("box", { pubkey: PK2 });
    expect((await keys(c.token)).keys.box).toMatchObject({ pubkey: PK2, fingerprint: await keyFingerprint(PK2), changed: true });
    const post = (fingerprint: string) => fetch(`${hub.url}/v1/machines/box/key/ack`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ fingerprint }) });
    // The ack names the fingerprint being accepted: one that is not the current key's is refused and the flag stays.
    expect((await post(await keyFingerprint(PK1))).status).toBe(409);
    expect((await keys(c.token)).keys.box!.changed).toBe(true);
    const ack = await post(await keyFingerprint(PK2));
    expect(ack.status).toBe(200);
    expect((await keys(c.token)).keys.box!.changed).toBe(false);
  });

  it("never stores a sealed key: nothing under the data dir contains it", async () => {
    const c = mint("console");
    const m = await machine("box", { pubkey: PK1, commands: ["key.set"] });
    const pending = fetch(`${hub.url}/v1/machines/box/commands`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "key.set", args: { slot: "anthropic" }, sealed: "SEALED-NEEDLE-123" }) });
    const end = Date.now() + 4000;
    while (!m.frames.some((f) => f.t === "cmd")) {
      if (Date.now() > end) throw new Error("no cmd");
      await sleep(15);
    }
    const id = (m.frames.find((f) => f.t === "cmd") as { id: string }).id;
    m.ws.send(JSON.stringify({ t: "cmd.result", id, ok: true }));
    await pending;
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    for (const f of walk(dir)) expect(readFileSync(f).includes("SEALED-NEEDLE-123"), f).toBe(false);
  });
});
