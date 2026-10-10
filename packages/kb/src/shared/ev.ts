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

  entryRetired: (entryId: string, reason?: string): KbEvent => ({
    t: "entry_retired",
    ...stamp(),
    entryId,
    ...(reason ? { reason } : {}),
  }),

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


  sectionCreated: (f: {
    sectionId: string;
    domain: string;
    parent: string | null;
    label: string;
  }): KbEvent => ({ t: "section_created", ...stamp(), ...f }),

  sectionSplit: (sectionId: string, parentId: string, childIds: string[]): KbEvent => ({
    t: "section_split",
    ...stamp(),
    sectionId,
    parentId,
    childIds,
  }),

  entryPlaced: (f: {
    entryId: string;
    sectionId: string;
    basis: "routed" | "curator-pinned" | "crystallized" | "declared";
    fit: number;
  }): KbEvent => ({ t: "entry_placed", ...stamp(), ...f }),

  sectionCrystallized: (f: {
    sectionId: string;
    parentId: string;
    entryIds: string[];
    cohesion: number;
  }): KbEvent => ({ t: "section_crystallized", ...stamp(), ...f }),
};
