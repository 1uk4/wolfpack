/** Owner-only hub routes: key ack, domain writes and approval decisions need an owner device, not any valid console token. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTokenStore } from "./auth.js";
import { createHubServer, type HubServer } from "./server.js";
import { seedTokens } from "./testing/tokens.js";

let dir = "";
let hub: HubServer;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hubd-ogate-"));
  seedTokens(dir, ["hA"]);
  hub = await createHubServer({ dataDir: dir, port: 0, authPollMs: 30 });
});
afterEach(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

function consoleToken(owner: boolean) {
  const s = createTokenStore(dir);
  const r = s.redeem(s.mintPairingCode({ kind: "console" }).code, owner ? "boss" : "guest", "console");
  if (owner) s.setOwner(r.tokenId, true);
  return r;
}
const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(hub.url + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const WRITES: [string, string, unknown][] = [
  ["POST", "/v1/machines/box/key/ack", { fingerprint: "x" }],
  ["POST", "/v1/machines/box/commands", { kind: "wolves.restart" }],
  ["POST", "/v1/registry/domains", { name: "gated" }],
  ["PATCH", "/v1/registry/domains/gated", { description: "d" }],
  ["DELETE", "/v1/registry/domains/gated", undefined],
  ["POST", "/v1/work/requests/nope/approve", undefined],
  ["POST", "/v1/work/requests/nope/reject", undefined],
];

describe("owner-only routes", () => {
  it("a non-owner console token gets 403 'only an owner device can do this' on key ack, domain writes, approve and reject", async () => {
    const guest = consoleToken(false);
    for (const [m, p, b] of WRITES) {
      const r = await call(guest.token, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(await r.json(), `${m} ${p}`).toMatchObject({ code: "forbidden", message: "only an owner device can do this" });
    }
  });

  it("an owner token passes the gate (reaches the route's own answer), and domain listing stays open to any device", async () => {
    const boss = consoleToken(true);
    const guest = consoleToken(false);
    expect((await call(boss.token, "POST", "/v1/registry/domains", { name: "gated" })).status).toBe(201);
    expect((await call(boss.token, "POST", "/v1/machines/box/key/ack", { fingerprint: "x" })).status).toBe(404);
    expect((await call(boss.token, "POST", "/v1/work/requests/nope/approve")).status).toBe(404);
    expect((await call(guest.token, "GET", "/v1/registry/domains")).status).toBe(200);
  });

  it("a worker token is still refused on approve (request_forbidden)", async () => {
    const r = await call("test-worker-token-hA", "POST", "/v1/work/requests/nope/approve");
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code: string }).code).toBe("request_forbidden");
  });
});
