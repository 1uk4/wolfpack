/** GET /v1/kb/graph: built from the hub's own KB copy, scoped to the domains the token may read. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHubServer, type HubServer } from "./server.js";
import { createTokenStore } from "./auth.js";
import { OP as OP_HEADERS, seedTokens } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

const entry = (domain: string, id: string) => `---\nid: ${id}\ntitle: "T ${id}"\ndomain: ${domain}\n---\n\n# T\n\nBody.\n`;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hubd-kbgraph-"));
  tmp.push(dir);
  const base = join(dir, "kb", "base");
  writeFileSync((mkdirSync(base, { recursive: true }), join(base, "domains.yaml")), "domains:\n  alpha:\n    label: Alpha\n  beta:\n    label: Beta\n");
  for (const [d, id] of [["alpha", "kb-alpha-aaaaaaa"], ["beta", "kb-beta-bbbbbbb"]] as const) {
    mkdirSync(join(base, "domains", d, "entries"), { recursive: true });
    writeFileSync(join(base, "domains", d, "entries", `${id}.md`), entry(d, id));
  }
  seedTokens(dir);
  const hub = await createHubServer({ dataDir: dir, kbPollMs: 0, kbSettleMs: -1 });
  servers.push(hub);
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    fetch(hub.url + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { dir, hub, call };
}

type G = { nodes: { id: string; kind: string }[]; domains: { name: string }[]; domain: string | null };

describe("hub KB graph", () => {
  it("401 without a token; owner sees all domains; a worker only its subscribed ones; explicit forbidden domain is 403", async () => {
    const { dir, hub, call } = await setup();
    expect((await call("GET", "/v1/kb/graph", {})).status).toBe(401);

    const owner = await call("GET", "/v1/kb/graph", OP_HEADERS);
    expect(owner.status).toBe(200);
    const og = (await owner.json()) as G;
    expect(og.domains.map((d) => d.name)).toEqual(["alpha", "beta"]);
    expect(og.nodes.filter((n) => n.kind === "domain").map((n) => n.id).sort()).toEqual(["dom:alpha", "dom:beta"]);
    expect(og.nodes.some((n) => n.id === "ent:kb-beta-bbbbbbb")).toBe(true);

    for (const d of ["alpha", "beta"]) expect((await call("POST", "/v1/registry/domains", OP_HEADERS, { name: d })).status).toBe(201);
    expect((await call("POST", "/v1/registry/hosts", OP_HEADERS, { name: "h1" })).status).toBe(201);
    expect((await call("POST", "/v1/registry/wolves", OP_HEADERS, { name: "w1", host: "h1", domains: ["alpha"] })).status).toBe(201);
    const store = createTokenStore(dir);
    const r = await call("POST", "/v1/pair", {}, { code: store.mintPairingCode({ kind: "worker", hostId: "h1" }).code, label: "t", kind: "worker", hostId: "h1" });
    const w1 = { Authorization: `Bearer ${((await r.json()) as { token: string }).token}` };

    const wg = (await (await call("GET", "/v1/kb/graph", w1)).json()) as G;
    expect(wg.domains.map((d) => d.name)).toEqual(["alpha"]);
    expect(wg.nodes.some((n) => n.id === "dom:beta" || n.id === "ent:kb-beta-bbbbbbb")).toBe(false);
    expect((await call("GET", "/v1/kb/graph?domain=alpha", w1)).status).toBe(200);
    for (const d of ["beta", "zzz"]) expect((await call("GET", `/v1/kb/graph?domain=${d}`, w1)).status, d).toBe(403);
    expect((await call("GET", "/v1/kb/graph?domain=zzz", OP_HEADERS)).status).toBe(404);
    expect(((await (await call("GET", "/v1/kb/graph?domain=beta", OP_HEADERS)).json()) as G).domain).toBe("beta");
    void hub;
  });

  it("GET /v1/kb/entries/:id: owner reads either domain; a worker gets 404 outside its grant; 401 without a token; traversal rejected", async () => {
    const { dir, call } = await setup();
    expect((await call("GET", "/v1/kb/entries/kb-alpha-aaaaaaa", {})).status).toBe(401);
    for (const [id, dom] of [["kb-alpha-aaaaaaa", "alpha"], ["kb-beta-bbbbbbb", "beta"]]) {
      const r = await call("GET", `/v1/kb/entries/${id}`, OP_HEADERS);
      expect(r.status).toBe(200);
      const e = (await r.json()) as { id: string; domain: string; body: string };
      expect([e.id, e.domain]).toEqual([id, dom]);
    }
    for (const d of ["alpha", "beta"]) expect((await call("POST", "/v1/registry/domains", OP_HEADERS, { name: d })).status).toBe(201);
    expect((await call("POST", "/v1/registry/hosts", OP_HEADERS, { name: "h1" })).status).toBe(201);
    expect((await call("POST", "/v1/registry/wolves", OP_HEADERS, { name: "w1", host: "h1", domains: ["alpha"] })).status).toBe(201);
    const store = createTokenStore(dir);
    const r = await call("POST", "/v1/pair", {}, { code: store.mintPairingCode({ kind: "worker", hostId: "h1" }).code, label: "t", kind: "worker", hostId: "h1" });
    const w1 = { Authorization: `Bearer ${((await r.json()) as { token: string }).token}` };
    expect((await call("GET", "/v1/kb/entries/kb-alpha-aaaaaaa", w1)).status).toBe(200);
    const forbidden = await call("GET", "/v1/kb/entries/kb-beta-bbbbbbb", w1);
    const missing = await call("GET", "/v1/kb/entries/kb-nope-zzzzzzz", w1);
    expect([forbidden.status, missing.status]).toEqual([404, 404]);
    expect(await forbidden.text()).toBe((await missing.text()).replace("kb-nope-zzzzzzz", "kb-beta-bbbbbbb")); // same body: nothing to probe
    for (const bad of ["..%2F..%2Fdomains.yaml", "%2e%2e", ".hidden", "a%2Fb"]) expect([400, 404], bad).toContain((await call("GET", `/v1/kb/entries/${bad}`, OP_HEADERS)).status);
    expect((await call("GET", "/v1/kb/entries/..%2F..%2Fdomains.yaml", OP_HEADERS)).status).not.toBe(200);
  });
});
