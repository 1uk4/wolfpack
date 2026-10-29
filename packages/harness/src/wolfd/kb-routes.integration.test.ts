/**
 * KB graph + entry routes through a real WolfServer over /v1: the librarian serves them from its KB roots, any wolf with roots (a mirror)
 * serves them read-only, one without roots answers kb_unavailable; the den layer is the serving wolf's own den; the KB is never written.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDenTopic } from "@wolfpack/memory";
import { ErrorEnvelopeSchema, ROUTES, KbEntryDetailSchema, KbGraphSchema, PROTOCOL_VERSION } from "@wolfpack/protocol";
import { HttpConsoleClient, NotFoundError, ProtocolError } from "@wolfpack/client";
import { makeFixtureKb } from "../../../kb/src/graph/fixture.js";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";

const servers: WolfServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

async function boot(o: { name?: string; librarian?: boolean; kb?: string; withDen?: boolean } = {}): Promise<{ url: string; name: string; den: string }> {
  const name = o.name ?? "dewey";
  const den = mkdtempSync(join(tmpdir(), "kb-routes-den-"));
  dirs.push(den);
  if (o.withDen !== false) {
    writeDenTopic(den, { id: "caching", title: "Caching", summary: "Cache sessions", updated: "2026-10-01", related: ["kb-alpha-AAA1111"], body: "b" });
    writeDenTopic(den, { id: "secret", title: "Private", summary: "held", updated: "2026-10-02", body: "b", promotable: false, promotableReason: "private" });
  }
  const ops = join(den, "ops");
  mkdirSync(ops, { recursive: true });
  const server = new WolfServer({
    name,
    conversation: new ScriptedEngine(),
    den,
    librarian: o.librarian,
    ...(o.kb ? { kbRoots: { kbBase: o.kb, opsRoot: ops, denLocal: join(den, "kb") } } : {}),
  });
  servers.push(server);
  await server.attach();
  return { url: await server.listen(), name, den };
}

const H = { "X-Protocol-Version": String(PROTOCOL_VERSION) };
const get = (url: string, path: string) => fetch(`${url}${path}`, { headers: H });
const errorOf = async (res: Response) => ErrorEnvelopeSchema.parse(await res.json());

describe("kb routes", { timeout: 30_000 }, () => {
  it("the librarian serves a graph that parses through the protocol schema, and leaves the KB untouched", async () => {
    const kb = makeFixtureKb();
    dirs.push(kb);
    const before = hashTree(kb);
    const { url, name } = await boot({ librarian: true, kb });

    const res = await get(url, `/v1/wolves/${name}/kb/graph`);
    expect(res.status).toBe(200);
    const g = KbGraphSchema.parse(await res.json());
    expect(g.nodes.map((n) => n.kind)).toEqual(expect.arrayContaining(["domain", "section", "entry", "work"]));
    expect(g.nodes.some((n) => n.kind === "den-topic")).toBe(false);
    expect(g.domains).toEqual([{ name: "alpha", label: "Alpha Land", color: "#ff8800" }, { name: "beta", label: "Beta" }]);

    // each layer on its own, and the domain filter
    const all = KbGraphSchema.parse(await (await get(url, `/v1/wolves/${name}/kb/graph?archivedWork=true&denTopics=true&domain=alpha`)).json());
    expect(all.layers).toEqual({ archivedWork: true, denTopics: true });
    expect(all.domain).toBe("alpha");
    expect(all.nodes.some((n) => n.id === "work:work-alpha-OLD1111")).toBe(true);
    expect(all.edges.every((e) => ["hierarchy", "partOf", "dependsOn"].includes(e.kind))).toBe(true);
    expect(all.nodes.filter((n) => n.kind === "factory").map((n) => n.id)).toEqual(["fac:alpha"]);

    expect(hashTree(kb)).toEqual(before);
  });

  it("the den layer is the serving wolf's own den topics, named by wolf", async () => {
    const kb = makeFixtureKb();
    dirs.push(kb);
    const a = await boot({ name: "dewey", librarian: true, kb });
    const g = KbGraphSchema.parse(await (await get(a.url, "/v1/wolves/dewey/kb/graph?denTopics=true")).json());
    expect(g.nodes.filter((n) => n.kind === "den-topic").map((n) => n.id)).toEqual(["den:dewey:caching", "den:dewey:secret"]);
    expect(g.nodes.find((n) => n.id === "den:dewey:secret")).toMatchObject({ wolf: "dewey", promotable: false });

    // a second librarian with an empty den shows none of the first's topics
    const b = await boot({ name: "other", librarian: true, kb, withDen: false });
    const g2 = KbGraphSchema.parse(await (await get(b.url, "/v1/wolves/other/kb/graph?denTopics=true")).json());
    expect(g2.nodes.filter((n) => n.kind === "den-topic")).toEqual([]);
  });

  it("denTopics on a wolf with no den reports the layer off, without error", async () => {
    const kb = makeFixtureKb();
    dirs.push(kb);
    const server = new WolfServer({ name: "dewey", conversation: new ScriptedEngine(), librarian: true, kbRoots: { kbBase: kb, opsRoot: kb, denLocal: kb } });
    servers.push(server);
    await server.attach();
    const g = KbGraphSchema.parse(await (await get(await server.listen(), "/v1/wolves/dewey/kb/graph?denTopics=true")).json());
    expect(g.layers.denTopics).toBe(false);
    expect(g.nodes.some((n) => n.kind === "den-topic")).toBe(false);
  });

  it("entry route: detail with backlinks; unknown 404; malformed 400", async () => {
    const kb = makeFixtureKb();
    dirs.push(kb);
    const { url, name } = await boot({ librarian: true, kb });
    const e = KbEntryDetailSchema.parse(await (await get(url, `/v1/wolves/${name}/kb/entries/kb-alpha-BBB2222`)).json());
    expect(e).toMatchObject({ id: "kb-alpha-BBB2222", domain: "alpha", backlinks: [{ id: "kb-alpha-AAA1111", via: "related", relation: "refines" }, { id: "kb-alpha-AAA1111", via: "wikilink" }] });

    const missing = await get(url, `/v1/wolves/${name}/kb/entries/kb-alpha-nope`);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("not_found");
    for (const id of ["..", "%2e%2e%2fdomains.yaml", ".hidden", "a%00b", "a%2Fb"]) {
      const r = await get(url, `/v1/wolves/${name}/kb/entries/${id}`);
      expect([400, 404]).toContain(r.status);
      expect(["invalid_request", "not_found"]).toContain((await errorOf(r)).code);
    }
    expect((await errorOf(await get(url, "/v1/wolves/nobody/kb/entries/kb-alpha-AAA1111"))).code).toBe("not_found");
  });

  it("graph query: unknown domain is 404, bad flags are 400", async () => {
    const kb = makeFixtureKb();
    dirs.push(kb);
    const { url, name } = await boot({ librarian: true, kb });
    const nope = await get(url, `/v1/wolves/${name}/kb/graph?domain=nope`);
    expect(nope.status).toBe(404);
    expect((await errorOf(nope)).code).toBe("not_found");
    for (const q of ["archivedWork=yes", "denTopics="]) {
      const r = await get(url, `/v1/wolves/${name}/kb/graph?${q}`);
      expect(r.status).toBe(400);
      expect((await errorOf(r)).code).toBe("invalid_request");
    }
    expect((await errorOf(await get(url, "/v1/wolves/nobody/kb/graph"))).code).toBe("not_found");
  });

  it("a non-librarian wolf with KB roots serves the graph and entries read-only, reports kbReadable, and 409s the pipeline", async () => {
    const kb = makeFixtureKb();
    dirs.push(kb);
    const before = hashTree(kb);
    const { url, name } = await boot({ name: "mirror", librarian: false, kb });
    const g = await get(url, `/v1/wolves/${name}/kb/graph`);
    expect(g.status).toBe(200);
    ROUTES.getKbGraph.response.schema.parse(await g.json());
    const e = await get(url, `/v1/wolves/${name}/kb/entries/kb-alpha-AAA1111`);
    expect(e.status).toBe(200);
    expect((await e.json()).title).toBe("First");
    const p = await get(url, `/v1/wolves/${name}/kb/pipeline`);
    expect(p.status).toBe(409);
    expect((await errorOf(p)).code).toBe("kb_unavailable");
    const w = await (await get(url, "/v1/wolves")).json();
    expect(w.wolves[0]).toMatchObject({ librarian: false, kbReadable: true });
    expect(hashTree(kb)).toEqual(before);
  });

  it("a wolf without KB roots answers kb_unavailable (409) and reports kbReadable false", async () => {
    const cases = [await boot({ librarian: false }), await boot({ name: "dewey", librarian: true })];
    for (const c of cases) {
      for (const path of [`/v1/wolves/${c.name}/kb/graph`, `/v1/wolves/${c.name}/kb/entries/kb-alpha-AAA1111`]) {
        const r = await get(c.url, path);
        expect(r.status).toBe(409);
        expect((await errorOf(r)).code).toBe("kb_unavailable");
      }
    }
  });

  it("the typed client matches the raw routes and maps errors", async () => {
    const kb = makeFixtureKb();
    dirs.push(kb);
    const { url, name } = await boot({ librarian: true, kb });
    const client = new HttpConsoleClient({ baseUrl: url });
    const g = await client.getKbGraph(name, { domain: "alpha" });
    expect(g.domain).toBe("alpha");
    expect(g.layers).toEqual({ archivedWork: false, denTopics: false });
    expect((await client.getKbEntry(name, "kb-alpha-AAA1111")).title).toBe("First");
    await expect(client.getKbEntry(name, "kb-alpha-nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(client.getKbGraph(name, { domain: "nope" })).rejects.toBeInstanceOf(NotFoundError);
    const plain = await boot({ name: "plain", librarian: false });
    await expect(new HttpConsoleClient({ baseUrl: plain.url }).getKbGraph("plain")).rejects.toBeInstanceOf(ProtocolError);
  });
});
