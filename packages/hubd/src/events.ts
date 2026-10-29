/**
 * The hub event bus behind GET /v1/events: mints a monotonic sequence per event, keeps a bounded replay buffer, fans out to
 * open SSE subscribers. `work.changed` is fed from the work writer's append hook; `kb.changed` via `emitKbChanged` (KB commits).
 */
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { HubEvent } from "@wolfpack/protocol";
import type { LedgerEvent } from "./work-writes.js";

export const DEFAULT_EVENT_BUFFER = 1000;
const KEEPALIVE_MS = 20_000;
const MAX_WRITABLE = 1_000_000;

type Body = { [K in HubEvent["type"]]: Omit<Extract<HubEvent, { type: K }>, "id" | "at"> }[HubEvent["type"]];

export function createEventBus(bufferSize = DEFAULT_EVENT_BUFFER) {
  const boot = randomBytes(4).toString("hex");
  const cap = Math.max(1, Math.floor(bufferSize));
  let seq = 0;
  const buffer: HubEvent[] = [];
  const subs = new Set<(e: HubEvent) => void>();
  const streams = new Set<ServerResponse>();

  const emit = (body: Body): HubEvent => {
    const ev = { ...body, id: ++seq, at: new Date().toISOString() } as HubEvent;
    buffer.push(ev);
    if (buffer.length > cap) buffer.shift();
    for (const s of subs) s(ev);
    return ev;
  };

  return {
    boot,
    emit,
    workAppended(events: LedgerEvent[]): void {
      for (const e of events) emit({ type: "work.changed", itemId: e.id, event: e.type });
    },
    /** Hands off to /v1/events subscribers. Called by the KB commit path (later ticket). */
    emitKbChanged(entryIds: string[]): void {
      emit({ type: "kb.changed", entryIds });
    },
    emitWolfPresence(wolf: string, state: "online" | "offline"): void {
      emit({ type: "wolf.presence", wolf, state });
    },
    /** Attach an SSE response. `cursor`: raw Last-Event-ID / ?from= value (undefined = live only). */
    attach(res: ServerResponse, cursor: string | undefined, onClose: (fn: () => void) => void): void {
      let from: number | "stale" | undefined;
      if (cursor) {
        const m = /^([0-9a-f]+):(\d+)$/.exec(cursor);
        from = m && m[1] === boot ? Number(m[2]) : "stale";
      }
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
      const frame = (ev: HubEvent) => {
        if (res.destroyed || res.writableEnded) return;
        if (res.writableLength > MAX_WRITABLE) return void res.destroy();
        res.write(`id: ${boot}:${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
      };
      if (from !== undefined) {
        const cur = from;
        const first = buffer[0]?.id;
        const stale = cur === "stale" || cur > seq || (first === undefined ? cur < seq : cur < first - 1);
        if (stale) frame({ type: "resync", id: seq || 1, at: new Date().toISOString() });
        else for (const e of buffer) if (e.id > (cur as number)) frame(e);
      }
      subs.add(frame);
      streams.add(res);
      res.write(": connected\n\n");
      const ka = setInterval(() => (res.destroyed || res.writableEnded ? gone() : res.write(": ka\n\n")), KEEPALIVE_MS);
      ka.unref();
      function gone() {
        clearInterval(ka);
        subs.delete(frame);
        streams.delete(res);
      }
      onClose(gone);
      res.on("close", gone);
    },
    /** End every open stream (shutdown). */
    closeAll(): void {
      for (const r of [...streams]) r.end();
      streams.clear();
      subs.clear();
    },
  };
}
export type EventBus = ReturnType<typeof createEventBus>;
