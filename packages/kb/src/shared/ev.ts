/**
 * Event factories — build well-formed ledger events with id + timestamp filled.
 */
import type { KbEvent, RouteKind, EntryAction } from "./schemas/events.js";
import { eventId, now } from "./ids.js";

const stamp = () => ({ id: eventId(), at: now() });

export const ev = {
  contribution: (f: {
    from: string;
    denTopicId: string;
    hash: string;
    prevHash: string | null;
    domainHint: string;
  }): KbEvent => ({ t: "contribution", ...stamp(), ...f }),

  routed: (contribution: string, kind: RouteKind, target?: string): KbEvent => ({
    t: "routed",
    ...stamp(),
    contribution,
    kind,
    target,
  }),

  entryWritten: (
    entryId: string,
    canonicalId: string,
    action: EntryAction
  ): KbEvent => ({ t: "entry_written", ...stamp(), entryId, canonicalId, action }),

  rejected: (contribution: string, reason: string): KbEvent => ({
    t: "rejected",
    ...stamp(),
    contribution,
    reason,
  }),

  aliased: (
    wolf: string,
    denTopicId: string,
    canonicalId: string,
    hash: string
  ): KbEvent => ({ t: "aliased", ...stamp(), wolf, denTopicId, canonicalId, hash }),

  clustered: (
    contribution: string,
    clusterId: string,
    seeded: boolean
  ): KbEvent => ({ t: "clustered", ...stamp(), contribution, clusterId, seeded }),

  crystallized: (f: {
    clusterId: string;
    canonicalId: string;
    domain: string;
    subcategory: string;
  }): KbEvent => ({ t: "crystallized", ...stamp(), ...f }),

  subscribed: (wolf: string, canonicalId: string): KbEvent => ({
    t: "subscribed",
    ...stamp(),
    wolf,
    canonicalId,
  }),

  fed: (wolf: string, canonicalId: string, entryId: string): KbEvent => ({
    t: "fed",
    ...stamp(),
    wolf,
    canonicalId,
    entryId,
  }),
};
