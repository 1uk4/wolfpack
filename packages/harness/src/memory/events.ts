/**
 * Per-den MemoryEvent bus: the harness-side half of the wolf event stream. The memory extension emits metadata-only
 * events (observation captured, topic consolidated, contribution emitted, promote lifecycle); wolfd's server
 * subscribes and fans them out on `GET /v1/wolves/:name/events`. Keyed by den like the actions registry, but
 * get-or-create: createWolfHarness (no HTTP /v1) gets a bus too, and emitting with no subscriber is a no-op.
 */
import type { MemoryEvent } from "@wolfpack/protocol";

/** An event as emitters write it: the bus stamps `wolf` and `timestamp`. */
export type MemoryEventDraft = MemoryEvent extends infer E ? (E extends unknown ? Omit<E, "wolf" | "timestamp"> : never) : never;

export type MemoryEventListener = (event: MemoryEvent) => void;

export interface MemoryEventBus {
  emit(draft: MemoryEventDraft): void;
  /** Returns the unsubscribe function. */
  subscribe(listener: MemoryEventListener): () => void;
}

// On globalThis: the memory extension and wolfd's server must share one bus per den even when the module is loaded
// twice (source and dist copies, as in the sandbox tests).
const REGISTRY = Symbol.for("wolfpack.memoryEventBuses");
const buses: Map<string, MemoryEventBus & { wolf: string }> = ((globalThis as Record<symbol, unknown>)[REGISTRY] ??= new Map()) as Map<string, MemoryEventBus & { wolf: string }>;

/** The bus of this den (created on first use). `wolf` names the emitting wolf; the first caller's name wins. */
export function memoryEventsFor(wolfDen: string, wolf?: string): MemoryEventBus {
  let bus = buses.get(wolfDen);
  if (!bus) {
    const listeners = new Set<MemoryEventListener>();
    const created: MemoryEventBus & { wolf: string } = {
      wolf: wolf ?? "",
      emit(draft) {
        if (listeners.size === 0) return;
        const event = { ...draft, wolf: created.wolf, timestamp: new Date().toISOString() } as MemoryEvent;
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
  } else if (wolf && !bus.wolf) {
    bus.wolf = wolf;
  }
  return bus;
}

/** One line, capped: the only free text a MemoryEvent may carry. */
export function oneLine(text: string, max = 120): string {
  const line = (text.split("\n").find((l) => l.trim() !== "") ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
