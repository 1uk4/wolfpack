/** H6b: a failed .md write leaves no ledger event (compensation), a read-only work store answers a clear error, and `hubd work-orphans` cleans old ledger-only orphans. */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHubServer as createRaw, type HubServer } from "./server.js";
import { OP, seedTokens, workerTokenFor } from "./testing/tokens.js";
import { hubRoots } from "./layout.js";
import { cleanOrphans } from "./work-orphans.js";
import { main } from "./cli.js";
import { loadWorkState } from "@wolfpack/kb/client";
import { workDir } from "@wolfpack/kb/shared";

const tmp: string[] = [];
const servers: HubServer[] = [];
const roDirs: string[] = [];
afterEach(async () => {
  while (roDirs.length) chmodSync(roDirs.pop()!, 0o755);
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});
const ledgerOf = (d: string) => { const f = join(d, "ledger", "work-events.jsonl"); return existsSync(f) ? readFileSync(f, "utf8") : ""; };
const roots = (d: string) => hubRoots(d);
/** The work dir of `personal`, made unwritable (what ProtectSystem=strict does on sfo-01: EROFS there, EACCES here). */
const lockWorkDir = (d: string) => {
  const dir = workDir(roots(d), "personal");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o555);
  roDirs.push(dir);
};
const canWriteDespiteMode = () => process.getuid?.() === 0;

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

describe.skipIf(canWriteDespiteMode())("read-only work store", () => {
  it("a failed create answers a clear 503 and leaves NO ledger event behind; reads still work; after it is writable again, create works", async () => {
    const { dataDir, call } = await rig();
    expect((await call("POST", "", feature)).status).toBe(201); // seeded before the store goes read-only
    const before = ledgerOf(dataDir);
    lockWorkDir(dataDir);
    const r = await call("POST", "", { ...feature, title: "will fail" });
    expect(r.status).toBe(503);
    const rb = (await r.json()) as { error: string; code?: string };
    expect(rb.error).toMatch(/work store is read-only/);
    expect(rb.code).toBe("work_store_read_only"); // typed, not a raw 500
    expect(ledgerOf(dataDir)).toBe(before); // compensated: no ledger-only orphan
    const list = (await (await call("GET", "?domain=personal")).json()) as { items: Array<{ title: string }> };
    expect(list.items.map((i) => i.title)).toEqual(["RO feature"]);
    // a PATCH (note) on the existing item fails the same way and leaves the ledger alone
    const id = loadWorkState(roots(dataDir)).keys().next().value as string;
    const p = await call("PATCH", `/${id}`, { note: "x" });
    expect(p.status).toBe(503);
    expect(((await p.json()) as { code?: string }).code).toBe("work_store_read_only");
    expect(ledgerOf(dataDir)).toBe(before);
    chmodSync(workDir(roots(dataDir), "personal"), 0o755);
    expect((await call("POST", "", { ...feature, title: "now ok" })).status).toBe(201);
  });
});

describe("hubd work-orphans", () => {
  async function withOrphan() {
    const { hub, dataDir, call } = await rig();
    const a = (await (await call("POST", "", feature)).json()) as { id: string };
    const b = (await (await call("POST", "", { ...feature, title: "real two" })).json()) as { id: string };
    await hub.close();
    servers.pop();
    // simulate the OLD ordering: the created event was appended but the .md never written
    const ledger = ledgerOf(dataDir).split("\n").filter(Boolean);
    const created = JSON.parse(ledger.find((l) => l.includes(a.id) && l.includes("work.created"))!);
    const orphanId = "work-personal-orph4n1";
    appendFileSync(join(dataDir, "ledger", "work-events.jsonl"), JSON.stringify({ ...created, id: orphanId, title: "orphan" }) + "\n");
    return { dataDir, orphanId, real: [a.id, b.id] };
  }
  it("dry run lists only the create-only item with no .md; --apply appends work.deleted (append-only) and spares real items", async () => {
    const { dataDir, orphanId, real } = await withOrphan();
    const before = ledgerOf(dataDir);
    const dry = cleanOrphans(dataDir, { apply: false });
    expect(dry.orphans.map((o) => o.id)).toEqual([orphanId]);
    expect(ledgerOf(dataDir)).toBe(before);
    const done = cleanOrphans(dataDir, { apply: true });
    expect(done.deleted).toEqual([orphanId]);
    expect(ledgerOf(dataDir).startsWith(before)).toBe(true); // appended, never rewritten
    expect(ledgerOf(dataDir).slice(before.length)).toContain('"work.deleted"');
    const left = [...loadWorkState(roots(dataDir)).keys()].map(String);
    expect(left.sort()).toEqual([...real].sort());
    expect(cleanOrphans(dataDir, { apply: false }).orphans).toEqual([]);
  });
  it("is reachable as a CLI command, and refuses while another writer holds the lock", async () => {
    const { dataDir, orphanId } = await withOrphan();
    const lines: string[] = [];
    await main(["work-orphans", "--data-dir", dataDir], {}, (m) => lines.push(m));
    expect(lines.join("\n")).toContain(orphanId);
    expect(lines.join("\n")).toContain("dry run");
    const hub = await createRaw({ dataDir });
    servers.push(hub);
    expect(() => cleanOrphans(dataDir, { apply: true })).toThrow(/stop it first/);
  });
});
