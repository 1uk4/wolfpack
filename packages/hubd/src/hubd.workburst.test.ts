/** Work API read bursts (work-wolfpack-4NCfshp): a realistic ledger (~6,000 events, ~2.5 MB) must not saturate the hub's event loop. */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { workLedgerFile } from "@wolfpack/kb/shared";
import { createHubServer, type HubServer } from "./server.js";
import { hubRoots } from "./layout.js";
import { OP, seedTokens, workerTokenFor } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

const ID = (n: number) => `work-personal-Q${n.toString(36).padStart(6, "a")}`;

/** ~6,000 events / ~2.5 MB in the real format: 300 items, then notes and stage moves with realistic text. */
function fabricateLedger(dataDir: string): string[] {
  const roots = hubRoots(dataDir);
  const lines: string[] = [];
  const ids: string[] = [];
  const stamp = { by: "wolf-wa", tokenId: "tok-0123456789", hostId: "hA" };
  for (let i = 0; i < 300; i++) {
    const id = ID(i + 1);
    ids.push(id);
    lines.push(JSON.stringify({ type: "work.created", id, at: "2026-10-01 10:00", ...stamp, kind: i % 10 === 0 ? "feature" : "task", domain: "personal", title: `Item ${i} ${"title ".repeat(6)}`, assignee: "wa", area: null, partOf: i % 10 === 0 ? null : ids[i - (i % 10)]!, successCriteria: "criteria ".repeat(20), stage: "plan", container: false }));
  }
  for (let n = 0; lines.length < 6000; n++) {
    const id = ids[n % ids.length]!;
    const at = `2026-10-${String(1 + (n % 28)).padStart(2, "0")} 11:${String(n % 60).padStart(2, "0")}`;
    lines.push(JSON.stringify(n % 7 === 0 ? { type: "work.staged", id, at, ...stamp, to: n % 14 === 0 ? "exec" : "plan" } : { type: "work.noted", id, at, ...stamp, text: `progress note ${n}: ${"lorem ipsum dolor sit amet ".repeat(14)}` }));
  }
  mkdirSync(dirname(workLedgerFile(roots)), { recursive: true });
  appendFileSync(workLedgerFile(roots), lines.join("\n") + "\n");
  return ids;
}

async function rig() {
  const dataDir = mkdtempSync(join(tmpdir(), "hubd-burst-"));
  tmp.push(dataDir);
  seedTokens(dataDir, ["hA"]);
  const ids = fabricateLedger(dataDir);
  const hub = await createHubServer({ dataDir });
  servers.push(hub);
  await fetch(hub.url + "/v1/registry/domains", { method: "POST", headers: { "Content-Type": "application/json", ...OP }, body: JSON.stringify({ name: "personal" }) });
  await fetch(hub.url + "/v1/registry/hosts", { method: "POST", headers: { "Content-Type": "application/json", ...OP }, body: JSON.stringify({ name: "hA" }) });
  await fetch(hub.url + "/v1/registry/wolves", { method: "POST", headers: { "Content-Type": "application/json", ...OP }, body: JSON.stringify({ name: "wa", host: "hA", domains: ["personal"] }) });
  const key = workerTokenFor("hA");
  const get = (path: string) => fetch(`${hub.url}/v1/workapi/work${path}`, { headers: { "X-API-Key": key } });
  return { hub, ids, get, dataDir };
}

describe("work API read burst", () => {
  it("50 parallel item reads on a 6,000-event ledger keep the event loop responsive", async () => {
    const { ids, get } = await rig();
    const one = await get(`/${ids[5]}`);
    expect(one.status).toBe(200);
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    const cpu0 = process.cpuUsage();
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => get(`/${ids[i + 1]}`)));
    await Promise.all(rs.map((r) => r.text()));
    const cpu = process.cpuUsage(cpu0);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    h.disable();
    const maxMs = h.max / 1e6;
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(maxMs).toBeLessThan(500); // wide on purpose: a loaded CI box must not flake; the CPU bound below is what the old code fails
    // Each uncached read re-folds the 6,000-event ledger (~10 ms CPU): 50 reads cost ~500-900 ms. Cached, the burst is HTTP overhead only.
    expect(cpuMs).toBeLessThan(450);
  }, 120_000);
});
