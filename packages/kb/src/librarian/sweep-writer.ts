/**
 * SweepWriter — the sweep's write hook. Every write the sweep makes (entry, ledger, section tree, index/digest/registry
 * renders, receipts, the processed move, the git commit) goes through one of these methods. The default is today's
 * direct-to-disk code, so a wolf-side or CLI sweep behaves exactly as before. hubd passes its own (packages/hubd/src/curator.ts)
 * to route the KB files through the KB commit path. A method may return a promise; the sweep awaits it.
 *
 * A thrown error from a method is an item error like any other: the contribution stays in its lane (no receipt, no move) and
 * the sweep's normal attempt counting applies.
 */
import { atomicWrite } from "@wolfpack/engine";
import { join } from "node:path";
import type { KbEvent, KbRoots, ParsedContribution, Registry } from "../shared/index.js";
import { entriesDir } from "../shared/index.js";
import type { Entry, Section } from "../schema/knowledge.js";
import { appendLedger } from "./ledger.js";
import { commitEntry, writeReceipt, markProcessed, quarantine, gitCommit } from "./commit.js";
import { writeSections } from "./sections.js";
import { renderDomainIndex, renderDomainDigest } from "./domains.js";
import { renderRegistry } from "./registry.js";
import { syncDelivered } from "./groups.js";

type Maybe<T> = T | Promise<T>;

export interface SweepWriter {
  /** Write a produced entry (new or updated). */
  commitEntry(roots: KbRoots, entry: Entry): Maybe<void>;
  /** Replace an entry's text with `content` (only the code-set source properties moved). */
  patchEntry(roots: KbRoots, domain: string, id: string, content: string): Maybe<void>;
  /** Append events to the KB ledger. */
  appendLedger(roots: KbRoots, events: KbEvent[]): Maybe<void>;
  /** Re-sync a holder's Delivered list (rewrites entries). True when something changed. */
  syncDelivered(roots: KbRoots, domain: string, holderKey: string): Maybe<boolean>;
  /** The section tree snapshot. */
  writeSections(roots: KbRoots, sections: Section[]): Maybe<void>;
  /** INDEX.md and _digest.json of one domain. */
  renderDomain(roots: KbRoots, domain: string): Maybe<void>;
  /** _registry.md of every domain, from the folded registry. */
  renderRegistry(roots: KbRoots, reg: Registry): Maybe<void>;
  writeReceipt(roots: KbRoots, wolf: string, c: ParsedContribution, outcome: string, detail: string, routing?: unknown): Maybe<void>;
  /** Move a handled contribution out of its lane into `_processed/`. */
  markProcessed(c: ParsedContribution): Maybe<void>;
  /** Holding area for a contribution that fits no declared domain. */
  quarantine(roots: KbRoots, c: ParsedContribution, suggestedDomain: string): Maybe<void>;
  /** The one git commit per sweep (best effort). */
  gitCommit(roots: KbRoots, message: string): Maybe<void>;
}

/** Today's behaviour: every write straight to disk. */
export const defaultSweepWriter: SweepWriter = {
  commitEntry: (roots, entry) => commitEntry(roots, entry),
  patchEntry: (roots, domain, id, content) => atomicWrite(join(entriesDir(roots, domain), `${id}.md`), content),
  appendLedger: (roots, events) => appendLedger(roots, events),
  syncDelivered: (roots, domain, key) => syncDelivered(roots, domain, key),
  writeSections: (roots, sections) => writeSections(roots, sections),
  renderDomain: (roots, domain) => {
    renderDomainIndex(roots, domain);
    renderDomainDigest(roots, domain);
  },
  renderRegistry: (roots, reg) => void renderRegistry(roots, reg),
  writeReceipt: (roots, wolf, c, outcome, detail, routing) => writeReceipt(roots, wolf, c, outcome, detail, routing),
  markProcessed: (c) => markProcessed(c),
  quarantine: (roots, c, d) => quarantine(roots, c, d),
  gitCommit: (roots, message) => gitCommit(roots, message),
};
