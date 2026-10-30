/** Registry: one-time seed, domains.yaml regeneration (parsed by the existing readers), create/retire wolf, claim release. */
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { ACTOR_HEADER } from "@wolfpack/protocol";
import { loadWorkState, stageWork } from "@wolfpack/kb/client";
import { createWork } from "@wolfpack/kb/client";
import { readDomainRegistry } from "@wolfpack/kb/shared";
import { createRegistry } from "./registry.js";
import { createHubServer, type HubServer } from "./server.js";
import { domainsYamlFile, hubRoots, registryFile } from "./layout.js";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";

const KEY = "k";
const as = (id: string, kind: "wolf" | "operator") => ({ [ACTOR_HEADER]: JSON.stringify({ id, kind }) });
const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});
const mkdir = () => {
  const d = mkdtempSync(join(tmpdir(), "hubd-registry-"));
  tmp.push(d);
  return d;
};
async function start(dir: string, registrySeed?: Parameters<typeof createHubServer>[0]["registrySeed"]) {
  const hub = await createHubServer({ dataDir: dir, apiKey: KEY, registrySeed });
  servers.push(hub);
  const call = (method: string, path: string, body?: unknown, actor = as("1uk4", "operator")) =>
    fetch(hub.url + path, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...actor }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { hub, call };
}
function fixtures() {
  const src = mkdir();
  const domainsText = stringify({ domains: { personal: { label: "Personal", description: "My life", created: "2026-01-02" }, wolfpack: { label: "Wolfpack", description: "The pack", created: "2026-01-03" } } });
  const domains = join(src, "domains.yaml");
  writeFileSync(domains, domainsText);
  const wolfA = join(src, "a.yaml");
  writeFileSync(wolfA, "name: alpha\ndomains: [personal, wolfpack]\ntools: [coding]\nworkspace: /tmp/x\ntiers:\n  fast: { model: m1 }\nruntime: pi\n");
  const wolfB = join(src, "b.yaml");
  writeFileSync(wolfB, "name: beta\ndomains: [wolfpack]\n");
  writeFileSync(join(src, "devices.yaml"), "devices: [{name: laptop}]\n");
  return { domains, domainsText, wolfs: [wolfA, wolfB] };
}

