/**
 * sweep-alias — the alias route, split out of sweep.ts: a den topic already bound to an entry in the registry.
 */
import type { KbEvent, KbRoots, ParsedContribution } from "../shared/index.js";
import { resolveAliasedEntry } from "./alias.js";
import type { foldRegistry } from "./ledger.js";
import type { RoutingRecord } from "./sweep.js";

export interface AliasLookup {
  aliasedFrom: string | undefined;
  aliasMissing: string | undefined;
  /** The domain to route in: the aliased entry's own domain when it differs from the hint. */
  domain: string;
}

/**
 * An alias is an explicit routing decision: the entry is looked up in ITS OWN domain, even when the contribution's
 * domain hint differs. Sets routing.domainMismatch when it does.
 */
export function lookupAlias(
  roots: KbRoots,
  log: KbEvent[],
  reg: ReturnType<typeof foldRegistry>,
  c: ParsedContribution,
  domain: string,
  routing: RoutingRecord,
  notify?: (msg: string) => void,
): AliasLookup {
  let aliasedFrom: string | undefined;
  let aliasMissing: string | undefined;
  if (!c.anchor) {
    for (const topic of reg.values()) {
      const alias = topic.aliases.find((a) => a.wolf === c.from && a.denTopicId === c.denTopicId);
      if (!alias) continue;
      aliasedFrom = topic.entries[0];
      const hit = aliasedFrom ? resolveAliasedEntry(roots, log, aliasedFrom, topic.domain || domain) : null;
      if (hit) {
        if (hit.followedFrom) notify?.(`sweep: ${c.from}/${c.denTopicId} → alias ${hit.followedFrom} was retired, following it to ${hit.id}`);
        if (hit.domain !== domain) {
          notify?.(`sweep: ${c.from}/${c.denTopicId} → alias ${hit.id} is in domain ${hit.domain}, contribution says ${domain}: merging into the alias`);
          routing.domainMismatch = { hint: domain, entry: hit.domain };
          domain = hit.domain;
        }
        aliasedFrom = hit.id;
      } else {
        aliasMissing = aliasedFrom;
      }
      break;
    }
  }
  return { aliasedFrom, aliasMissing, domain };
}

/**
 * Apply the alias to routing: the target is the head of the aliased entry; a missing alias target warns and falls
 * through to a new entry (returns undefined). Returns the target id, if any.
 */
export function applyAliasRoute(
  alias: Pick<AliasLookup, "aliasedFrom" | "aliasMissing">,
  c: Pick<ParsedContribution, "from" | "denTopicId">,
  routing: RoutingRecord,
  head: (id: string) => string,
  notify?: (msg: string) => void,
): string | undefined {
  const { aliasedFrom, aliasMissing } = alias;
  if (aliasedFrom && !aliasMissing) {
    routing.route = "alias";
    return head(aliasedFrom);
  }
  if (aliasMissing) {
    notify?.(`sweep: ${c.from}/${c.denTopicId} → new entry, WARNING: aliased entry ${aliasMissing} has no file and no survivor`);
    routing.warning = `aliased entry ${aliasMissing} has no file and no survivor`;
  }
  return undefined;
}
