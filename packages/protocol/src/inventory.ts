import { z } from "zod";

/**
 * Pack inventory (work-wolfpack-ZproKxi): every service on every machine reports its version to the hub, which lists them at
 * GET /v1/inventory. workerd reports over the link (`report` frame), consoles by heartbeat, hubd adds itself.
 */

export const INVENTORY_KINDS = ["console", "hubd", "workerd", "wolfd"] as const;
export const InventoryKindSchema = z.enum(INVENTORY_KINDS);
export type InventoryKind = z.infer<typeof InventoryKindSchema>;

export const InventoryEntrySchema = z.object({
  machine: z.string().min(1).max(128),
  kind: InventoryKindSchema,
  id: z.string().min(1).max(64),
  /** The entry this one runs under (a wolfd's workerd host id). */
  parent: z.string().min(1).max(64).optional(),
  version: z.string().min(1).max(64).optional(),
  channel: z.enum(["stable", "main"]).optional(),
  uptimeS: z.number().int().nonnegative().optional(),
  /** Event-loop lag p99, ms. */
  lagMs: z.number().nonnegative().optional(),
  /** Measured round trip of a /healthz probe, ms (only where someone probes: workerd -> wolfd). */
  responseMs: z.number().nonnegative().optional(),
});
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;

/** What the hub lists: the entry plus how long ago it was last reported. */
export type InventoryListed = InventoryEntry & { ageS: number };

export const INVENTORY_MAX_ENTRIES = 128;
export const INVENTORY_MAX_CONSOLES = 64;
export const INVENTORY_REPORT_MAX_BYTES = 4096;
export const WORKERD_REPORT_EVERY_MS = 30_000;
export const CONSOLE_REPORT_EVERY_MS = 15_000;
export const WORKERD_TTL_MS = 90_000;
export const CONSOLE_TTL_MS = 45_000;

/** Body of the machine key ack (work-wolfpack-6EmU8pu): the fingerprint being accepted, so a key that changed again is not accepted blind. */
export const MachineKeyAckBodySchema = z.object({ fingerprint: z.string().min(1).max(128) });

export const InventoryReportBodySchema = z.object({ entry: InventoryEntrySchema });
export interface InventoryResponse {
  entries: InventoryListed[];
  hubMachine: string;
}
