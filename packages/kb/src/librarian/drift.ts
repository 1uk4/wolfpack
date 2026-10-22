/**
 * drift — compare entry files on disk with the ledger.
 *
 * An entry is ledgered if the ledger replays to "written and not since
 * retired". Orphan = file on disk that is not ledgered; missing = ledgered
 * entry whose file is gone. A retired entry is neither: its file was removed
 * on purpose.
 */

/** Ledgered entry ids per domain, in event order (entry_retired removes). */
export function ledgeredByDomain(events: Array<Record<string, unknown>>): Map<string, Set<string>> {
  const live = new Map<string, Set<string>>();
  for (const e of events) {
    if (typeof e.entryId !== "string") continue;
    const m = /^kb-([a-z0-9-]+)-[^-]+$/.exec(e.entryId);
    const domain = m ? m[1] : "?";
    if (e.t === "entry_written") {
      if (!live.has(domain)) live.set(domain, new Set());
      live.get(domain)!.add(e.entryId);
    } else if (e.t === "entry_retired") {
      live.get(domain)?.delete(e.entryId);
    }
  }
  return live;
}

export function driftOf(files: Iterable<string>, ledgered: Set<string>): { orphans: string[]; missing: string[] } {
  const on = new Set(files);
  return {
    orphans: [...on].filter((e) => !ledgered.has(e)),
    missing: [...ledgered].filter((e) => !on.has(e)),
  };
}
