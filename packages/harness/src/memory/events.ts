/**
 * Per-den MemoryEvent bus: the harness-side half of the wolf event stream. The memory extension emits metadata-only
 * events (observation captured, topic consolidated, contribution emitted, promote lifecycle); wolfd's server
 * subscribes and fans them out on `GET /v1/wolves/:name/events`. Keyed by den like the actions registry, but
 * get-or-create: createWolfHarness (no HTTP /v1) gets a bus too, and emitting with no subscriber is a no-op.
 */
import { scanSecrets } from "@wolfpack/memory";
import type { MemoryEvent } from "@wolfpack/protocol";

/** An event as emitters write it: the bus stamps `wolf` and `timestamp`. */
export type MemoryEventDraft = MemoryEvent extends infer E ? (E extends unknown ? Omit<E, "wolf" | "timestamp"> : never) : never;

export type MemoryEventListener = (event: MemoryEvent) => void;

export interface MemoryEventBus {
  emit(draft: MemoryEventDraft): void;
  /** Returns the unsubscribe function. */
  subscribe(listener: MemoryEventListener): () => void;
  /** The last promote_finished / promote_failed emitted on this bus, kept even with no subscriber (undefined: none since start). */
  lastPromoteEvent(): MemoryEvent | undefined;
}

// Registry on globalThis (precedent: the memory actions registry in ./actions.ts, also keyed by den): the memory extension and wolfd's server must share one bus per den even when the module is loaded
// twice (source and dist copies, as in the sandbox tests).
const REGISTRY = Symbol.for("wolfpack.memoryEventBuses");
type Bus = MemoryEventBus & { wolf: string; listenerCount(): number };
function getRegistry(): Map<string, Bus> {
  const g = globalThis as Record<symbol, unknown>;
  return (g[REGISTRY] ??= new Map<string, Bus>()) as Map<string, Bus>;
}

/** The bus of this den (created on first use). `wolf` is required so no event goes out unnamed; the first caller's name wins. */
export function memoryEventsFor(wolfDen: string, wolf: string): MemoryEventBus & { listenerCount(): number } {
  const buses = getRegistry();
  let bus = buses.get(wolfDen);
  if (!bus) {
    const listeners = new Set<MemoryEventListener>();
    let lastPromote: MemoryEvent | undefined;
    const created: Bus = {
      wolf,
      listenerCount: () => listeners.size,
      lastPromoteEvent: () => lastPromote,
      emit(draft) {
        const keep = draft.type === "promote_finished" || draft.type === "promote_failed";
        if (listeners.size === 0 && !keep) return;
        const event = { ...draft, wolf: created.wolf, timestamp: new Date().toISOString() } as MemoryEvent;
        if (keep) lastPromote = event;
        for (const l of [...listeners]) {
          try {
            l(event);
          } catch {
            /* a bad subscriber never breaks the emitter */
          }
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    buses.set(wolfDen, created);
    bus = created;
  }
  return bus;
}

/** Drop the den's bus when nobody listens (server close, extension shutdown). A live subscriber keeps it. */
export function disposeMemoryEvents(wolfDen: string): void {
  const buses = getRegistry();
  if (buses.get(wolfDen)?.listenerCount() === 0) buses.delete(wolfDen);
}

/** One line, secrets redacted, capped: the only free text a MemoryEvent may carry. */
export function oneLine(text: string, max = 120): string {
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const line = scanSecrets(first).text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
