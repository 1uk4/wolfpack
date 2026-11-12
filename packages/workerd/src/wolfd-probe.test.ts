import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InventoryEntrySchema, type InventoryEntry } from "@wolfpack/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createInventoryReporter } from "./wolfd-probe.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});
const body = JSON.stringify({ ok: true, service: "wolfd", version: "0.1.15", uptimeS: 120, lag: { p99Ms: 2.4, maxMs: 9 } });
function stub(listen: number | string): Promise<Server> {
  const s = createServer((req, res) => {
    if (req.url === "/healthz") res.writeHead(200, { "Content-Type": "application/json" }).end(body);
    else res.writeHead(404).end();
  });
  cleanup.push(() => s.close());
  return new Promise((r) => s.listen(listen as never, () => r(s)));
}
const child = (name: string, url: string | null) => ({ name, state: "online" as const, pid: 1, url, adopted: false, restarts: 0, failures: 0, nextRestartInMs: null, logFile: "" });

function reporter(children: ReturnType<typeof child>[], over: { enabled?: boolean; keys?: () => InventoryEntry["keys"] } = {}) {
  const sent: InventoryEntry[][] = [];
  const r = createInventoryReporter({
    hostId: "sfo-01-wolves",
    machine: "sfo-01",
    version: "0.1.5",
    channel: () => "main",
    children: () => children,
    send: (entries) => (sent.push(entries), true),
    enabled: () => over.enabled ?? true,
    ...(over.keys ? { keys: over.keys } : {}),
    probeTimeoutMs: 300,
    intervalMs: 3_600_000,
  });
  cleanup.push(() => r.stop());
  return { r, sent };
}

describe("workerd inventory reporter", () => {
  it("reports itself and each wolfd's own version and measured response, over TCP and a unix socket; an unanswering wolf has no version", async () => {
    const tcp = await stub(0);
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    await stub(join(dir, "serve.sock"));
    const port = (tcp.address() as { port: number }).port;
    const { r, sent } = reporter([child("tcpwolf", `http://127.0.0.1:${port}`), child("sockwolf", `unix:${join(dir, "serve.sock")}`), child("deadwolf", "http://127.0.0.1:1"), child("nourl", null)]);
    await r.report();
    const e = sent.at(-1)!;
    expect(e[0]).toEqual({ machine: "sfo-01", kind: "workerd", id: "sfo-01-wolves", version: "0.1.5", channel: "main", uptimeS: expect.any(Number) });
    const wolfd = (id: string) => e.find((x) => x.kind === "wolfd" && x.id === id)!;
    for (const id of ["tcpwolf", "sockwolf"]) {
      expect(wolfd(id)).toMatchObject({ machine: "sfo-01", parent: "sfo-01-wolves", version: "0.1.15", uptimeS: 120, lagMs: 2, channel: "main" });
      expect(typeof wolfd(id).responseMs).toBe("number");
    }
    expect(wolfd("deadwolf").version).toBeUndefined();
    expect(wolfd("deadwolf").responseMs).toBeUndefined();
    expect(wolfd("nourl")).toMatchObject({ parent: "sfo-01-wolves" });
    expect(wolfd("nourl").version).toBeUndefined();
  });

  it("reports per-slot key presence on the workerd entry only, and the entry schema accepts it", async () => {
    const keys = [{ slot: "anthropic", present: true, masked: "••••abcd", source: "pack" as const, shadowsEnv: true }, { slot: "deepgram", present: false }];
    const { r, sent } = reporter([child("nourl", null)], { keys: () => keys });
    await r.report();
    const e = sent.at(-1)!;
    expect(e[0]!.keys).toEqual(keys);
    expect(e[1]!.keys).toBeUndefined();
    expect(InventoryEntrySchema.safeParse(e[0]).success).toBe(true);
  });

  it("gives up on a wolfd that drips its response past the overall deadline, ignores an oversized body, and a non-http url", async () => {
    const drip = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const t = setInterval(() => res.write(" "), 40);
      res.on("close", () => clearInterval(t));
    });
    cleanup.push(() => drip.close());
    await new Promise<void>((r) => drip.listen(0, () => r()));
    const big = createServer((_req, res) => res.writeHead(200).end(JSON.stringify({ version: "9.9.9", pad: "x".repeat(200_000) })));
    cleanup.push(() => big.close());
    await new Promise<void>((r) => big.listen(0, () => r()));
    const p = (s: Server) => (s.address() as { port: number }).port;
    const { r, sent } = reporter([child("drip", `http://127.0.0.1:${p(drip)}`), child("big", `http://127.0.0.1:${p(big)}`), child("ftp", "ftp://127.0.0.1:21")]);
    const t0 = Date.now();
    await r.report();
    expect(Date.now() - t0).toBeLessThan(1_500);
    const e = sent.at(-1)!;
    for (const id of ["drip", "big", "ftp"]) expect(e.find((x) => x.id === id)!.version).toBeUndefined();
  });

  it("sends nothing until the hub's welcome advertised inventory", async () => {
    const { r, sent } = reporter([], { enabled: false });
    await r.report();
    expect(sent).toEqual([]);
  });
});
