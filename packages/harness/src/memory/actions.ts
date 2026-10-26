/**
 * Memory actions: consolidate and promote as plain functions on the durable memory extension (pi's /wolf:consolidate
 * and /wolf:promote). Hosts (the createWolfHarness interval timer, task 10's routes) look them up by den
 * (memoryActionsFor), as they do the conversation reader. Lives in the harness so the host can reach it.
 */
import type { ConsolidationResult } from "./consolidation.js";
import type { ConsolidateResult } from "@wolfpack/memory";

export interface PromoteOutcome {
  /** Pool observations consolidated into session topics first (0 when the pool was empty). */
  consolidated: number;
  /** The session → den → inbox result (counts, per-topic details). */
  promoted: ConsolidateResult;
}

export type PromoteStart =
  | { status: "started"; jobId: string; /** Settles when the job finishes; rejects if it failed. */ done: Promise<PromoteOutcome> }
  /** The single-promote guard: a promote is already running, nothing was started. */
  | { status: "already_running"; jobId: string };

export interface MemoryActions {
  /** False when the wolf has no KB roots: promote() rejects, so interval ticks only consolidate. */
  promoteEnabled: boolean;
  /** Fold the whole observation pool into session topics (not the den). Serialized with promote and auto-consolidation. */
  /** True while a promote job runs: a consolidate would queue behind it. */
  isBusy(): boolean;
  consolidate(): Promise<ConsolidationResult>;
  /** Consolidate, then move session topics to the den and on to contribution files in the inbox. Runs in the background. */
  promote(): PromoteStart;
}

// On globalThis, keyed by Symbol.for (as the event buses are): the memory extension and wolfd's server must see one
// registry even when this module is loaded twice (a source and a dist copy each get their own module scope).
const REGISTRY = Symbol.for("wolfpack.memoryActions");
function getRegistry(): Map<string, MemoryActions> {
  const g = globalThis as Record<symbol, unknown>;
  return (g[REGISTRY] ??= new Map<string, MemoryActions>()) as Map<string, MemoryActions>;
}

/** The actions of the memory extension running on this den (undefined: memory inert or not started). */
export function memoryActionsFor(wolfDen: string): MemoryActions | undefined {
  return getRegistry().get(wolfDen);
}

export function registerMemoryActions(wolfDen: string, actions: MemoryActions): void {
  getRegistry().set(wolfDen, actions);
}

export function unregisterMemoryActions(wolfDen: string, actions: MemoryActions): void {
  const registry = getRegistry();
  if (registry.get(wolfDen) === actions) registry.delete(wolfDen);
}
