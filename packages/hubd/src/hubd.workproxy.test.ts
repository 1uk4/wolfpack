/** The hub-proxied Work API (work-proxy.ts): shapes of the agent's /work routes, whitelist, and worker-token scoping. */
import { appendFileSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { workLedgerFile } from "@wolfpack/kb/shared";
import { createHubServer as createRaw, type HubServer } from "./server.js";
import { hubRoots } from "./layout.js";
import { applyOps } from "./work-writes.js";
import { OP, OP_TOKEN, seedTokens, workerTokenFor } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

async function rig() {
  const dataDir = mkdtempSync(join(tmpdir(), "hubd-wproxy-"));
  tmp.push(dataDir);
  seedTokens(dataDir, ["hA", "hB"]);
  const hub = await createRaw({ dataDir });
  servers.push(hub);
  const reg = (p: string, b: unknown, m = "POST") => fetch(hub.url + p, { method: m, headers: { "Content-Type": "application/json", ...OP }, body: JSON.stringify(b) });
  for (const d of ["personal", "other"]) await reg("/v1/registry/domains", { name: d });
  for (const h of ["hA", "hB"]) await reg("/v1/registry/hosts", { name: h });
  await reg("/v1/registry/wolves", { name: "wa", host: "hA", domains: ["personal"] });
  await reg("/v1/registry/wolves", { name: "wb", host: "hB", domains: ["other"] });
  // the proxy speaks X-API-Key (what the Work clients send); a bearer is accepted too
  const call = (key: string, method: string, path: string, body?: unknown, wolf?: string) =>
    fetch(`${hub.url}/v1/workapi/work${path}`, { method, headers: { "X-API-Key": key, ...(wolf ? { "X-Wolf": wolf } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const A = workerTokenFor("hA");
  const B = workerTokenFor("hB");
  return { hub, call, A, B, reg };
}
const feature = { kind: "feature", domain: "personal", title: "Proxy me", assignee: "wa", body: "x" };

describe("hub work proxy", () => {
  it("rejects a missing/invalid key (401) and accepts the worker token as X-API-Key", async () => {
    const { call, hub, A } = await rig();
    expect((await fetch(`${hub.url}/v1/workapi/work`)).status).toBe(401);
    expect((await call("nope", "GET", "")).status).toBe(401);
    const r = await call(A, "GET", "?domain=personal");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ items: [] });
    // the key is NOT accepted on any other prefix
    expect((await fetch(`${hub.url}/v1/work?domain=personal`, { headers: { "X-API-Key": A } })).status).toBe(401);
  });

  it("GET /work?ids= returns only the named items: deduped, unknown skipped, empty = absent, over 200 = 400", async () => {
    const { call, A } = await rig();
    const mk = async (title: string) => ((await (await call(A, "POST", "", { ...feature, title })).json()) as { id: string }).id;
    const [a, b, c] = [await mk("a"), await mk("b"), await mk("c")];
    const ids = async (q: string) => ((await (await call(A, "GET", q)).json()) as { items: { id: string }[] }).items.map((i) => i.id).sort();
    expect(await ids(`?domain=personal&ids=${a},${b},${a},work-personal-Zzzzzzz`)).toEqual([a, b].sort());
    expect(await ids(`?domain=other&ids=${a}`)).toEqual([]); // the other filters still apply
    expect(await ids("?domain=personal&ids=")).toEqual([a, b, c].sort()); // empty ids= is as if absent
    const many = Array.from({ length: 201 }, (_, i) => `work-personal-X${String(i).padStart(6, "0")}`).join(",");
    const r = await call(A, "GET", `?ids=${many}`);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: expect.stringContaining("200") });
  });

  it("GET /work?fields=summary drops log and successCriteria, archived=0 drops archived items, no params is unchanged", async () => {
    const { call, A } = await rig();
    const mk = async (title: string) => ((await (await call(A, "POST", "", { ...feature, title, successCriteria: "done when x" })).json()) as { id: string }).id;
    const [live, old] = [await mk("live"), await mk("old")];
    await call(A, "PATCH", `/${live}`, { note: "hello" });
    await call(A, "PATCH", `/${old}`, { stage: "archived" });
    type Row = Record<string, unknown> & { id: string };
    const list = async (q: string) => ((await (await call(A, "GET", `?domain=personal${q}`)).json()) as { items: Row[] }).items;
    const full = await list("");
    expect(full.map((i) => i.id).sort()).toEqual([live, old].sort());
    const fl = full.find((i) => i.id === live)!;
    expect(fl.log).toBeDefined();
    expect(fl.successCriteria).toBe("done when x");
    const slim = await list("&fields=summary");
    expect(slim.map((i) => i.id).sort()).toEqual([live, old].sort());
    const sl = slim.find((i) => i.id === live)!;
    expect("log" in sl).toBe(false);
    expect("successCriteria" in sl).toBe(false);
    const { log: _l, successCriteria: _s, ...rest } = fl;
    expect(sl).toEqual(rest);
    expect((await list("&archived=0")).map((i) => i.id)).toEqual([live]);
    expect((await list("&archived=0&fields=summary"))[0]).toEqual(rest);
  });

  it("create / get / patch / graduate keep the agent shapes for the wolf's own host", async () => {
    const { call, A } = await rig();
    const c = await call(A, "POST", "", feature);
    expect(c.status).toBe(201);
    const { id, item } = (await c.json()) as { id: string; item: { assignee: string } };
    expect(id).toMatch(/^work-personal-/);
    expect(item.assignee).toBe("wa");
    const g = await call(A, "GET", `/${id}`);
    expect(g.status).toBe(200);
    expect(await g.json()).toMatchObject({ item: { id }, body: expect.anything() });
    const t = await call(A, "POST", "", { kind: "task", domain: "personal", title: "T", assignee: "wa", partOf: id, successCriteria: "ok" });
    const tid = ((await t.json()) as { id: string }).id;
    expect((await call(A, "PATCH", `/${tid}`, { stage: "shipped" })).status).toBe(200);
    expect((await call(A, "PATCH", `/${id}`, { note: "hello" })).status).toBe(200);
    const list = (await (await call(A, "GET", `?partOf=${id}`)).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toEqual([tid]);
    expect((await call(A, "POST", `/${id}/graduate`)).status).toBe(200);
  });

  it("answers 409 parent_closed (create and move) for a graduated parent, with the message", async () => {
    const { call, A } = await rig();
    const id = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    const t = await call(A, "POST", "", { kind: "task", domain: "personal", title: "T", assignee: "wa" }); // parentless: lands in the Inbox
    const tid = ((await t.json()) as { id: string }).id;
    expect((await call(A, "POST", `/${id}/graduate`)).status).toBe(200);
    const c = await call(A, "POST", "", { kind: "task", domain: "personal", title: "late", assignee: "wa", partOf: id });
    expect(c.status).toBe(409);
    expect(await c.json()).toMatchObject({ code: "parent_closed", error: expect.stringContaining(`${id} "`) });
    const mv = await call(A, "PATCH", `/${tid}`, { moveTo: id });
    expect(mv.status).toBe(409);
    expect(((await mv.json()) as { error: string }).error).toContain("has graduated");
  });

  it("a worker token cannot see, change or graduate another host's work, nor create for a foreign wolf/domain", async () => {
    const { call, A, B } = await rig();
    const mine = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    // B (host hB, domain other): the item is absent for reads
    expect((await call(B, "GET", `/${mine}`)).status).toBe(404);
    expect(((await (await call(B, "GET", "")).json()) as { items: unknown[] }).items).toEqual([]);
    // writes: only the assignee gate applies (no domain check); another wolf's item is refused, notes excepted
    expect((await call(B, "PATCH", `/${mine}`, { stage: "approved" })).status).toBe(403);
    expect((await call(B, "POST", `/${mine}/graduate`)).status).toBe(403);
    // create: foreign assignee, foreign domain
    const foreign = await call(A, "POST", "", { ...feature, assignee: "wb" });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { error: string }).error).toContain("only the owner can assign one to another wolf");
    expect((await call(A, "POST", "", { ...feature, domain: "other" })).status).toBe(403);
    // an item in A's domain assigned to a wolf A does not own is read-only to A
    const op = ((await (await call(OP_TOKEN, "POST", "", { ...feature, assignee: "wb" })).json()) as { id: string }).id;
    expect((await call(A, "GET", `/${op}`)).status).toBe(200);
    expect((await call(A, "PATCH", `/${op}`, { stage: "approved" })).status).toBe(403);
    expect((await call(A, "POST", `/${op}/graduate`)).status).toBe(403);
  });

  it("whitelist: no DELETE, no unknown paths; malformed ids and bodies are 400", async () => {
    const { call, A, hub } = await rig();
    const id = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    expect((await call(A, "DELETE", `/${id}`)).status).toBe(400);
    expect((await call(A, "GET", `/${id}/extra/segments`)).status).toBe(404);
    expect((await call(A, "GET", "/not-an-id")).status).toBe(400);
    expect((await call(A, "POST", "", { kind: "feature" })).status).toBe(400);
    expect((await call(A, "PATCH", `/${id}`, { bogus: 1 })).status).toBe(400);
    expect((await fetch(`${hub.url}/v1/workapi/other`, { headers: { Authorization: `Bearer ${A}` } })).status).toBe(404);
    expect((await fetch(`${hub.url}/v1/workapi/other`, { headers: { "X-API-Key": A } })).status).toBe(401); // the key header only works under /work
  });

  it("a write resent with the same Idempotency-Key gets the first answer and is not applied again, also after a restart", async () => {
    const { hub, A } = await rig();
    const keyed = (url: string, key: string, method: string, path: string, body: unknown) =>
      fetch(`${url}/v1/workapi/work${path}`, { method, headers: { "X-API-Key": A, "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const first = await keyed(hub.url, "k-create-1", "POST", "", feature);
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    const again = await keyed(hub.url, "k-create-1", "POST", "", feature);
    expect(again.status).toBe(201);
    expect(((await again.json()) as { id: string }).id).toBe(id);
    expect((await keyed(hub.url, "k-note-1", "PATCH", `/${id}`, { note: "only-once-marker" })).status).toBe(200);

    const dataDir = hub.dataDir;
    await servers.pop()!.close();
    const hub2 = await createRaw({ dataDir });
    servers.push(hub2);
    expect((await keyed(hub2.url, "k-note-1", "PATCH", `/${id}`, { note: "only-once-marker" })).status).toBe(200);
    // a key the hub cannot store is refused, not silently ignored (the write would then not be deduplicated)
    expect((await keyed(hub2.url, "bad key with spaces", "POST", "", feature)).status).toBe(400);
    // a read never uses a key, so a malformed one on a GET is ignored, not refused
    expect((await fetch(`${hub2.url}/v1/workapi/work/${id}`, { headers: { "X-API-Key": A, "Idempotency-Key": "bad key with spaces" } })).status).toBe(200);
    const list = (await (await fetch(`${hub2.url}/v1/workapi/work?domain=personal`, { headers: { "X-API-Key": A } })).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toEqual([id]);
    const got = (await (await fetch(`${hub2.url}/v1/workapi/work/${id}`, { headers: { "X-API-Key": A } })).json()) as { item: { log: { text: string }[] } };
    expect(got.item.log.filter((l) => l.text === "only-once-marker")).toHaveLength(1);
  });

  it("a torn last line of the key store (a crash mid-append) is skipped: earlier keys still dedup and new keys are stored", async () => {
    const { hub, A } = await rig();
    const keyed = (url: string, key: string, body: unknown) =>
      fetch(`${url}/v1/workapi/work`, { method: "POST", headers: { "X-API-Key": A, "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const id = ((await (await keyed(hub.url, "k-a", feature)).json()) as { id: string }).id;
    const dataDir = hub.dataDir;
    await servers.pop()!.close();
    appendFileSync(join(dataDir, "link", "work-idempotency.jsonl"), '{"k":"torn');
    const hub2 = await createRaw({ dataDir });
    servers.push(hub2);
    expect(((await (await keyed(hub2.url, "k-a", feature)).json()) as { id: string }).id).toBe(id);
    const id2 = ((await (await keyed(hub2.url, "k-b", { ...feature, title: "Second" })).json()) as { id: string }).id;
    await servers.pop()!.close();
    const hub3 = await createRaw({ dataDir });
    servers.push(hub3);
    expect(((await (await keyed(hub3.url, "k-b", { ...feature, title: "Second" })).json()) as { id: string }).id).toBe(id2);
    const list = (await (await fetch(`${hub3.url}/v1/workapi/work?domain=personal`, { headers: { "X-API-Key": A } })).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id).sort()).toEqual([id, id2].sort());
  });

  it("a key is remembered for 7 days whatever happens in between, and forgotten after", async () => {
    const { hub, A } = await rig();
    const dataDir = hub.dataDir;
    await servers.pop()!.close();
    let t = Date.parse("2026-11-01T00:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const hubT = await createRaw({ dataDir, now: () => t });
    servers.push(hubT);
    const keyed = (key: string) =>
      fetch(`${hubT.url}/v1/workapi/work`, { method: "POST", headers: { "X-API-Key": A, "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(feature) });
    const id = ((await (await keyed("k-old")).json()) as { id: string }).id;
    t += 6 * day;
    expect(((await (await keyed("k-old")).json()) as { id: string }).id).toBe(id);
    t += 2 * day;
    expect(((await (await keyed("k-old")).json()) as { id: string }).id).not.toBe(id);
  });

  // ── the per-wolf assignee gate: wa and wa2 share host hA; the owner is OP_TOKEN ──
  async function gateRig() {
    const r = await rig();
    await r.reg("/v1/registry/wolves", { name: "wa2", host: "hA", domains: ["personal"] });
    const as = (w: string, method: string, path: string, body?: unknown) => r.call(r.A, method, path, body, w);
    const owner = (method: string, path: string, body?: unknown) => r.call(OP_TOKEN, method, path, body);
    type Out = { id: string; error: string; item: { assignee: string }; reassigned?: { id: string; from: string; to: string }[]; assignedTo?: string };
    const json = async (x: Response) => (await x.json()) as Out;
    const mk = async (b: object) => (await json(await owner("POST", "", { domain: "personal", assignee: "wa", ...b }))).id;
    const who = async (id: string) => (await json(await owner("GET", `/${id}`))).item.assignee;
    return { ...r, as, owner, json, mk, who };
  }

  it("the owner assigns any item", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "loose", body: "x", assignee: "wb" });
    const o = await g.owner("PATCH", `/${id}`, { assignee: "wa" });
    expect(o.status).toBe(200);
    expect((await g.json(o)).item.assignee).toBe("wa");
  });

  it("a wolf hands off its own item and is then refused it", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "x" });
    expect((await g.as("wa", "PATCH", `/${id}`, { assignee: "wa2" })).status).toBe(200);
    const after = await g.as("wa", "PATCH", `/${id}`, { stage: "approved" });
    expect(after.status).toBe(403);
    expect((await g.json(after)).error).toBe("assigned to wa2; only wa2 or the owner can change it");
  });

  it("a wolf is refused another wolf's item on the same host, with the exact message", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "x" });
    const r = await g.as("wa2", "PATCH", `/${id}`, { title: "mine now" });
    expect(r.status).toBe(403);
    expect((await g.json(r)).error).toBe("assigned to wa; only wa or the owner can change it");
  });

  it("graduate by a non-assignee is refused", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "x" });
    expect((await g.as("wa2", "POST", `/${id}/graduate`)).status).toBe(403);
  });

  it("a note on another wolf's item is allowed, but a batch of a note plus another op is refused", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "x" });
    expect((await g.as("wa2", "PATCH", `/${id}`, { note: "fyi" })).status).toBe(200);
    expect((await g.as("wa2", "PATCH", `/${id}`, { ops: [{ note: "fyi" }, { title: "x" }] })).status).toBe(403);
    expect((await g.as("wa2", "PATCH", `/${id}`, { ops: [{ note: "one" }, { note: "two" }] })).status).toBe(200);
  });

  it("any wolf replaces the Record section of another wolf's item; plan, full body and mixed batches stay gated", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "the plan" });
    expect((await g.owner("PATCH", `/${id}`, { section: { name: "Plan", text: "the plan" } })).status).toBe(200);
    const rec = await g.as("wa2", "PATCH", `/${id}`, { section: { name: "Record", text: "### Decisions\n\n- one" } });
    expect(rec.status).toBe(200);
    const body = ((await (await g.as("wa2", "GET", `/${id}`)).json()) as { body: string }).body;
    expect(body).toContain("## Record\n\n### Decisions\n\n- one");
    expect(body).toContain("the plan");
    const refusal = "assigned to wa; only wa or the owner can change it";
    const plan = await g.as("wa2", "PATCH", `/${id}`, { section: { name: "Plan", text: "mine" } });
    expect(plan.status).toBe(403);
    expect((await g.json(plan)).error).toBe(refusal);
    expect((await g.as("wa2", "PATCH", `/${id}`, { body: "all mine" })).status).toBe(403);
    expect((await g.as("wa2", "PATCH", `/${id}`, { ops: [{ section: { name: "Record", text: "x" } }, { section: { name: "Plan", text: "mine" } }] })).status).toBe(403);
    // a ledger op beside a section is refused by the batch rule, never applied
    expect((await g.as("wa2", "PATCH", `/${id}`, { ops: [{ section: { name: "Record", text: "x" } }, { stage: "approved" }] })).status).toBe(400);
  });

  it("only the exact name \"Record\" opens the gate: other spellings and Record text with a Plan or Log heading are refused, the body unchanged", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "the plan" });
    const bodyOf = async () => ((await (await g.as("wa", "GET", `/${id}`)).json()) as { body: string }).body;
    const before = await bodyOf();
    const attempts: Array<[string, { name: string; text: string }, number]> = [
      ["record", { name: "record", text: "x" }, 400],
      ["trailing space", { name: "Record ", text: "x" }, 400],
      ["RECORD", { name: "RECORD", text: "x" }, 400],
      ["## Plan in the text", { name: "Record", text: "x\n\n## Plan\n\nforged" }, 400],
      ["## Log in the text", { name: "Record", text: "x\n\n## Log\n\n- forged" }, 400],
    ];
    for (const [label, section, status] of attempts) {
      const r = await g.as("wa2", "PATCH", `/${id}`, { section });
      expect([label, r.status]).toEqual([label, status]);
      expect(await bodyOf()).toBe(before);
    }
  });

  it("a worker cannot write the Record of an archived item, held or not; the owner can; a note is still accepted", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "x" });
    await g.owner("PATCH", `/${id}`, { stage: "archived" });
    const bodyOf = async () => ((await (await g.owner("GET", `/${id}`)).json()) as { body: string }).body;
    const before = await bodyOf();
    for (const wolf of ["wa", "wa2"]) {
      const r = await g.as(wolf, "PATCH", `/${id}`, { section: { name: "Record", text: "late" } });
      expect(r.status).toBe(409);
      expect(await g.json(r)).toEqual({ error: "item is archived; its Record is closed", code: "record_closed" });
    }
    expect(await bodyOf()).toBe(before);
    expect((await g.owner("PATCH", `/${id}`, { section: { name: "Record", text: "owner" } })).status).toBe(200);
    expect((await g.as("wa2", "PATCH", `/${id}`, { note: "fyi" })).status).toBe(200);
  });

  describe("recordAppend", () => {
    const line = (text: string, ids: string[], extra: object = {}) => ({ at: "2026-11-09T14:05:00.000Z", src: "w1", kind: "decision", text, ids, ...extra });
    async function recRig() {
      const g = await gateRig();
      const id = await g.mk({ kind: "task", title: "T", body: "the plan", successCriteria: "ok" });
      const append = (who: string, lines: object[], hdr: Record<string, string> = {}, extra: object = {}) =>
        fetch(`${g.hub.url}/v1/workapi/work/${id}`, { method: "PATCH", headers: { "X-API-Key": g.A, "X-Wolf": who, "Content-Type": "application/json", ...hdr }, body: JSON.stringify({ op: "recordAppend", lines, ...extra }) });
      const bodyOf = async () => ((await (await g.owner("GET", `/${id}`)).json()) as { body: string }).body;
      return { ...g, id, append, bodyOf };
    }

    it("two concurrent appends both survive in the stored line shape, a non-assignee may append, Plan and Notes stay", async () => {
      const r = await recRig();
      await r.owner("PATCH", `/${r.id}`, { section: { name: "Plan", text: "the plan" } });
      await r.owner("PATCH", `/${r.id}`, { section: { name: "Notes", text: "keep notes" } });
      const [a, b] = await Promise.all([r.append("wa2", [line("first", ["o1"])]), r.append("wa", [line("second", ["o2"], { kind: "finding" })])]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const body = await r.bodyOf();
      expect(body).toContain("- 14:05 [w1·decision] first <!-- src:o1 -->");
      expect(body).toContain("- 14:05 [w1·finding] second <!-- src:o2 -->");
      expect(body).toContain("## Record\n\n- 14:05");
      expect(body).toContain("keep notes");
      expect(body).toContain("the plan");
    });

    it("a same-key replay and a new key with the same ids both add nothing", async () => {
      const r = await recRig();
      const k = { "Idempotency-Key": "k-record-1" };
      expect((await r.append("wa", [line("once", ["o1"])], k)).status).toBe(200);
      expect((await r.append("wa", [line("once", ["o1"])], k)).status).toBe(200);
      expect((await r.append("wa", [line("again", ["o1"])], { "Idempotency-Key": "k-record-2" })).status).toBe(200);
      const body = await r.bodyOf();
      expect(body.match(/<!-- src:o1 -->/g)).toHaveLength(1);
      expect(body).not.toContain("again");
    });

    it("over the cap answers 409 log_full and leaves the body unchanged", async () => {
      const r = await recRig();
      for (let i = 0; i < 20; i++) expect((await r.append("wa", [line("x".repeat(230), [`a${i}`])])).status).toBe(200);
      const before = await r.bodyOf();
      const over = await r.append("wa", Array.from({ length: 20 }, (_, i) => line("y".repeat(230), [`b${i}`])));
      expect(over.status).toBe(409);
      expect(((await over.json()) as { code: string }).code).toBe("log_full");
      expect(await r.bodyOf()).toBe(before);
    });

    it("rejects a heading, a long text and an archived item, the body unchanged", async () => {
      const r = await recRig();
      expect((await r.append("wa", [line("## Plan\n\n## Plan", ["h1"])])).status).toBe(400);
      expect((await r.append("wa", [line("x".repeat(241), ["h2"])])).status).toBe(400);
      await r.owner("PATCH", `/${r.id}`, { stage: "archived" });
      const before = await r.bodyOf();
      const res = await r.append("wa2", [line("late", ["l1"])]);
      expect(res.status).toBe(409);
      expect(await r.bodyOf()).toBe(before);
    });

    it("refuses an owner batch recordAppend on an archived item, the body unchanged", async () => {
      const r = await recRig();
      await r.owner("PATCH", `/${r.id}`, { stage: "archived" });
      const before = await r.bodyOf();
      const res = await r.owner("PATCH", `/${r.id}`, { ops: [{ op: "recordAppend", lines: [line("late", ["ob1"])] }, { op: "recordAppend", lines: [line("later", ["ob2"])] }] });
      expect(res.status).toBe(409);
      expect(await r.json(res)).toEqual({ error: "item is archived; its Record is closed", code: "record_closed" });
      expect(await r.bodyOf()).toBe(before);
    });

    it("rejects whitespace-only text and a line with no ids", async () => {
      const r = await recRig();
      expect((await r.append("wa", [line("   ", ["w1"])])).status).toBe(400);
      expect((await r.append("wa", [line("no ids", [])])).status).toBe(400);
      expect(await r.bodyOf()).not.toContain("no ids");
    });

    it("refuses a non-owner request mixing recordAppend with another op (guard)", async () => {
      const r = await recRig();
      const before = await r.bodyOf();
      const res = await r.as("wa", "PATCH", `/${r.id}`, { ops: [{ op: "recordAppend", lines: [line("mix", ["m1"])] }, { note: "n" }] });
      expect(res.status).toBe(400);
      expect(await r.bodyOf()).toBe(before);
    });

    it("fires no work.changed for a replay that adds nothing", async () => {
      const r = await recRig();
      const ev = await fetch(`${r.hub.url}/v1/events`, { headers: OP });
      const reader = ev.body!.getReader();
      const dec = new TextDecoder();
      let seen = "";
      const count = () => seen.split('"type":"work.changed"').length - 1;
      const until = async (n: number) => {
        const deadline = Date.now() + 3000;
        while (count() < n && Date.now() < deadline) seen += dec.decode((await reader.read()).value);
      };
      await r.append("wa", [line("one", ["n1"])]);
      await until(1);
      expect((await r.append("wa", [line("one", ["n1"])])).status).toBe(200); // replay: adds nothing
      // give a (wrong) replay event time to arrive, then check none did
      const timeout = new Promise<void>((res) => setTimeout(res, 400));
      await Promise.race([until(2), timeout]);
      expect(count()).toBe(1);
      await reader.cancel();
    });

    it("groups under a feature heading, creating it when absent", async () => {
      const g = await gateRig();
      const fid = await g.mk({ kind: "feature", title: "F", body: "x" });
      const send = (text: string, ids: string[], group: string) => g.as("wa2", "PATCH", `/${fid}`, { op: "recordAppend", group, lines: [line(text, ids)] });
      expect((await send("d1", ["g1"], "Decisions")).status).toBe(200);
      expect((await send("c1", ["g2"], "Changes")).status).toBe(200);
      expect((await send("d2", ["g3"], "Decisions")).status).toBe(200);
      const body = ((await (await g.owner("GET", `/${fid}`)).json()) as { body: string }).body;
      expect(body).toContain("### Decisions\n\n- 14:05 [w1·decision] d1 <!-- src:g1 -->\n- 14:05 [w1·decision] d2 <!-- src:g3 -->\n\n### Changes\n\n- 14:05 [w1·decision] c1");
    });

    it("fires work.changed", async () => {
      const r = await recRig();
      const ev = await fetch(`${r.hub.url}/v1/events`, { headers: OP });
      const reader = ev.body!.getReader();
      await r.append("wa", [line("live", ["e1"])]);
      let seen = "";
      const dec = new TextDecoder();
      const deadline = Date.now() + 3000;
      while (!seen.includes(r.id) && Date.now() < deadline) seen += dec.decode((await reader.read()).value);
      await reader.cancel();
      expect(seen).toContain('"type":"work.changed"');
      expect(seen).toContain(r.id);
    });
  });

  it("an unknown assign target is a 400 that names it, for the owner too", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "x" });
    for (const call of [() => g.owner("PATCH", `/${id}`, { assignee: "ghost" }), () => g.as("wa", "PATCH", `/${id}`, { assignee: "ghost" })]) {
      const r = await call();
      expect(r.status).toBe(400);
      expect((await g.json(r)).error).toContain("\"ghost\"");
    }
    expect(await g.who(id)).toBe("wa");
  });

  it("a wolf reassigns a child task it holds, and moves one to the Inbox with the assignee unchanged", async () => {
    const g = await gateRig();
    const feat = await g.mk({ kind: "feature", title: "F", body: "x" });
    const t1 = await g.mk({ kind: "task", title: "t1", partOf: feat, successCriteria: "ok" });
    const t2 = await g.mk({ kind: "task", title: "t2", partOf: feat, successCriteria: "ok" });
    expect((await g.as("wa", "PATCH", `/${t1}`, { assignee: "wa2" })).status).toBe(200);
    expect(await g.who(t1)).toBe("wa2");
    const loose = await g.mk({ kind: "task", title: "loose", successCriteria: "ok" }); // lands in the domain's Inbox
    const inbox = ((await (await g.owner("GET", `/${loose}`)).json()) as { item: { partOf: string } }).item.partOf;
    const mv = await g.as("wa", "PATCH", `/${t2}`, { moveTo: inbox });
    expect(mv.status).toBe(200);
    expect((await g.json(mv)).reassigned).toBeUndefined();
    expect(await g.who(t2)).toBe("wa");
  });

  it("moving a task under another wolf's feature hands it to that wolf and says so", async () => {
    const g = await gateRig();
    const featX = await g.mk({ kind: "feature", title: "X's", body: "x", assignee: "wa2" });
    const t = await g.mk({ kind: "task", title: "t", successCriteria: "ok" });
    const mv = await g.as("wa", "PATCH", `/${t}`, { moveTo: featX });
    expect(mv.status).toBe(200);
    expect((await g.json(mv)).reassigned).toEqual([{ id: t, from: "wa", to: "wa2" }]);
    expect(await g.who(t)).toBe("wa2");
    // the handoff is on the ledger as a work.assigned event for the task
    const events = readFileSync(workLedgerFile(hubRoots(g.hub.dataDir)), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; id: string; assignee?: string });
    expect(events.filter((e) => e.type === "work.assigned" && e.id === t).map((e) => e.assignee)).toEqual(["wa2"]);
  });

  it("an owner feature assign cascades to all open children, skipping shipped and archived", async () => {
    const g = await gateRig();
    const feat = await g.mk({ kind: "feature", title: "F", body: "x" });
    const task = (title: string, assignee = "wa") => g.mk({ kind: "task", title, partOf: feat, successCriteria: "ok", assignee });
    const mine = await task("mine");
    const theirs = await task("theirs", "wa2");
    const done = await task("done");
    const arch = await task("arch");
    await g.owner("PATCH", `/${done}`, { stage: "shipped" });
    await g.owner("PATCH", `/${arch}`, { stage: "archived" });
    expect((await g.owner("PATCH", `/${feat}`, { assignee: "wb" })).status).toBe(200);
    expect([await g.who(feat), await g.who(mine), await g.who(theirs), await g.who(done), await g.who(arch)]).toEqual(["wb", "wb", "wb", "wa", "wa"]);
  });

  it("a worker feature assign cascades only to the children it holds, leaving others alone", async () => {
    const g = await gateRig();
    const feat = await g.mk({ kind: "feature", title: "F", body: "x" });
    const mine = await g.mk({ kind: "task", title: "mine", partOf: feat, successCriteria: "ok" });
    const theirs = await g.mk({ kind: "task", title: "theirs", partOf: feat, successCriteria: "ok", assignee: "wa2" });
    expect((await g.as("wa", "PATCH", `/${feat}`, { assignee: "wb" })).status).toBe(200);
    expect([await g.who(feat), await g.who(mine), await g.who(theirs)]).toEqual(["wb", "wb", "wa2"]);
  });

  it("a feature assign whose cascade fails changes nothing", async () => {
    const g = await gateRig();
    const feat = await g.mk({ kind: "feature", title: "F", body: "x" });
    const kids = [await g.mk({ kind: "task", title: "a", partOf: feat, successCriteria: "ok" }), await g.mk({ kind: "task", title: "b", partOf: feat, successCriteria: "ok" })];
    const scratch = mkdtempSync(join(tmpdir(), "hubd-wproxy-stage-"));
    tmp.push(scratch);
    // fails after the feature and the children were assigned in the scratch copy, before anything reaches the real ledger
    expect(() => applyOps(hubRoots(g.hub.dataDir), feat, [{ op: "assign", to: "wb" }], { afterStaged: () => { throw new Error("boom"); }, tmpRoot: scratch })).toThrow("boom");
    expect([await g.who(feat), await g.who(kids[0]!), await g.who(kids[1]!)]).toEqual(["wa", "wa", "wa"]);
  });

  it("creating under another wolf's feature inherits that wolf; creating loose for another wolf is refused", async () => {
    const g = await gateRig();
    const featX = await g.mk({ kind: "feature", title: "X's", body: "x", assignee: "wa2" });
    const made = await g.json(await g.as("wa", "POST", "", { kind: "task", domain: "personal", title: "N", assignee: "wa", partOf: featX, successCriteria: "ok" }));
    expect(made.item.assignee).toBe("wa2");
    expect(made.assignedTo).toBe("wa2");
    expect((await g.as("wa", "POST", "", { kind: "feature", domain: "personal", title: "L", assignee: "wa2", body: "x" })).status).toBe(403);
  });

  it("creating under a feature held by an unknown wolf is refused", async () => {
    const g = await gateRig();
    const featG = await g.mk({ kind: "feature", title: "Ghost's", body: "x", assignee: "ghost" });
    const r = await g.as("wa", "POST", "", { kind: "task", domain: "personal", title: "N", assignee: "wa", partOf: featG, successCriteria: "ok" });
    expect(r.status).toBe(400);
    expect((await g.json(r)).error).toContain("\"ghost\"");
  });

  it("an operator token is unrestricted over the whitelist", async () => {
    const { call, A } = await rig();
    const id = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    expect((await call(OP_TOKEN, "GET", `/${id}`)).status).toBe(200);
    expect((await call(OP_TOKEN, "GET", "")).status).toBe(200);
  });

  it("a read sees a note written through the proxy, and a ledger replaced by tmp+rename (same size and mtime, new inode)", async () => {
    const { call, A, hub } = await rig();
    const id = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    expect(JSON.stringify(await (await call(A, "GET", `/${id}`)).json())).not.toContain("zzfreshzz");
    expect((await call(A, "PATCH", `/${id}`, { note: "zzfreshzz" })).status).toBe(200);
    expect(JSON.stringify(await (await call(A, "GET", `/${id}`)).json())).toContain("zzfreshzz");
    // replace the ledger file with an equal-size copy that differs in content, keeping mtime: only the inode tells
    const file = workLedgerFile(hubRoots(hub.dataDir));
    const pinned = new Date("2026-11-01T00:00:00Z");
    utimesSync(file, pinned, pinned);
    expect(JSON.stringify(await (await call(A, "GET", `/${id}`)).json())).toContain("zzfreshzz"); // caches the state under the pinned mtime
    const tmpFile = `${file}.swap`;
    writeFileSync(tmpFile, readFileSync(file, "utf-8").replace("zzfreshzz", "yyswapyyy"));
    utimesSync(tmpFile, pinned, pinned);
    renameSync(tmpFile, file);
    const body = JSON.stringify(await (await call(A, "GET", `/${id}`)).json());
    expect(body).toContain("yyswapyyy");
    expect(body).not.toContain("zzfreshzz");
  });

  it("a GET whose client hangs up before the answer neither wedges nor crashes the hub", async () => {
    const { call, A, hub } = await rig();
    const id = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    const port = Number(new URL(hub.url).port);
    for (let i = 0; i < 20; i++) {
      const s = connect(port, "127.0.0.1");
      s.on("error", () => undefined);
      s.write(`GET /v1/workapi/work/${id} HTTP/1.1\r\nHost: x\r\nX-API-Key: ${A}\r\n\r\n`);
      s.destroy(); // gone before the hub can answer
    }
    const r = await call(A, "GET", `/${id}`); // a normal client is still served in full
    expect(r.status).toBe(200);
    expect(((await r.json()) as { item: { id: string } }).item.id).toBe(id);
  });
});
