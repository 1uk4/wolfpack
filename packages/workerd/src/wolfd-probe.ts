import { request, type ClientRequest, type RequestOptions } from "node:http";
import { performance } from "node:perf_hooks";
import { WORKERD_REPORT_EVERY_MS, type InventoryEntry } from "@wolfpack/protocol";
import type { ChildStatus } from "./supervisor.js";
import { socketOf } from "./socket.js";

const MAX_BODY_BYTES = 64 * 1024;

/** The fields of a wolfd /healthz body the inventory uses. */
interface Probed {
  version?: string;
  uptimeS?: number;
  lagMs?: number;
  responseMs: number;
}

/** GET /healthz on a wolfd (http://host:port or unix:/path), timing the round trip. undefined when it does not answer in time with a 200. */
function probeWolfd(url: string, timeoutMs: number): Promise<Probed | undefined> {
  return new Promise((resolve) => {
    const sock = socketOf(url);
    const t0 = performance.now();
    let done = false;
    let req: ClientRequest | undefined;
    // Overall deadline: the socket idle timeout alone lets a dripping response hold the report forever.
    const deadline = setTimeout(() => finish(undefined), timeoutMs);
    const finish = (v: Probed | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      req?.destroy();
      resolve(v);
    };
    let opts: RequestOptions;
    try {
      opts = sock ? { socketPath: sock, path: "/healthz", timeout: timeoutMs } : { ...hostPort(url), path: "/healthz", timeout: timeoutMs };
    } catch {
      finish(undefined);
      return;
    }
    req = request(opts, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (c: Buffer) => {
        bytes += c.length;
        if (bytes > MAX_BODY_BYTES) return finish(undefined);
        chunks.push(c);
      });
      res.on("end", () => {
        const responseMs = Math.round(performance.now() - t0);
        if (res.statusCode !== 200) return finish(undefined);
        try {
          const b = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { version?: unknown; uptimeS?: unknown; lag?: { p99Ms?: unknown } };
          finish({
            responseMs,
            ...(typeof b.version === "string" && b.version ? { version: b.version.slice(0, 64) } : {}),
            ...(typeof b.uptimeS === "number" && b.uptimeS >= 0 ? { uptimeS: Math.round(b.uptimeS) } : {}),
            ...(typeof b.lag?.p99Ms === "number" && b.lag.p99Ms >= 0 ? { lagMs: Math.round(b.lag.p99Ms) } : {}),
          });
        } catch {
          finish(undefined);
        }
      });
      res.on("error", () => finish(undefined));
    });
    req.on("timeout", () => finish(undefined));
    req.on("error", () => finish(undefined));
    req.end();
  });
}

function hostPort(url: string): { hostname: string; port: number } {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`unsupported scheme ${u.protocol}`);
  return { hostname: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) };
}

export interface InventoryReporterOptions {
  hostId: string;
  machine: string;
  version?: string;
  /** The machine's release channel; undefined when the subscription file cannot be read. */
  channel: () => "stable" | "main" | undefined;
  children: () => ChildStatus[];
  /** Send the report frame. False when the link is not online. */
  send: (entries: InventoryEntry[]) => boolean;
  /** True once the hub's welcome advertised inventory. Nothing is sent before. */
  enabled: () => boolean;
  intervalMs?: number;
  probeTimeoutMs?: number;
}

export interface InventoryReporter {
  /** Probe every wolfd and send one report (no-op while not enabled). */
  report(): Promise<void>;
  stop(): void;
}

/** Reports this workerd and its wolfds to the hub every 30 s and on demand (welcome, wolf add/remove). */
export function createInventoryReporter(o: InventoryReporterOptions): InventoryReporter {
  const timeoutMs = o.probeTimeoutMs ?? 2_000;
  let running: Promise<void> | undefined;
  let again = false;
  async function once(): Promise<void> {
    if (!o.enabled()) return;
    const channel = o.channel();
    const base = { machine: o.machine, ...(channel ? { channel } : {}) };
    const kids = o.children();
    const probed = await Promise.all(kids.map((c) => (c.url && c.state === "online" ? probeWolfd(c.url, timeoutMs) : Promise.resolve(undefined))));
    const entries: InventoryEntry[] = [
      { ...base, kind: "workerd", id: o.hostId, ...(o.version ? { version: o.version } : {}), uptimeS: Math.round(process.uptime()) },
      ...kids.map((c, i): InventoryEntry => ({ ...base, kind: "wolfd", id: c.name, parent: o.hostId, ...probed[i] })),
    ];
    o.send(entries.slice(0, 128));
  }
  const report = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = once()
      .catch(() => {})
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          void report();
        }
      });
    return running;
  };
  const timer = setInterval(() => void report(), o.intervalMs ?? WORKERD_REPORT_EVERY_MS);
  timer.unref();
  return { report, stop: () => clearInterval(timer) };
}
