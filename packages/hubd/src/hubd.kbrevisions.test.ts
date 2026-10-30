/** KB revisions + change log: commit and scan detection, changes-since, manifest diff, retention fallback, durability, access. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTOR_HEADER, type KbChange, type KbChangesResponse, type KbManifestDiffResponse } from "@wolfpack/protocol";
import { contentHash } from "@wolfpack/kb/shared";
import { createHubServer, type HubOptions, type HubServer } from "./server.js";
import { createTokenStore } from "./auth.js";

const KEY = "k";
const OP = { id: "1uk4", kind: "operator" } as const;
const tmp: string[] = [];
let servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

const entry = (domain: string, id: string, title = "T") => `---\nid: ${id}\ntitle: "${title}"\ndomain: ${domain}\n---\n\n# ${title}\n\nBody text.\n`;
const A1 = "kb-alpha-aaaaaaa";
const A2 = "kb-alpha-bbbbbbb";
const create = (domain: string, id: string, content = entry(domain, id)): KbChange => ({ op: "create", domain, path: `entries/${id}.md`, content, contentHash: contentHash(content), prevHash: null });
const update = (domain: string, id: string, prev: string, content: string): KbChange => ({ op: "update", domain, path: `entries/${id}.md`, content, contentHash: contentHash(content), prevHash: contentHash(prev) });
const del = (domain: string, id: string, prev: string): KbChange => ({ op: "delete", domain, path: `entries/${id}.md`, contentHash: null, prevHash: contentHash(prev) });
const long = Date.now() - 3_600_000;
let bump = 0; // every direct write gets a distinct old mtime, like a real clock would

async function setup(over: Partial<HubOptions> = {}, existing?: string) {
  const dir = existing ?? mkdtempSync(join(tmpdir(), "hubd-kbrev-"));
  if (!existing) {
    tmp.push(dir);
    mkdirSync(join(dir, "kb", "base"), { recursive: true });
    writeFileSync(join(dir, "kb", "base", "domains.yaml"), "domains:\n  alpha:\n    label: Alpha\n  beta:\n    label: Beta\n");
    for (const d of ["alpha", "beta"]) mkdirSync(join(dir, "kb", "base", "domains", d, "entries"), { recursive: true });
  }
  const clock = { t: Date.now() };
  const opts: HubOptions = { dataDir: dir, apiKey: KEY, kbPollMs: 0, kbSettleMs: -1, now: () => clock.t, ...over };
  let hub = await createHubServer(opts);
  servers.push(hub);
  const base = join(dir, "kb", "base", "domains");
  const api = {
    dir,
    clock,
    get hub() {
      return hub;
    },
    async restart(o: Partial<HubOptions> = {}) {
      await hub.close();
      servers = servers.filter((s) => s !== hub);
      hub = await createHubServer({ ...opts, ...o });
      servers.push(hub);
    },
    commit: (...changes: KbChange[]) =>
      fetch(hub.url + "/v1/kb/commits", { method: "POST", headers: { "X-API-Key": KEY, "Content-Type": "application/json", [ACTOR_HEADER]: JSON.stringify(OP) }, body: JSON.stringify({ changes }) }),
    file: (d: string, p: string) => join(base, d, p),
    /** Direct write like Dewey's; `old` backdates the mtime out of any settle window. */
    write(d: string, p: string, text: string, old = true) {
      const f = join(base, d, p);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
      if (old) utimesSync(f, (long + ++bump * 1000) / 1000, (long + bump * 1000) / 1000);
    },
    get: (path: string, headers: Record<string, string> = { "X-API-Key": KEY }) => fetch(hub.url + path, { headers }),
    async changes(d: string, q = "") {
      // since > 0 needs an epoch: add the hub's current one unless the test passes its own
      if (/since=[1-9]/.test(q) && !q.includes("epoch=")) q += `&epoch=${((await (await fetch(`${hub.url}/v1/kb/domains/${d}/manifest`, { headers: { "X-API-Key": KEY } })).json()) as { epoch: string }).epoch}`;
      const r = await fetch(`${hub.url}/v1/kb/domains/${d}/changes${q}`, { headers: { "X-API-Key": KEY } });
      expect(r.status).toBe(200);
      return (await r.json()) as KbChangesResponse;
    },
    async rev(d: string) {
      return ((await (await fetch(`${hub.url}/v1/kb/domains/${d}/manifest`, { headers: { "X-API-Key": KEY } })).json()) as { revision: number }).revision;
    },
    async diff(d: string, files: Record<string, string>, maxBytes?: number) {
      const r = await fetch(`${hub.url}/v1/kb/domains/${d}/manifest-diff`, { method: "POST", headers: { "X-API-Key": KEY, "Content-Type": "application/json" }, body: JSON.stringify({ files, maxBytes }) });
      expect(r.status).toBe(200);
      return (await r.json()) as KbManifestDiffResponse;
    },
  };
  return api;
}
const ok = (c: KbChangesResponse) => {
  if (c.status !== "ok") throw new Error(`expected ok, got reset ${c.reason}`);
  return c;
};