describe("hub registry", () => {
  it("seeds once from domains.yaml and wolf.yaml files; devices.yaml is ignored; a restart does not re-seed", async () => {
    const f = fixtures();
    const dir = mkdir();
    const { hub, call } = await start(dir, { domainsYaml: f.domains, wolfYamls: f.wolfs });
    const wolves = ((await (await call("GET", "/v1/registry/wolves", undefined, {})).json()) as { wolves: { name: string; domains: string[]; status: string }[] }).wolves;
    expect(wolves.map((w) => w.name)).toEqual(["alpha", "beta"]);
    expect(wolves[0]).toMatchObject({ domains: ["personal", "wolfpack"], status: "active", workspace: "/tmp/x", tiers: { fast: { model: "m1" } } });
    const subs = ((await (await call("GET", "/v1/registry/subscriptions", undefined, {})).json()) as { subscriptions: unknown[] }).subscriptions;
    expect(subs).toHaveLength(3);
    expect(((await (await call("GET", "/v1/registry/hosts", undefined, {})).json()) as { hosts: unknown[] }).hosts).toEqual([]);
    // domains.yaml is byte-identical to the CLI-format source
    expect(readFileSync(domainsYamlFile(dir), "utf8")).toBe(f.domainsText);
    await call("DELETE", "/v1/registry/wolves/beta");
    await hub.close();
    servers.pop();
    const again = await start(dir, { domainsYaml: f.domains, wolfYamls: f.wolfs });
    const names = ((await (await again.call("GET", "/v1/registry/wolves")).json()) as { wolves: { name: string }[] }).wolves.map((w) => w.name);
    expect(names).toEqual(["alpha"]);
  });

  it("without seed sources no registry file exists until the first write", async () => {
    const dir = mkdir();
    const { call } = await start(dir);
    expect(existsSync(registryFile(dir))).toBe(false);
    expect(existsSync(domainsYamlFile(dir))).toBe(false);
    expect((await call("POST", "/v1/registry/domains", { name: "docs", label: "Docs", description: "Docs d" })).status).toBe(201);
    expect(existsSync(registryFile(dir))).toBe(true);
  });

  it("every write regenerates a domains.yaml the existing reader parses", async () => {
    const dir = mkdir();
    const { call } = await start(dir);
    await call("POST", "/v1/registry/domains", { name: "docs", label: "Docs", description: "All the docs", color: "#abc" });
    await call("POST", "/v1/registry/domains", { name: "ops", label: "Ops" });
    let reg = readDomainRegistry(hubRoots(dir).kbBase);
    expect(reg).toMatchObject({ docs: { label: "Docs", description: "All the docs", color: "#abc" }, ops: { label: "Ops" } });
    await call("PATCH", "/v1/registry/domains/ops", { description: "Operations" });
    await call("DELETE", "/v1/registry/domains/docs");
    reg = readDomainRegistry(hubRoots(dir).kbBase);
    expect(Object.keys(reg)).toEqual(["ops"]);
    expect(reg.ops?.description).toBe("Operations");
  });

  it("create wolf writes only the entry; writes by a wolf are 403; reads need no actor", async () => {
    const dir = mkdir();
    const { call } = await start(dir);
    await call("POST", "/v1/registry/domains", { name: "docs" });
    expect((await call("POST", "/v1/registry/wolves", { name: "newbie", domains: ["docs"] }, as("w1", "wolf"))).status).toBe(403);
    expect((await call("POST", "/v1/registry/wolves", { name: "newbie", domains: ["docs"], host: "nohost" })).status).toBe(400);
    expect((await call("POST", "/v1/registry/wolves", { name: "newbie", domains: ["docs"] })).status).toBe(201);
    expect((await call("POST", "/v1/registry/subscriptions", { wolf: "newbie", domain: "docs" })).status).toBe(409);
    expect(existsSync(join(dir, "wolves"))).toBe(false);
    expect(((await (await call("GET", "/v1/registry/wolves/newbie", undefined, {})).json()) as { wolf: { status: string } }).wolf.status).toBe("active");
  });

  it("retire marks the wolf retired and releases every claim it holds (work.unbound), leaving other holders alone", async () => {
    const dir = mkdir();
    seedFixture(dir);
    const roots = hubRoots(dir);
    const mk = () => {
      const id = createWork(roots, { kind: "task", domain: FIXTURE_DOMAIN, title: "t", assignee: "1uk4", successCriteria: "ok" } as never).id as string;
      stageWork(roots, id, "approved");
      return id;
    };
    const [a, b, c] = [mk(), mk(), mk()];
    const { call } = await start(dir);
    await call("POST", "/v1/registry/wolves", { name: "w1" });
    for (const [id, w] of [[a, "w1"], [b, "w1"], [c, "w2"]] as const) expect((await call("POST", `/v1/work/${id}/claim`, undefined, as(w, "wolf"))).status).toBe(200);
    const res = await call("POST", "/v1/registry/wolves/w1/retire");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wolf: { status: string }; released: string[] };
    expect(body.wolf.status).toBe("retired");
    expect(body.released.sort()).toEqual([a, b].sort());
    const state = loadWorkState(roots);
    expect(state.get(a as never)!.boundBy).toBeFalsy();
    expect(state.get(b as never)!.boundBy).toBeFalsy();
    expect(state.get(c as never)!.boundBy).toBe("w2");
    const ledger = readFileSync(join(dir, "ledger", "work-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(ledger.filter((e) => e.type === "work.unbound" && e.wolf === "w1")).toHaveLength(2);
    // a retired wolf's entry stays; a second retire is a no-op
    expect(((await (await call("POST", "/v1/registry/wolves/w1/retire")).json()) as { released: string[] }).released).toEqual([]);
    expect((await call("POST", "/v1/registry/wolves/ghost/retire")).status).toBe(404);
  });

  it("an invalid seed file fails startup with a clear error", async () => {
    const dir = mkdir();
    const bad = join(mkdir(), "w.yaml");
    writeFileSync(bad, "domains: [x]\n");
    await expect(createHubServer({ dataDir: dir, apiKey: KEY, registrySeed: { wolfYamls: [bad] } })).rejects.toThrow(/seed wolf.yaml invalid/);
    // the failed start released the writer lock
    const { hub } = await start(dir);
    expect(hub.url).toBeTruthy();
  });

  it("restart regenerates a deleted or corrupted domains.yaml from registry.json", async () => {
    const dir = mkdir();
    const a = await start(dir);
    await a.call("POST", "/v1/registry/domains", { name: "docs", label: "Docs", description: "d" });
    const good = readFileSync(domainsYamlFile(dir), "utf8");
    await a.hub.close();
    servers.pop();
    rmSync(domainsYamlFile(dir));
    const b = await start(dir);
    expect(readFileSync(domainsYamlFile(dir), "utf8")).toBe(good);
    await b.hub.close();
    servers.pop();
    writeFileSync(domainsYamlFile(dir), "garbage: [");
    await start(dir);
    expect(readFileSync(domainsYamlFile(dir), "utf8")).toBe(good);
  });

  it("a corrupt registry.json fails startup with an error naming the file, and releases the lock", async () => {
    const dir = mkdir();
    mkdirSync(join(dir, "registry"), { recursive: true });
    writeFileSync(registryFile(dir), "{not json");
    await expect(createHubServer({ dataDir: dir, apiKey: KEY })).rejects.toThrow(/registry\.json is not valid JSON/);
    rmSync(registryFile(dir));
    await start(dir);
  });

  it("memory follows disk when the domains.yaml regeneration fails; the next write or restart repairs it", async () => {
    const dir = mkdir();
    const logs: string[] = [];
    let fail = false;
    const real = (f: string, t: string) => {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, t);
    };
    const reg = createRegistry({ dataDir: dir, releaseClaims: async () => [], log: (m) => logs.push(m), writeDomainsYaml: (f, t) => (fail ? (() => { throw new Error("disk full"); })() : real(f, t)) });
    fail = true;
    await reg.create("domains", { name: "docs", label: "Docs" }); // resolves: registry.json committed
    expect(reg.list("domains")).toHaveLength(1);
    expect(JSON.parse(readFileSync(registryFile(dir), "utf8")).domains).toHaveLength(1);
    expect(logs.some((l) => /regeneration failed.*disk full/.test(l))).toBe(true);
    expect(existsSync(domainsYamlFile(dir))).toBe(false);
    fail = false;
    await reg.create("domains", { name: "ops" });
    expect(Object.keys(readDomainRegistry(hubRoots(dir).kbBase))).toEqual(["docs", "ops"]);
  });

  it("a failed registry.json write leaves memory unchanged", async () => {
    const dir = mkdir();
    const reg = createRegistry({ dataDir: dir, releaseClaims: async () => [], log: () => {} });
    await reg.create("domains", { name: "docs" });
    // a directory squatting on the tmp path makes the next persist fail
    mkdirSync(registryFile(dir) + ".tmp");
    await expect(reg.create("domains", { name: "ops" })).rejects.toThrow();
    expect(reg.list("domains")).toHaveLength(1);
  });

  it("reserved and malformed domain names are refused on create and in the seed", async () => {
    const dir = mkdir();
    const { call } = await start(dir);
    for (const n of ["_unclassified", "entries", "registry", "domains", "A", "-ab"]) {
      expect((await call("POST", "/v1/registry/domains", { name: n })).status).toBe(400);
    }
    const src = mkdir();
    const f = join(src, "domains.yaml");
    writeFileSync(f, stringify({ domains: { registry: { label: "R" } } }));
    await expect(createHubServer({ dataDir: mkdir(), apiKey: KEY, registrySeed: { domainsYaml: f } })).rejects.toThrow(/reserved name/);
  });

  it("a seeded wolf subscribing to an unseeded domain fails startup naming wolf and domain, and releases the lock", async () => {
    const src = mkdir();
    const d = join(src, "domains.yaml");
    writeFileSync(d, stringify({ domains: { personal: { label: "P" } } }));
    const w = join(src, "w.yaml");
    writeFileSync(w, "name: gamma\ndomains: [personal, ghosts]\n");
    const dir = mkdir();
    await expect(createHubServer({ dataDir: dir, apiKey: KEY, registrySeed: { domainsYaml: d, wolfYamls: [w] } })).rejects.toThrow(/"gamma".*"ghosts"/);
    await start(dir);
  });

  it("create wolf rejects a status field; delete wolf is 409 while it holds claims", async () => {
    const dir = mkdir();
    seedFixture(dir);
    const roots = hubRoots(dir);
    const id = createWork(roots, { kind: "task", domain: FIXTURE_DOMAIN, title: "t", assignee: "1uk4", successCriteria: "ok" } as never).id as string;
    stageWork(roots, id, "approved");
    const { call } = await start(dir);
    expect((await call("POST", "/v1/registry/wolves", { name: "w1", status: "retired" })).status).toBe(400);
    expect((await call("POST", "/v1/registry/wolves", { name: "w1" })).status).toBe(201);
    await call("POST", `/v1/work/${id}/claim`, undefined, as("w1", "wolf"));
    const del = await call("DELETE", "/v1/registry/wolves/w1");
    expect(del.status).toBe(409);
    expect(((await del.json()) as { message: string }).message).toMatch(/retire it first/);
    await call("POST", "/v1/registry/wolves/w1/retire");
    expect((await call("DELETE", "/v1/registry/wolves/w1")).status).toBe(200);
  });

  it("a retired wolf's claim is 403 forbidden; an unregistered wolf can still claim", async () => {
    const dir = mkdir();
    seedFixture(dir);
    const roots = hubRoots(dir);
    const mk = () => {
      const id = createWork(roots, { kind: "task", domain: FIXTURE_DOMAIN, title: "t", assignee: "1uk4", successCriteria: "ok" } as never).id as string;
      stageWork(roots, id, "approved");
      return id;
    };
    const [a, b] = [mk(), mk()];
    const { call } = await start(dir);
    await call("POST", "/v1/registry/wolves", { name: "wolf-a" });
    await call("POST", "/v1/registry/wolves/wolf-a/retire");
    const res = await call("POST", `/v1/work/${a}/claim`, undefined, as("wolf-a", "wolf"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("forbidden");
    expect(loadWorkState(roots).get(a as never)!.boundBy).toBeFalsy();
    expect((await call("POST", `/v1/work/${b}/claim`, undefined, as("unregistered", "wolf"))).status).toBe(200);
  });

  it("a release failure on retire says the wolf is retired but claims remain, and a retry works", async () => {
    const dir = mkdir();
    let fail = true;
    const reg = createRegistry({ dataDir: dir, log: () => {}, releaseClaims: async () => { if (fail) throw new Error("boom"); return ["x"]; } });
    await reg.create("wolves", { name: "w1" });
    await expect(reg.retire("w1")).rejects.toThrow(/retired but its claims were not all released.*retrying retire is safe/);
    expect(reg.isRetired("w1")).toBe(true);
    fail = false;
    expect((await reg.retire("w1")).released).toEqual(["x"]);
  });
});
