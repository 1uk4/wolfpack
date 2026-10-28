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

// ─── Graduation ──────────────────────────────────────────────────────────────
// The wolf's tasks extension owns the Work client, the KB roots and the model for graduation; wolfd's routes reach them
// through this registry (same globalThis trick as the memory actions).

/** Why a graduation was refused, mapped by the server to an error code. */
export type GraduationFailure =
  /** The item is not ready (the message says why). */
  | "not_ready"
  /** The preview token is unknown, used, expired or for another item. */
  | "preview_stale"
  /** No Work API, no KB roots or no model on this wolf. */
  | "unavailable"
  /** The drain/distill/write failed; nothing was archived. */
  | "failed";

export class GraduationError extends Error {
  readonly name = "GraduationError";
  constructor(readonly code: GraduationFailure, message: string) {
    super(message);
  }
}

/** The preview as the wire carries it (GraduationPreview in the protocol). */
export interface GraduationPreviewResult {
  itemId: string;
  kind: string;
  title: string;
  domain: string;
  contributions: Array<{ id: string; title: string; summary: string; body: string; initiative: boolean; history: string[]; target?: string; feature?: boolean }>;
  foldedObservations: number;
  warnings: string[];
  blocked?: string;
  archive: Array<{ id: string; title: string }>;
  token: string;
  createdAt: string;
  readiness: { ready: boolean; reason?: string };
}

export interface GraduationConfirmResult {
  entries: string[];
  archived: string[];
  lateFolded: number;
  /** Conversations unbound from the item and its tasks. */
  unbound: number;
}

export interface GraduationActions {
  /** Distill and return the preview (writes the confirmation token). Throws GraduationError. */
  preview(id: string): Promise<GraduationPreviewResult>;
  /** Check the token, fold late observations, send, graduate, archive, unbind. All or nothing. Throws GraduationError. */
  confirm(id: string, token: string): Promise<GraduationConfirmResult>;
}

const GRADUATION_REGISTRY = Symbol.for("wolfpack.graduationActions");
function getGraduationRegistry(): Map<string, GraduationActions> {
  const g = globalThis as Record<symbol, unknown>;
  return (g[GRADUATION_REGISTRY] ??= new Map<string, GraduationActions>()) as Map<string, GraduationActions>;
}

export function graduationActionsFor(wolfDen: string): GraduationActions | undefined {
  return getGraduationRegistry().get(wolfDen);
}
export function registerGraduationActions(wolfDen: string, actions: GraduationActions): void {
  getGraduationRegistry().set(wolfDen, actions);
}
export function unregisterGraduationActions(wolfDen: string, actions: GraduationActions): void {
  const r = getGraduationRegistry();
  if (r.get(wolfDen) === actions) r.delete(wolfDen);
}
