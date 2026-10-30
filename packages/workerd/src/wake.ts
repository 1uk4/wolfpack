/** Wake / network-change detection: wall-clock gaps (a sleeping process misses its interval) and a polled hash of the interfaces. */
import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";

export interface WakeOptions {
  onWake: (reason: "wake" | "network") => void;
  /** Gap detector tick. Default 5000. */
  intervalMs?: number;
  /** A tick later than intervalMs + this means the machine slept. Default 15000 - 5000 (i.e. a gap > 15s). */
  gapMs?: number;
  /** Network poll. Default 5000. */
  netPollMs?: number;
  now?: () => number;
  netHash?: () => string;
}

/** Virtual / transient interfaces that change constantly without the machine's connectivity changing. */
const NOISY_IFACE = /^(awdl|llw|utun|bridge|docker|veth|vmnet|vboxnet|lo)\d*/i;

export function networkHash(): string {
  const parts: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces()).sort(([a], [b]) => a.localeCompare(b))) {
    if (NOISY_IFACE.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      const v6 = a.family === "IPv6";
      if (v6 && /^fe[89ab]/i.test(a.address)) continue; // link-local
      parts.push(`${name}|${a.family}|${a.address}`);
    }
  }
  return createHash("sha1").update(parts.sort().join("\n")).digest("hex");
}

/** Start monitoring; returns stop(). Timers are unref'd. `tick()`/`poll()` are exposed for tests. */
export function startWakeMonitor(o: WakeOptions): { stop(): void; tick(): void; poll(): void } {
  const interval = o.intervalMs ?? 5000;
  const gap = o.gapMs ?? 15_000;
  const now = o.now ?? Date.now;
  const hash = o.netHash ?? networkHash;
  let last = now();
  let net = hash();
  const tick = () => {
    const t = now();
    const slept = t - last > gap;
    last = t;
    if (slept) o.onWake("wake");
  };
  const poll = () => {
    const h = hash();
    if (h !== net) {
      net = h;
      o.onWake("network");
    }
  };
  const a = setInterval(tick, interval);
  const b = setInterval(poll, o.netPollMs ?? 5000);
  a.unref();
  b.unref();
  return { stop: () => (clearInterval(a), clearInterval(b)), tick, poll };
}
