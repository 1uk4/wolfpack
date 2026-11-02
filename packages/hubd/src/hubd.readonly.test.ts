/**
 * H6b: the pre-flight write probe (no ledger bytes change on EROFS), the write-path errno table, and `hubd work-orphans`.
 * Referenced by name from work-writes.ts ("probe: ...") and work-orphans.ts ("work-orphans ...").
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHubServer as createRaw, type HubServer } from "./server.js";
import { OP, seedTokens, workerTokenFor } from "./testing/tokens.js";
import { hubRoots } from "./layout.js";
import { cleanOrphans } from "./work-orphans.js";
import { main } from "./cli.js";
import { deleteItem, mapWorkError, setWorkStoreProbe } from "./work-writes.js";
import { loadWorkState } from "@wolfpack/kb/client";
import { workDir } from "@wolfpack/kb/shared";

const tmp: string[] = [];
const servers: HubServer[] = [];
const restores: Array<() => void> = [];
const roDirs: string[] = [];
afterEach(async () => {
  while (restores.length) restores.pop()!();
  while (roDirs.length) chmodSync(roDirs.pop()!, 0o755);
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});
const ledgerFile = (d: string) => join(d, "ledger", "work-events.jsonl");
const ledgerOf = (d: string) => (existsSync(ledgerFile(d)) ? readFileSync(ledgerFile(d), "utf8") : "");
const roots = (d: string) => hubRoots(d);
const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
/** Inject EROFS (what ProtectSystem=strict gives on sfo-01) through the probe seam. */
const injectErofs = () => restores.push(setWorkStoreProbe(() => { throw errno("EROFS"); }));
const isRoot = () => process.getuid?.() === 0;

