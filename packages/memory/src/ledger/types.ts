/**
 * Ledger types — the observation buffer.
 * Extracted from OM, stripped of Pi-specific types.
 */

/**
 * A stored observation with computed token count.
 * The timestamp doubles as the unique ID.
 */
export interface Observation {
  timestamp: string;
  content: string;
  tokenCount: number;
}

/**
 * Ledger event: observations recorded by an observer.
 */
export interface ObservationsRecorded {
  type: "observations_recorded";
  observations: Observation[];
  /** The chunk watermark — observations cover content up to this ID */
  coversUpToId: string;
}

/**
 * Ledger event: observations tombstoned after consolidation.
 */
export interface ObservationsDropped {
  type: "observations_dropped";
  observationTimestamps: string[];
  coversUpToId: string;
}

/**
 * Ledger event: cost record from a worker run.
 */
export interface CostRecord {
  type: "cost";
  costUsd: number;
  role: "observer" | "consolidator";
  runId: string;
}

export type LedgerEvent =
  | ObservationsRecorded
  | ObservationsDropped
  | CostRecord;