describe("KB revisions", () => {
  it("a commit raises the revision (create, update, delete) and changes-since reports it", async () => {
    const s = await setup();
    expect(await s.rev("alpha")).toBe(0);
    expect((await s.commit(create("alpha", A1), create("alpha", A2))).status).toBe(200);
    expect(await s.rev("alpha")).toBe(2);
    const c1 = ok(await s.changes("alpha", "?since=0"));
    expect(c1).toMatchObject({ since: 0, revision: 2, truncated: false, deletes: [] });
    expect(c1.files.map((f) => f.path).sort()).toEqual([`entries/${A1}.md`, `entries/${A2}.md`]);
    expect(c1.files[0]).toMatchObject({ encoding: "utf8" });
    expect(c1.files.find((f) => f.path === `entries/${A1}.md`)!.content).toBe(entry("alpha", A1));
    const v2 = entry("alpha", A1, "T2");
    expect((await s.commit(update("alpha", A1, entry("alpha", A1), v2), del("alpha", A2, entry("alpha", A2)))).status).toBe(200);
    expect(await s.rev("alpha")).toBe(4);
    const c2 = ok(await s.changes("alpha", `?since=2&epoch=${c1.epoch}`));
    expect(c2.files.map((f) => [f.path, f.content])).toEqual([[`entries/${A1}.md`, v2]]);
    expect(c2.deletes).toEqual([{ path: `entries/${A2}.md` }]);
    expect(ok(await s.changes("alpha", "?since=4")).files).toEqual([]);
    expect(await s.rev("beta")).toBe(0); // other domains are independent
    // the commit is not seen a second time by the scanner
    await s.hub.scanKb();
    expect(await s.rev("alpha")).toBe(4);
  });

  it("the scanner picks up direct writes (entries, versions/, registry, digest) and deletes", async () => {
    const s = await setup();
    s.write("alpha", `entries/${A1}.md`, entry("alpha", A1));
    s.write("alpha", `versions/${A1}/v1.md`, "old version\n");
    s.write("alpha", "_registry.md", "# reg\n");
    s.write("alpha", "_digest.json", "{}");
    await s.hub.scanKb();
    expect(await s.rev("alpha")).toBe(4);
    const c = ok(await s.changes("alpha"));
    expect(c.files.map((f) => f.path).sort()).toEqual(["_digest.json", "_registry.md", `entries/${A1}.md`, `versions/${A1}/v1.md`]);
    await s.hub.scanKb();
    expect(await s.rev("alpha")).toBe(4); // unchanged files cost nothing
    s.write("alpha", `entries/${A1}.md`, entry("alpha", A1, "edited"));
    rmSync(s.file("alpha", "_registry.md"));
    await s.hub.scanKb();
    const c2 = ok(await s.changes("alpha", "?since=4"));
    expect(c2.revision).toBe(6);
    expect(c2.files.map((f) => f.path)).toEqual([`entries/${A1}.md`]);
    expect(c2.deletes).toEqual([{ path: "_registry.md" }]);
    // rewriting identical bytes is not a change
    s.write("alpha", `entries/${A1}.md`, entry("alpha", A1, "edited"));
    await s.hub.scanKb();
    expect(await s.rev("alpha")).toBe(6);
  });

  it("ignores tmp files, dotfiles, foreign paths, and files inside the settle window", async () => {
    const s = await setup({ kbSettleMs: 5000 });
    s.write("alpha", `entries/${A1}.md.tmp-123-0123abcd`, "partial");
    s.write("alpha", "entries/.hidden.md", "x");
    s.write("alpha", "notes.txt", "x");
    s.write("alpha", "entries/sub/deep.md", "x");
    s.write("alpha", ".git/config.md", "x");
    s.write("alpha", `entries/${A2}.md`, entry("alpha", A2), false); // fresh mtime: inside the settle window
    await s.hub.scanKb();
    expect(await s.rev("alpha")).toBe(0);
    utimesSync(s.file("alpha", `entries/${A2}.md`), long / 1000, long / 1000);
    await s.hub.scanKb();
    expect(ok(await s.changes("alpha")).files.map((f) => f.path)).toEqual([`entries/${A2}.md`]);
    // startup scans take everything, settled or not
    s.write("alpha", `entries/${A1}.md`, entry("alpha", A1), false);
    await s.restart();
    expect(await s.rev("alpha")).toBe(2);
  });

  it("symlinked files and directories are ignored", async () => {
    const s = await setup();
    s.write("alpha", `entries/${A1}.md`, entry("alpha", A1));
    const outside = join(s.dir, "outside.md");
    writeFileSync(outside, "secret");
    symlinkSync(outside, s.file("alpha", `entries/${A2}.md`));
    mkdirSync(join(s.dir, "elsewhere", "kb-alpha-ccccccc"), { recursive: true });
    writeFileSync(join(s.dir, "elsewhere", "kb-alpha-ccccccc", "v.md"), "x");
    symlinkSync(join(s.dir, "elsewhere"), s.file("alpha", "versions"));
    await s.hub.scanKb();
    expect(ok(await s.changes("alpha")).files.map((f) => f.path)).toEqual([`entries/${A1}.md`]);
    // a symlinked domain directory is not a domain
    symlinkSync(join(s.dir, "elsewhere"), join(s.dir, "kb", "base", "domains", "gamma"));
    await s.hub.scanKb();
    expect((await s.get("/v1/kb/domains/gamma/manifest")).status).toBe(404);
  });

  it("coalesces per path and pages by maxBytes", async () => {
    const s = await setup();
    const ids = ["kb-alpha-1111111", "kb-alpha-2222222", "kb-alpha-3333333"];
    for (const id of ids) s.write("alpha", `entries/${id}.md`, entry("alpha", id, "x".repeat(400)));
    await s.hub.scanKb();
    s.write("alpha", `entries/${ids[0]}.md`, entry("alpha", ids[0], "y".repeat(400)));
    await s.hub.scanKb();
    s.write("alpha", `entries/${ids[0]}.md`, entry("alpha", ids[0], "z".repeat(400)));
    await s.hub.scanKb();
    const all = ok(await s.changes("alpha"));
    expect(all.revision).toBe(5);
    expect(all.files).toHaveLength(3); // ids[0] changed twice but appears once, with its latest content
    expect(all.files.find((f) => f.path === `entries/${ids[0]}.md`)!.content).toContain("z");
    // tiny pages: each carries one file, progress is guaranteed, and the pages add up to the same set
    const got = new Map<string, string>();
    let since = 0;
    let pages = 0;
    for (;;) {
      const p = ok(await s.changes("alpha", `?since=${since}&maxBytes=1&epoch=${all.epoch}`));
      pages++;
      for (const f of p.files) got.set(f.path, f.content);
      expect(p.files.length).toBeLessThanOrEqual(1);
      if (!p.truncated) break;
      expect(p.revision).toBeGreaterThan(since);
      since = p.revision;
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    expect([...got.keys()].sort()).toEqual(ids.map((i) => `entries/${i}.md`));
    expect(got.get(`entries/${ids[0]}.md`)).toContain("z");
  });

  it("survives a restart: counter, epoch and log persist, edits made while down are recorded", async () => {
    const s = await setup();
    await s.commit(create("alpha", A1), create("beta", "kb-beta-ccccccc"));
    const before = ok(await s.changes("alpha"));
    await s.hub.close();
    servers = servers.filter((x) => x !== s.hub);
    // edited and added while the hub is down
    s.write("alpha", `entries/${A1}.md`, entry("alpha", A1, "while down"));
    s.write("alpha", `entries/${A2}.md`, entry("alpha", A2));
    await s.restart();
    expect(await s.rev("beta")).toBe(1);
    const after = ok(await s.changes("alpha", `?since=1&epoch=${before.epoch}`));
    expect(after.epoch).toBe(before.epoch);
    expect(after.revision).toBe(3);
    expect(after.files.map((f) => f.path).sort()).toEqual([`entries/${A1}.md`, `entries/${A2}.md`]);
    const rows = readFileSync(join(s.dir, "kb-rev", "alpha", "changes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.rev, r.op])).toEqual([[1, "create"], [2, "update"], [3, "create"]]);
    expect(JSON.parse(readFileSync(join(s.dir, "kb-rev", "alpha", "state.json"), "utf8"))).toMatchObject({ v: 1, rev: 3, floor: 0 });
  });

  it("a torn last log row and a stale or corrupt manifest are repaired on start", async () => {
    const s = await setup();
    await s.commit(create("alpha", A1), create("alpha", A2));
    const epoch = ok(await s.changes("alpha")).epoch;
    await s.hub.close();
    servers = servers.filter((x) => x !== s.hub);
    const log = join(s.dir, "kb-rev", "alpha", "changes.jsonl");
    writeFileSync(log, readFileSync(log, "utf8") + '{"rev":3,"ts":1,"pa'); // crash mid-append
    await s.restart();
    expect(await s.rev("alpha")).toBe(2);
    expect(ok(await s.changes("alpha", `?since=0&epoch=${epoch}`)).files).toHaveLength(2);
    await s.hub.close();
    servers = servers.filter((x) => x !== s.hub);
    writeFileSync(join(s.dir, "kb-rev", "alpha", "manifest.json"), "{not json");
    await s.restart();
    const m = (await (await s.get("/v1/kb/domains/alpha/manifest")).json()) as { revision: number; floor: number; epoch: string; files: Record<string, string> };
    expect(m).toMatchObject({ revision: 3, floor: 3, epoch }); // rebuilt: one synthetic revision
    expect(Object.keys(m.files)).toHaveLength(2);
    expect((await s.changes("alpha", "?since=0")).status).toBe("reset"); // rebuilt manifest: older cursors resync
  });

  it("a crash between the journal drop and the revision record is caught by the next start", async () => {
    let armed = true;
    const s = await setup({ kbFaults: { at: (st) => { if (st === "committed" && armed) throw new Error("boom"); } } });
    const r = await s.commit(create("alpha", A1));
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(existsSync(s.file("alpha", `entries/${A1}.md`))).toBe(true); // the file landed
    expect(await s.rev("alpha")).toBe(0); // ...but was never recorded
    armed = false;
    await s.restart();
    expect(await s.rev("alpha")).toBe(1);
    expect(ok(await s.changes("alpha")).files.map((f) => f.path)).toEqual([`entries/${A1}.md`]);
  });

  it("falls back after retention expiry: below_floor reset, then manifest-diff converges (deletes and paging)", async () => {
    const s = await setup({ kbRetention: { days: 30, maxChanges: 3 } });
    const ids = ["kb-alpha-1111111", "kb-alpha-2222222", "kb-alpha-3333333", "kb-alpha-4444444", "kb-alpha-5555555"];
    for (const id of ids) s.write("alpha", `entries/${id}.md`, entry("alpha", id));
    await s.hub.scanKb(); // revs 1..5
    const first = ok(await s.changes("alpha"));
    // the worker syncs everything at revision 5
    const mirror: Record<string, string> = Object.fromEntries(first.files.map((f) => [f.path, f.contentHash]));
    rmSync(s.file("alpha", `entries/${ids[4]}.md`));
    s.write("alpha", `entries/${ids[0]}.md`, entry("alpha", ids[0], "new"));
    await s.hub.scanKb(); // revs 6, 7
    s.clock.t += 31 * 86_400_000;
    await s.hub.scanKb({ prune: true }); // 7 rows, > 3 and all older than 30 days: drop 4
    const stale = await s.changes("alpha", "?since=3");
    expect(stale).toMatchObject({ status: "reset", reason: "below_floor", floor: 4, revision: 7 });
    // a cursor at or above the floor still works
    expect(ok(await s.changes("alpha", "?since=4")).deletes).toEqual([{ path: `entries/${ids[4]}.md` }]);
    // manifest-diff converges, paged by a tiny maxBytes
    for (let i = 0, pending = 1; pending > 0 && i < 10; i++) {
      const d = await s.diff("alpha", mirror, 1);
      for (const f of d.files) mirror[f.path] = f.contentHash;
      for (const x of d.deletes) delete mirror[x.path];
      expect(d.files.length).toBeLessThanOrEqual(1);
      pending = d.pending.length;
      if (pending === 0) expect(d.revision).toBe(7);
    }
    const m = (await (await s.get("/v1/kb/domains/alpha/manifest")).json()) as { files: Record<string, string> };
    expect(mirror).toEqual(m.files);
    expect(Object.keys(mirror)).toHaveLength(4);
    expect(mirror[`entries/${ids[0]}.md`]).toBe(contentHash(entry("alpha", ids[0], "new")));
  });

  it("retention keeps a row when it is within 30 days OR among the last N changes", async () => {
    const s = await setup({ kbRetention: { days: 30, maxChanges: 3 } });
    for (const n of [1, 2, 3, 4, 5]) s.write("alpha", `entries/kb-alpha-${String(n).repeat(7)}.md`, entry("alpha", `kb-alpha-${String(n).repeat(7)}`));
    await s.hub.scanKb({ prune: true });
    // all recent, over the count: kept (within 30 days)
    expect(await s.changes("alpha", "?since=0")).toMatchObject({ status: "ok" });
    s.clock.t += 31 * 86_400_000;
    await s.hub.scanKb({ prune: true });
    // all old, over the count: only the newest 3 survive (floor = 2)
    expect(await s.changes("alpha", "?since=1")).toMatchObject({ status: "reset", reason: "below_floor", floor: 2 });
    expect(ok(await s.changes("alpha", "?since=2")).files).toHaveLength(3);
    // old but within the count: kept
    s.write("beta", `entries/kb-beta-1111111.md`, entry("beta", "kb-beta-1111111"));
    await s.hub.scanKb();
    s.clock.t += 60 * 86_400_000;
    await s.hub.scanKb({ prune: true });
    expect(await s.changes("beta", "?since=0")).toMatchObject({ status: "ok" });
    // the floor survives a restart
    await s.restart();
    expect(await s.changes("alpha", "?since=1")).toMatchObject({ status: "reset", reason: "below_floor" });
  });

  it("answers epoch mismatch and a cursor ahead of the hub with a reset", async () => {
    const s = await setup();
    await s.commit(create("alpha", A1));
    const c = ok(await s.changes("alpha"));
    expect(await s.changes("alpha", "?since=0&epoch=deadbeef")).toMatchObject({ status: "reset", reason: "epoch_mismatch", epoch: c.epoch });
    expect(await s.changes("alpha", `?since=9&epoch=${c.epoch}`)).toMatchObject({ status: "reset", reason: "ahead_of_hub", revision: 1 });
    expect((await s.get("/v1/kb/domains/alpha/changes?since=-1")).status).toBe(400);
    expect((await s.get("/v1/kb/domains/alpha/changes?maxBytes=0")).status).toBe(400);
  });

  it("manifest-diff: ignores matching files, returns changed ones and deletes", async () => {
    const s = await setup();
    await s.commit(create("alpha", A1), create("alpha", A2));
    const m = (await (await s.get("/v1/kb/domains/alpha/manifest")).json()) as { files: Record<string, string>; revision: number };
    expect(m.revision).toBe(2);
    const d = await s.diff("alpha", { ...m.files, [`entries/${A2}.md`]: contentHash("stale"), "entries/kb-alpha-zzzzzzz.md": contentHash("gone") });
    expect(d.files.map((f) => f.path)).toEqual([`entries/${A2}.md`]);
    expect(d.deletes).toEqual([{ path: "entries/kb-alpha-zzzzzzz.md" }]);
    expect(d).toMatchObject({ revision: 2, pending: [] });
    expect((await s.diff("alpha", m.files)).files).toEqual([]);
  });

  it("rejects bad domains and unknown ones", async () => {
    const s = await setup();
    expect((await s.get("/v1/kb/domains/..%2Fx/changes")).status).toBe(400);
    expect((await s.get("/v1/kb/domains/..%2F..%2Fetc/manifest")).status).toBe(400);
    expect((await s.get("/v1/kb/domains/Alpha/manifest")).status).toBe(400);
    expect((await s.get("/v1/kb/domains/nope/manifest")).status).toBe(404);
    expect((await fetch(`${s.hub.url}/v1/kb/domains/alpha/manifest`)).status).toBe(401);
  });

  it("worker tokens read subscribed domains only; console tokens read all; kb/commits stays closed to workers", async () => {
    const s = await setup();
    const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
      fetch(s.hub.url + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const adm = { "X-API-Key": KEY, [ACTOR_HEADER]: JSON.stringify(OP) };
    for (const d of ["alpha", "beta"]) expect((await call("POST", "/v1/registry/domains", adm, { name: d })).status).toBe(201);
    expect((await call("POST", "/v1/registry/hosts", adm, { name: "h1" })).status).toBe(201);
    expect((await call("POST", "/v1/registry/hosts", adm, { name: "h2" })).status).toBe(201);
    expect((await call("POST", "/v1/registry/wolves", adm, { name: "w1", host: "h1", domains: ["alpha"] })).status).toBe(201);
    expect((await call("POST", "/v1/registry/wolves", adm, { name: "w2", host: "h2", domains: ["beta"] })).status).toBe(201);
    s.write("alpha", `entries/${A1}.md`, entry("alpha", A1));
    s.write("beta", "entries/kb-beta-ccccccc.md", entry("beta", "kb-beta-ccccccc"));
    await s.hub.scanKb();
    const store = createTokenStore(s.dir);
    const pair = async (kind: "worker" | "console", hostId?: string) => {
      const r = await call("POST", "/v1/pair", {}, { code: store.mintPairingCode({ kind, hostId }).code, label: "t", kind, ...(hostId ? { hostId } : {}) });
      return { Authorization: `Bearer ${((await r.json()) as { token: string }).token}` };
    };
    const w1 = await pair("worker", "h1");
    const con = await pair("console");
    expect((await call("GET", "/v1/kb/domains/alpha/changes", w1)).status).toBe(200);
    expect((await call("GET", "/v1/kb/domains/alpha/manifest", w1)).status).toBe(200);
    expect((await call("POST", "/v1/kb/domains/alpha/manifest-diff", w1, { files: {} })).status).toBe(200);
    for (const [m, p, b] of [["GET", "/v1/kb/domains/beta/changes"], ["GET", "/v1/kb/domains/beta/manifest"], ["POST", "/v1/kb/domains/beta/manifest-diff", { files: {} }], ["GET", "/v1/kb/domains/zzz/changes"]] as const) {
      const r = await call(m, p, w1, b);
      expect(r.status, p).toBe(403);
      expect(((await r.json()) as { code: string }).code).toBe("forbidden");
    }
    expect((await call("GET", "/v1/kb/domains/beta/changes", con)).status).toBe(200);
    expect((await call("POST", "/v1/kb/commits", w1, { changes: [create("alpha", A2)] })).status).toBe(403);
    expect((await call("GET", "/v1/kb/domains/beta/changes", { "X-API-Key": KEY })).status).toBe(200); // legacy key: unchanged behaviour
  });

  it("the poll timer detects direct writes on its own", async () => {
    const s = await setup({ kbPollMs: 25 });
    s.write("alpha", `entries/${A1}.md`, entry("alpha", A1));
    for (let i = 0; i < 100 && (await s.rev("alpha")) === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(await s.rev("alpha")).toBe(1);
  });

  it("kb/base as a symlink: scan and serve work; an unavailable target is never a mass delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-kbrev-link-"));
    tmp.push(dir);
    const real = join(dir, "real-base");
    mkdirSync(join(real, "domains", "alpha", "entries"), { recursive: true });
    writeFileSync(join(real, "domains.yaml"), "domains:\n  alpha:\n    label: Alpha\n");
    mkdirSync(join(dir, "kb"), { recursive: true });
    symlinkSync(real, join(dir, "kb", "base"));
    const f = join(real, "domains", "alpha", "entries", `${A1}.md`);
    writeFileSync(f, entry("alpha", A1));
    utimesSync(f, long / 1000, long / 1000);
    const s = await setup({}, dir);
    expect(await s.rev("alpha")).toBe(1);
    expect((await s.commit(create("alpha", A2))).status).toBe(200);
    expect(await s.rev("alpha")).toBe(2);
    expect(ok(await s.changes("alpha")).files.map((x) => x.path).sort()).toEqual([`entries/${A1}.md`, `entries/${A2}.md`]);
    // the target goes away (unmounted): nothing is deleted, nothing is raised
    renameSync(real, `${real}.off`);
    await s.hub.scanKb();
    expect(await s.rev("alpha")).toBe(2);
    expect(Object.keys(((await (await s.get("/v1/kb/domains/alpha/manifest")).json()) as { files: object }).files)).toHaveLength(2);
    renameSync(`${real}.off`, real);
    await s.hub.scanKb();
    expect(await s.rev("alpha")).toBe(2);
    // a domain that is really gone (domains/ readable, domains/<d> absent) IS deleted
    rmSync(join(real, "domains", "alpha"), { recursive: true });
    await s.hub.scanKb();
    expect(await s.rev("alpha")).toBe(4);
  });

  it("state.json written but the log missing: the revision is kept and the floor covers the gap", async () => {
    const s = await setup();
    await s.commit(create("alpha", A1), create("alpha", A2));
    const epoch = ok(await s.changes("alpha")).epoch;
    await s.hub.close();
    servers = servers.filter((x) => x !== s.hub);
    rmSync(join(s.dir, "kb-rev", "alpha", "changes.jsonl"));
    await s.restart();
    expect(await s.rev("alpha")).toBe(2);
    expect(await s.changes("alpha", `?since=1&epoch=${epoch}`)).toMatchObject({ status: "reset", reason: "below_floor", floor: 2 });
    expect(ok(await s.changes("alpha", `?since=2&epoch=${epoch}`)).files).toEqual([]);
  });

  it("a log with a missing head or a hole is covered by raising the floor", async () => {
    // rows 1..5 exist; build logs by hand-editing between restarts
    const prep = async () => {
      const s = await setup();
      await s.commit(create("alpha", A1), create("alpha", A2));
      s.write("alpha", "_registry.md", "# r\n");
      s.write("alpha", "_digest.json", "{}");
      s.write("alpha", "INDEX.md", "# i\n");
      await s.hub.scanKb();
      expect(await s.rev("alpha")).toBe(5);
      const epoch = ok(await s.changes("alpha")).epoch;
      await s.hub.close();
      servers = servers.filter((x) => x !== s.hub);
      const log = join(s.dir, "kb-rev", "alpha", "changes.jsonl");
      return { s, epoch, log, lines: readFileSync(log, "utf8").trim().split("\n") };
    };
    // rows 3, 4, 5 with 3 removed (state.floor 0): head of the live log is lost -> floor 3
    {
      const { s, epoch, log, lines } = await prep();
      writeFileSync(log, lines.filter((l) => JSON.parse(l).rev >= 4).join("\n") + "\n"); // rows 1-2 gone too: 3 missing, 4 and 5 survive
      await s.restart();
      expect(await s.rev("alpha")).toBe(5);
      expect(await s.changes("alpha", `?since=2&epoch=${epoch}`)).toMatchObject({ status: "reset", reason: "below_floor", floor: 3 });
      const c = ok(await s.changes("alpha", `?since=3&epoch=${epoch}`));
      expect(c.revision).toBe(5);
      expect(c.files).toHaveLength(2); // rows 4 and 5
      await s.hub.close();
      servers = servers.filter((x) => x !== s.hub);
    }
    // a hole at row 4 (rows 1-3 and 5 survive): only the contiguous suffix (5) is trusted -> floor 4
    {
      const { s, epoch, log, lines } = await prep();
      writeFileSync(log, lines.filter((l) => JSON.parse(l).rev !== 4).join("\n") + "\n");
      await s.restart();
      expect(await s.rev("alpha")).toBe(5);
      expect(await s.changes("alpha", `?since=3&epoch=${epoch}`)).toMatchObject({ status: "reset", reason: "below_floor", floor: 4 });
      const c = ok(await s.changes("alpha", `?since=4&epoch=${epoch}`));
      expect(c.revision).toBe(5);
      expect(c.files).toHaveLength(1);
    }
  });

  it("after a manifest rebuild a client at exactly the old head is reset (synthetic revision)", async () => {
    const s = await setup();
    await s.commit(create("alpha", A1), create("alpha", A2));
    const epoch = ok(await s.changes("alpha")).epoch;
    await s.hub.close();
    servers = servers.filter((x) => x !== s.hub);
    rmSync(join(s.dir, "kb-rev", "alpha", "manifest.json"));
    await s.restart();
    expect(await s.rev("alpha")).toBe(3);
    expect(await s.changes("alpha", `?since=2&epoch=${epoch}`)).toMatchObject({ status: "reset", reason: "below_floor", floor: 3, revision: 3, epoch });
    expect(ok(await s.changes("alpha", `?since=3&epoch=${epoch}`)).files).toEqual([]);
  });

  it("a Dewey overwrite between the commit and its record is not hidden", async () => {
    const dewey = entry("alpha", A1, "dewey");
    let hit = false;
    let writeIt = () => {};
    const s = await setup({ kbFaults: { at: (st) => { if (st === "committed") { hit = true; writeIt(); } } } });
    writeIt = () => writeFileSync(s.file("alpha", `entries/${A1}.md`), dewey);
    expect((await s.commit(create("alpha", A1))).status).toBe(200);
    expect(hit).toBe(true);
    const m = (await (await s.get("/v1/kb/domains/alpha/manifest")).json()) as { files: Record<string, string>; revision: number };
    expect(m.files[`entries/${A1}.md`]).toBe(contentHash(dewey)); // what is on disk, not what was committed
    const c = ok(await s.changes("alpha"));
    expect(c.files[0]).toMatchObject({ content: dewey, contentHash: contentHash(dewey) });
    await s.hub.scanKb({ settle: false });
    expect(await s.rev("alpha")).toBe(m.revision); // nothing further to record
  });

  it("a same-size rewrite with a restored mtime is detected (ctime)", async () => {
    const s = await setup();
    s.write("alpha", `entries/${A1}.md`, entry("alpha", A1, "AAAA"));
    await s.hub.scanKb();
    expect(await s.rev("alpha")).toBe(1);
    const f = s.file("alpha", `entries/${A1}.md`);
    // Assumes the filesystem keeps mtime to at least ms precision (utimes restores the Date exactly); the stat cache compares ns, so the
    // restored mtime matches but ctime (set by the kernel at write time) still differs.
    const { mtime } = statSync(f);
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(f, entry("alpha", A1, "BBBB")); // same size
    utimesSync(f, mtime, mtime);
    await s.hub.scanKb();
    expect(await s.rev("alpha")).toBe(2);
    expect(ok(await s.changes("alpha", "?since=1")).files[0]!.content).toContain("BBBB");
  });

  it("a failed persist drops the domain and the next load takes a new epoch (revisions are never reused under one epoch)", async () => {
    const s = await setup();
    const epoch0 = ok(await s.changes("alpha")).epoch;
    mkdirSync(join(s.dir, "kb-rev", "alpha", "changes.jsonl")); // appending to a directory throws
    s.write("alpha", `entries/${A1}.md`, entry("alpha", A1));
    await s.hub.scanKb(); // fails, logged
    expect((await s.get("/v1/kb/domains/alpha/manifest")).status).toBe(404); // dropped until the next scan
    rmSync(join(s.dir, "kb-rev", "alpha", "changes.jsonl"), { recursive: true });
    await s.hub.scanKb();
    const c = ok(await s.changes("alpha"));
    expect(c.revision).toBe(1);
    expect(c.epoch).not.toBe(epoch0);
    expect(c.files.map((f) => f.path)).toEqual([`entries/${A1}.md`]);
  });

  it("requires the epoch when since > 0", async () => {
    const s = await setup();
    await s.commit(create("alpha", A1));
    expect((await s.get("/v1/kb/domains/alpha/changes?since=1")).status).toBe(400);
    expect((await s.get("/v1/kb/domains/alpha/changes?since=0")).status).toBe(200);
  });
});
