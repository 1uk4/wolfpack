/**
 * Memory actions: consolidate and promote as plain functions on the durable memory extension (pi's /wolf:consolidate
 * and /wolf:promote). The host looks them up by den (memoryActionsFor), as it does the conversation reader; task 10
 * wires them to HTTP routes.
 */
import type { ConsolidationResult } from "@wolfpack/harness/memory";
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
  /** Fold the whole observation pool into session topics (not the den). Serialized with promote and auto-consolidation. */
  consolidate(): Promise<ConsolidationResult>;
  /** Consolidate, then move session topics to the den and on to contribution files in the inbox. Runs in the background. */
  promote(): PromoteStart;
}

const registry = new Map<string, MemoryActions>();

/** The actions of the memory extension running on this den (undefined: memory inert or not started). */
export function memoryActionsFor(wolfDen: string): MemoryActions | undefined {
  return registry.get(wolfDen);
}

export function registerMemoryActions(wolfDen: string, actions: MemoryActions): void {
  registry.set(wolfDen, actions);
}

export function unregisterMemoryActions(wolfDen: string, actions: MemoryActions): void {
  if (registry.get(wolfDen) === actions) registry.delete(wolfDen);
}
