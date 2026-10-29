/**
 * The hub event bus behind GET /v1/events: mints a monotonic sequence per event, keeps a bounded replay buffer, fans out to
 * open SSE subscribers. `work.changed` is fed from the work writer's append hook; `kb.changed` via `emitKbChanged` (KB commits).
 *
 * Wire: `id: <boot>:<seq>` + `data: <HubEvent json>`. A `resync` carries the CURRENT sequence as its id (0 when nothing has been
 * emitted), so storing it as Last-Event-ID resumes exactly after it.
 */
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { HubEvent } from "@wolfpack/protocol";
import { HubError } from "./errors.js";
import type { LedgerEvent } from "./work-writes.js";

export const DEFAULT_EVENT_BUFFER = 1000;
export const DEFAULT_MAX_EVENT_STREAMS = 128;
const KEEPALIVE_MS = 20_000;
const MAX_WRITABLE = 1_000_000;

/** An event before the bus mints its id and timestamp. */
export type HubEventDraft = { [K in HubEvent["type"]]: Omit<Extract<HubEvent, { type: K }>, "id" | "at"> }[Exclude<HubEvent["type"], "resync">];

interface Sub {
  res: ServerResponse;
  send(ev: HubEvent): void;
}

export interface EventBusOptions {
  bufferSize?: number;
  maxStreams?: number;
  /** Resolves a work item id to its domain for `work.changed` (undefined when unknown, e.g. deleted). Called once per batch. */
  domainOf?: (ids: string[]) => Map<string, string>;
}

export function createEventBus(opts: EventBusOptions = {}) {
  const boot = randomBytes(4).toString("hex");
  const cap = Math.max(1, Math.floor(opts.bufferSize ?? DEFAULT_EVENT_BUFFER));
  const maxStreams = Math.max(1, Math.floor(opts.maxStreams ?? DEFAULT_MAX_EVENT_STREAMS));
  let seq = 0;
  const buffer: HubEvent[] = [];
  const subs = new Set<Sub>();
  let closed = false;

  /** Deliver to every subscriber; one that throws loses its stream, never the others (and never the sequence). */
  const fanOut = (ev: HubEvent) => {
    for (const s of [...subs]) {
      try {
        s.send(ev);
      } catch (e) {
        console.error("hubd: event subscriber failed, dropping its stream:", e);
        subs.delete(s);
        s.res.destroy();
      }
    }
  };

  const emit = (draft: HubEventDraft): HubEvent => {
    const ev = { ...draft, id: ++seq, at: new Date().toISOString() } as HubEvent;
    buffer.push(ev);
    if (buffer.length > cap) buffer.shift();
    fanOut(ev);
    return ev;
  };
  const resyncEvent = (): HubEvent => ({ type: "resync", id: seq, at: new Date().toISOString() });

  return {
    boot,
    emit,
    get streamCount(): number {
      return subs.size;
    },
    workAppended(events: LedgerEvent[]): void {
      const domains = opts.domainOf?.(events.map((e) => e.id)) ?? new Map<string, string>();
      for (const e of events) {
        const d = typeof e.domain === "string" ? e.domain : domains.get(e.id);
        emit({ type: "work.changed", itemId: e.id, event: e.type, ...(d ? { domain: d } : {}) });
      }
    },
    /** The ledger diff for a write could not be taken: tell every live client to refetch (not buffered, no sequence minted). */
    broadcastResync(): void {
      fanOut(resyncEvent());
    },
    /** Called by the KB commit path (later ticket). */
    emitKbChanged(entryIds: string[], domain?: string): void {
      emit({ type: "kb.changed", entryIds, ...(domain ? { domain } : {}) });
    },
    emitWolfPresence(wolf: string, state: "online" | "offline", host?: string): void {
      emit({ type: "wolf.presence", wolf, state, ...(host ? { host } : {}) });
    },
    /**
     * Attach an SSE response. `cursor`: raw Last-Event-ID / ?from= value (undefined = live only). Throws `busy` (409, retryable;
     * the protocol has no 429) before writing anything when the stream cap is reached.
     */
    attach(res: ServerResponse, cursor: string | undefined): void {
      if (closed) throw new HubError("busy", "hub is shutting down; retry against the restarted hub");
      if (subs.size >= maxStreams) throw new HubError("busy", `too many open event streams (limit ${maxStreams}); retry later`);
      let from: number | "stale" | undefined;
      if (cursor) {
        const m = /^([0-9a-f]+):(\d+)$/.exec(cursor);
        from = m && m[1] === boot ? Number(m[2]) : "stale";
      }
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
      const send = (ev: HubEvent) => {
        if (res.destroyed || res.writableEnded) return;
        if (res.writableLength > MAX_WRITABLE) return void res.destroy(); // a client that stopped reading
        res.write(`id: ${boot}:${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
      };
      if (from !== undefined) {
        const cur = from;
        const first = buffer[0]?.id;
        if (cur === "stale" || cur > seq || (first === undefined ? cur < seq : cur < first - 1)) send(resyncEvent());
        else for (const e of buffer) if (e.id > cur) send(e);
      }
      const sub: Sub = { res, send };
      // Subscribed in the same tick as the replay was written: no event falls between.
      subs.add(sub);
      res.write(": connected\n\n");
      const ka = setInterval(() => (res.destroyed || res.writableEnded ? gone() : res.write(": ka\n\n")), KEEPALIVE_MS);
      ka.unref();
      function gone() {
        clearInterval(ka);
        subs.delete(sub);
      }
      res.once("close", gone);
    },
    /** End every open stream (shutdown). */
    closeAll(): void {
      closed = true;
      for (const s of [...subs]) s.res.end();
      subs.clear();
    },
  };
}
export type EventBus = ReturnType<typeof createEventBus>;
