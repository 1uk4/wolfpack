/**
 * The one observation id, shared by the pool, the observations route, Records and the archive.
 *
 * The id is a hash of the entry itself (`recordedAt`, `timestamp`, `content`), so it is the same in every
 * process and on every read. Identical entries get an ordinal in pool order (`<hash>`, `<hash>-1`, …).
 * The ordinal only matters while identical entries sit in the same pool; archived entries keep the id they had.
 */
import { createHash } from "node:crypto";

export interface ObservationIdFields {
  recordedAt?: string;
  timestamp?: string;
  content: string;
}

/** The base id (no ordinal): 16 hex of sha1 over recordedAt, timestamp and content. */
export function observationHash(o: ObservationIdFields): string {
  return createHash("sha1").update(`${o.recordedAt ?? ""}\u0000${o.timestamp ?? ""}\u0000${o.content}`).digest("hex").slice(0, 16);
}

/** Ids for a pool in order, aligned with `pool`: identical entries get `-1`, `-2`, … */
export function observationIds(pool: readonly ObservationIdFields[]): string[] {
  const seen = new Map<string, number>();
  return pool.map((o) => {
    const h = observationHash(o);
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return n === 0 ? h : `${h}-${n}`;
  });
}
