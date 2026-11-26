/**
 * Activity pipeline cost: ingest (rate limit + checks) -> presence store -> bus -> N SSE subscribers (fake responses, so it measures hub CPU, not sockets).
 * Run: pnpm exec tsx packages/hubd/bench/activity-bench.ts [events=10000] [subscribers=20]
 */
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { createMemoryBus } from "../src/activity/bus.js";
import { createActivityIngest } from "../src/activity/ingest.js";
import { createPresenceStore } from "../src/activity/presence.js";
import { createEventBus } from "../src/events.js";

const N = Number(process.argv[2] ?? 10_000);
const SUBS = Number(process.argv[3] ?? 20);
const bus = createMemoryBus();
const presence = createPresenceStore();
const events = createEventBus();
let bytes = 0;
for (let i = 0; i < SUBS; i++) {
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, writableLength: 0, writeHead() {}, write(s: string) { bytes += s.length; return true; }, end() {}, destroy() {} });
  events.attach(res as unknown as ServerResponse, undefined, { pack: "p", bus });
}
const ingest = createActivityIngest({ bus, presence, pack: "p", wolfOnHost: () => true, ratePerSec: 1e9, burst: 1e9 });
const batch = (i: number) => Array.from({ length: 100 }, (_, j) => ({ v: 1, id: `e${i}-${j}`, pack: "x", ts: Date.now(), ttlMs: 60_000, actor: { kind: "thread", wolf: "w1", threadId: `t${(i * 100 + j) % 500}` }, verb: "thread-active" }));
const batches = Array.from({ length: Math.ceil(N / 100) }, (_, i) => batch(i));
const t0 = process.hrtime.bigint();
let accepted = 0;
for (const b of batches) accepted += ingest.ingest({ tokenId: "t", hostId: "h1", worker: true }, { v: 1, events: b }).accepted;
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(JSON.stringify({ events: accepted, subscribers: SUBS, totalMs: +ms.toFixed(1), msPerEvent: +(ms / accepted).toFixed(4), msPerEventPerSubscriber: +(ms / accepted / SUBS).toFixed(5), mbWritten: +(bytes / 1e6).toFixed(1) }));
presence.stop();