async function rig() {
  const dataDir = mkdtempSync(join(tmpdir(), "hubd-ro-"));
  tmp.push(dataDir);
  seedTokens(dataDir, ["hA"]);
  const hub = await createRaw({ dataDir });
  servers.push(hub);
  const reg = (p: string, b: unknown) => fetch(hub.url + p, { method: "POST", headers: { "Content-Type": "application/json", ...OP }, body: JSON.stringify(b) });
  await reg("/v1/registry/domains", { name: "personal" });
  await reg("/v1/registry/hosts", { name: "hA" });
  await reg("/v1/registry/wolves", { name: "wa", host: "hA", domains: ["personal"] });
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${hub.url}/v1/workapi/work${path}`, { method, headers: { "X-API-Key": workerTokenFor("hA"), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { hub, dataDir, call };
}
const feature = { kind: "feature", domain: "personal", title: "RO feature", assignee: "wa" };

describe("probe: EROFS leaves the ledger untouched", () => {
  it("probe: create, patch and graduate answer 503 work_store_read_only and no ledger byte changes; reads still work; writable again, create works", async () => {
    const { dataDir, call } = await rig();
    const made = (await (await call("POST", "", feature)).json()) as { id: string };
    const before = ledgerOf(dataDir);
    const restore = setWorkStoreProbe(() => { throw errno("EROFS"); });
    const r = await call("POST", "", { ...feature, title: "will fail" });
    expect(r.status).toBe(503);
    const rb = (await r.json()) as { error: string; code?: string };
    expect(rb.code).toBe("work_store_read_only");
    expect(rb.error).toMatch(/work store is read-only/);
    expect(rb.error).toMatch(/turned off/);
    for (const [m, p, b] of [["PATCH", `/${made.id}`, { note: "x" }], ["POST", `/${made.id}/graduate`, undefined]] as const) {
      const x = await call(m, p, b);
      expect(x.status).toBe(503);
      expect(((await x.json()) as { code?: string }).code).toBe("work_store_read_only");
    }
    expect(ledgerOf(dataDir)).toBe(before); // byte-identical: nothing was appended
    const list = (await (await call("GET", "?domain=personal")).json()) as { items: Array<{ title: string }> };
    expect(list.items.map((i) => i.title)).toEqual(["RO feature"]);
    restore();
    expect((await call("POST", "", { ...feature, title: "now ok" })).status).toBe(201);
  });
  it("probe: a cascade delete (multi-file op) is refused before it appends anything", async () => {
    const { hub, dataDir, call } = await rig();
    const a = (await (await call("POST", "", feature)).json()) as { id: string };
    await call("POST", "", { kind: "task", domain: "personal", title: "T", assignee: "wa", partOf: a.id, successCriteria: "ok" });
    await hub.close();
    servers.pop();
    const before = ledgerOf(dataDir);
    injectErofs();
    expect(() => deleteItem(roots(dataDir), a.id)).toThrow(/EROFS/);
    expect(ledgerOf(dataDir)).toBe(before);
    expect(loadWorkState(roots(dataDir)).size).toBeGreaterThanOrEqual(2);
  });
  it.skipIf(isRoot())("probe (real fs): a work dir that is not writable fails the probe with EACCES -> work_store_permission_denied, ledger unchanged, and the wording does not say 'turned off'", async () => {
    const { dataDir, call } = await rig();
    await call("POST", "", feature);
    const before = ledgerOf(dataDir);
    const dir = workDir(roots(dataDir), "personal");
    chmodSync(dir, 0o555);
    roDirs.push(dir);
    const r = await call("POST", "", { ...feature, title: "denied" });
    expect(r.status).toBe(500);
    const rb = (await r.json()) as { error: string; code?: string };
    expect(rb.code).toBe("work_store_permission_denied");
    expect(rb.error).toMatch(/permission fault/);
    expect(rb.error).not.toMatch(/turned off|read-only/);
    expect(ledgerOf(dataDir)).toBe(before);
  });
});

describe("errno table (write paths only)", () => {
  it("errno table: only EROFS is read-only, EACCES/EPERM are permission_denied, ENOSPC/EDQUOT/EIO are generic", () => {
    const code = (e: unknown, write = true) => mapWorkError(e, { write }).details?.code;
    expect(code(errno("EROFS"))).toBe("work_store_read_only");
    expect(code(errno("EACCES"))).toBe("work_store_permission_denied");
    expect(code(errno("EPERM"))).toBe("work_store_permission_denied");
    for (const c of ["ENOSPC", "EDQUOT", "EIO"]) {
      const m = mapWorkError(errno(c), { write: true });
      expect(m.details?.code).toBeUndefined();
      expect(m.message).toBe("internal hub error");
    }
    // the protocol code is engine_error for both typed ones, so memory_unavailable (409 elsewhere) is not reused
    expect(mapWorkError(errno("EROFS"), { write: true }).code).toBe("engine_error");
  });
  it("errno table: reads never get the typed codes", () => {
    for (const c of ["EROFS", "EACCES", "EPERM"]) {
      expect(mapWorkError(errno(c)).details?.code).toBeUndefined();
      expect(mapWorkError(errno(c), { write: false }).message).toBe("internal hub error");
    }
  });
});

describe("work-orphans", () => {
  type Ev = Record<string, unknown>;
  /** Append a lone `work.created` (the old-ordering orphan) or any raw event to the ledger of a STOPPED hub. */
  const append = (dataDir: string, ev: Ev) => appendFileSync(ledgerFile(dataDir), JSON.stringify(ev) + "\n");
  async function base() {
    const { hub, dataDir, call } = await rig();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(((await (await call("POST", "", { ...feature, title: `real ${i}` })).json()) as { id: string }).id);
    await hub.close();
    servers.pop();
    const created = JSON.parse(ledgerOf(dataDir).split("\n").filter(Boolean).find((l) => l.includes(ids[0]!) && l.includes("work.created"))!) as Ev;
    const orphan = (id: string, over: Ev = {}) => append(dataDir, { ...created, id, title: "orphan", partOf: null, ...over });
    return { dataDir, ids, created, orphan };
  }

  it("work-orphans: dry run lists only a lone work.created with no .md; --apply appends work.deleted (append-only) and spares real items", async () => {
    const { dataDir, ids, orphan } = await base();
    orphan("work-personal-orph4n1");
    const before = ledgerOf(dataDir);
    const dry = cleanOrphans(dataDir, { apply: false });
    expect(dry.orphans.map((o) => o.id)).toEqual(["work-personal-orph4n1"]);
    expect(ledgerOf(dataDir)).toBe(before);
    const done = cleanOrphans(dataDir, { apply: true });
    expect(done.deleted).toEqual(["work-personal-orph4n1"]);
    expect(ledgerOf(dataDir).startsWith(before)).toBe(true);
    expect(ledgerOf(dataDir).slice(before.length)).toContain('"work.deleted"');
    expect([...loadWorkState(roots(dataDir)).keys()].map(String).sort()).toEqual([...ids].sort());
  });

  it("work-orphans: an item with no .md but more than the one work.created event (or a non-created single event) is NOT an orphan", async () => {
    const { dataDir, orphan } = await base();
    orphan("work-personal-two0001");
    append(dataDir, { type: "work.noted", id: "work-personal-two0001", at: "2026-10-29 10:00", text: "hi" });
    const r = cleanOrphans(dataDir, { apply: true });
    expect(r.orphans).toEqual([]);
    expect(r.skipped.find((s) => s.id === "work-personal-two0001")?.reason).toMatch(/not exactly one work\.created/);
    expect(loadWorkState(roots(dataDir)).has("work-personal-two0001" as never)).toBe(true);
  });

  it("work-orphans: grandchild test: a cascade never removes a non-orphan descendant", async () => {
    const { dataDir, orphan, created } = await base();
    // A (orphan) -> B (orphan) -> C (real: has an .md). Deleting A would cascade through B to C, so A and B must both be skipped.
    orphan("work-personal-gpA0001");
    orphan("work-personal-gpB0001", { partOf: "work-personal-gpA0001" });
    append(dataDir, { ...created, id: "work-personal-gpC0001", title: "real grandchild", partOf: "work-personal-gpB0001", kind: "task" });
    writeFileSync(join(workDir(roots(dataDir), "personal"), "work-personal-gpC0001.md"), "---\nid: work-personal-gpC0001\n---\n");
    const before = ledgerOf(dataDir);
    const r = cleanOrphans(dataDir, { apply: true });
    expect(r.orphans).toEqual([]);
    expect(r.deleted).toEqual([]);
    expect(r.skipped.map((s) => s.id)).toEqual(expect.arrayContaining(["work-personal-gpA0001", "work-personal-gpB0001"]));
    expect(ledgerOf(dataDir)).toBe(before); // no work.deleted appended at all
    expect(loadWorkState(roots(dataDir)).has("work-personal-gpC0001" as never)).toBe(true);
    // and an all-orphan chain IS deleted together
    orphan("work-personal-chA0001");
    orphan("work-personal-chB0001", { partOf: "work-personal-chA0001" });
    const ok = cleanOrphans(dataDir, { apply: true });
    expect(ok.deleted.sort()).toEqual(["work-personal-chA0001", "work-personal-chB0001"]);
    expect(loadWorkState(roots(dataDir)).has("work-personal-gpC0001" as never)).toBe(true);
  });

  it("work-orphans: aborts over max(3, 10%) without --force, prints the whole list, and --force proceeds", async () => {
    const { dataDir, orphan } = await base(); // 12 real items + the Inbox => limit 3
    for (let i = 0; i < 5; i++) orphan(`work-personal-many00${i}`);
    const r = cleanOrphans(dataDir, { apply: true });
    expect(r.orphans).toHaveLength(5);
    expect(r.aborted).toMatch(/nothing deleted/);
    expect(r.deleted).toEqual([]);
    const lines: string[] = [];
    await expect(main(["work-orphans", "--data-dir", dataDir, "--apply"], {}, (m) => lines.push(m))).rejects.toThrow(/more than/);
    expect(lines.filter((l) => l.startsWith("orphan ")).length).toBe(5); // the full list is printed before the abort
    const forced = cleanOrphans(dataDir, { apply: true, force: true });
    expect(forced.deleted).toHaveLength(5);
  });

  it("work-orphans: titles are printed without control characters; a missing or unreadable work dir classifies nothing", async () => {
    const { dataDir, orphan } = await base();
    orphan("work-personal-ctl0001", { title: "evil\u001b[31m\nforged line\u0007" });
    const lines: string[] = [];
    await main(["work-orphans", "--data-dir", dataDir], {}, (m) => lines.push(m));
    const mine = lines.find((l) => l.includes("work-personal-ctl0001"))!;
    expect(mine).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(lines.join("\n")).toContain("dry run");
    rmSync(workDir(roots(dataDir), "personal"), { recursive: true });
    const r = cleanOrphans(dataDir, { apply: true });
    expect(r.orphans).toEqual([]);
    expect(r.skipped.some((s) => /missing or unreadable/.test(s.reason))).toBe(true);
    expect(loadWorkState(roots(dataDir)).has("work-personal-ctl0001" as never)).toBe(true);
  });

  it("work-orphans: needs hubd stopped, even for the dry run", async () => {
    const { dataDir } = await base();
    const hub = await createRaw({ dataDir });
    servers.push(hub);
    expect(() => cleanOrphans(dataDir, { apply: false })).toThrow(/stop it first/);
  });
});
