/**
 * alias resolution — an alias is an explicit routing decision, so the entry it
 * names is looked up in ITS OWN domain (the contribution's domain hint may
 * differ), and a retired target is followed to its survivor.
 */
import type { KbEvent } from "../shared/index.js";
import type { KbRoots } from "../shared/index.js";
import { readEntryMarkdown } from "./commit.js";

/** Domain embedded in an entry id (`kb-<domain>-<7id>`), or null. */
export function entryDomain(id: string): string | null {
  const m = /^kb-([A-Za-z0-9-]+?)-[A-Za-z0-9]+$/.exec(id);
  return m ? m[1] : null;
}

/** The survivor a retire reason names ("merged into <id>" / "moved to <id>"). */
function survivorOf(log: KbEvent[], id: string): string | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.t !== "entry_retired" || e.entryId !== id) continue;
    return /\b(?:merged into|moved to)\s+(kb-[A-Za-z0-9-]+)/i.exec(e.reason ?? "")?.[1] ?? null;
  }
  return null;
}

export interface ResolvedAlias {
  id: string;
  domain: string;
  /** Set when the alias pointed at a retired entry and this is its survivor. */
  followedFrom?: string;
}

/** Resolve the entry an alias names to an existing file, or null. */
export function resolveAliasedEntry(
  roots: KbRoots,
  log: KbEvent[],
  aliased: string,
  fallbackDomain: string
): ResolvedAlias | null {
  let id = aliased;
  for (let hops = 0; hops < 5 && id; hops++) {
    const domain = entryDomain(id) ?? fallbackDomain;
    if (readEntryMarkdown(roots, domain, id)) {
      return { id, domain, followedFrom: id === aliased ? undefined : aliased };
    }
    id = survivorOf(log, id) ?? "";
  }
  return null;
}
