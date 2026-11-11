import { CONSOLE_TTL_MS, INVENTORY_MAX_CONSOLES, WORKERD_TTL_MS, type InventoryEntry, type InventoryListed } from "@wolfpack/protocol";
import { normaliseMachine } from "@wolfpack/protocol/health-lag";

/**
 * The hub's in-memory pack inventory (work-wolfpack-ZproKxi). Three sources: workerd `report` frames (keyed by link host id, replaced
 * whole by each report, cleared when that host's current link closes), console heartbeats (keyed by machine + id, bound to the token
 * that first wrote them) and hubd's own entry. Nothing is persisted: a restart starts empty and the next reports fill it.
 */
export interface Inventory {
  /** Replace what `hostId` reported. `machine` is the hello machine (overrides each entry's own). Only workerd and wolfd entries are kept. */
  setHost(hostId: string, machine: string | undefined, entries: InventoryEntry[]): void;
  clearHost(hostId: string): void;
  /** A console heartbeat. "invalid": no usable machine; "forbidden": another token owns the row; "full": too many console rows. */
  setConsole(tokenId: string, entry: InventoryEntry): "ok" | "invalid" | "forbidden" | "full";
  list(self: InventoryEntry): InventoryListed[];
}

export function createInventory(now: () => number = Date.now): Inventory {
  const hosts = new Map<string, { at: number; entries: InventoryEntry[] }>();
  const consoles = new Map<string, { at: number; tokenId: string; entry: InventoryEntry }>();
  const expire = () => {
    const t = now();
    for (const [k, v] of hosts) if (t - v.at > WORKERD_TTL_MS) hosts.delete(k);
    for (const [k, v] of consoles) if (t - v.at > CONSOLE_TTL_MS) consoles.delete(k);
  };
  return {
    setHost(hostId, machine, entries) {
      // A hello without a machine (older worker) is not trusted to name one through its entries: drop them.
      const kept: InventoryEntry[] = [];
      if (machine) {
        for (const e of entries) {
          if (e.kind === "workerd" || e.kind === "wolfd") kept.push({ ...e, machine });
        }
      }
      hosts.set(hostId, { at: now(), entries: kept });
    },
    clearHost(hostId) {
      hosts.delete(hostId);
    },
    setConsole(tokenId, entry) {
      expire();
      const machine = normaliseMachine(entry.machine);
      if (!machine) return "invalid";
      const key = `${machine}\u0000${entry.id}`;
      const cur = consoles.get(key);
      if (cur && cur.tokenId !== tokenId) return "forbidden";
      if (!cur && consoles.size >= INVENTORY_MAX_CONSOLES) return "full";
      consoles.set(key, { at: now(), tokenId, entry: { ...entry, machine } });
      return "ok";
    },
    list(self) {
      expire();
      const t = now();
      const out: InventoryListed[] = [{ ...self, ageS: 0 }];
      for (const v of hosts.values()) for (const e of v.entries) out.push({ ...e, ageS: Math.round((t - v.at) / 1000) });
      for (const v of consoles.values()) out.push({ ...v.entry, ageS: Math.round((t - v.at) / 1000) });
      return out;
    },
  };
}
