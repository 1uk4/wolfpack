/**
 * registry rendering — project the ledger into per-domain, human-auditable topic
 * maps at `domains/<domain>/_registry.md`. Each lives inside its domain folder,
 * so it rides that domain's Syncthing share to subscribed wolves (the registry
 * is their route — and coverage map — into the KB). Write-only: Dewey always
 * re-derives the registry from the ledger, so this is a pure projection.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWrite } from "@wolfpack/engine";
import {
  type KbRoots,
  type Registry,
  type RegistryTopic,
  domainRegistryFile,
  now,
} from "../shared/index.js";

/** The domain a topic belongs to. The `domain` field is only populated once a
 *  topic crystallizes, so fall back to the canonical id prefix (kb-<domain>-). */
function topicDomain(t: RegistryTopic): string {
  if (t.domain) return t.domain;
  const m = /^kb-([a-z0-9-]+)-[^-]+$/.exec(t.canonicalId);
  return m ? m[1] : "";
}

function renderTopic(t: RegistryTopic): string[] {
  const lines = [
    `## ${t.canonicalId}${t.crystallized ? "" : " _(forming)_"}`,
    "",
    `- domain: ${t.domain || "—"}${t.subcategory ? ` / ${t.subcategory}` : ""}`,
    `- entries: ${t.entries.join(", ") || "—"}`,
    `- subscribers: ${t.subscribers.join(", ") || "—"}`,
    `- aliases:`,
  ];
  for (const a of t.aliases) {
    lines.push(`  - ${a.wolf}:${a.denTopicId} (${a.lastSeen})`);
  }
  lines.push("");
  return lines;
}

/**
 * Render one `_registry.md` per domain from the folded registry. Returns the
 * list of domains written. `alsoDomains` are written even with no topics left
 * (otherwise a domain emptied by retirement keeps its stale registry).
 */
export function renderRegistry(roots: KbRoots, reg: Registry, alsoDomains: string[] = []): string[] {
  const byDomain = new Map<string, RegistryTopic[]>(alsoDomains.map((d) => [d, []]));
  for (const t of reg.values()) {
    const d = topicDomain(t);
    if (!d) continue;
    const bucket = byDomain.get(d);
    if (bucket) bucket.push(t);
    else byDomain.set(d, [t]);
  }

  for (const [domain, topics] of byDomain) {
    topics.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
    const lines: string[] = [
      `# ${domain} — topic registry`,
      "",
      `_Updated: ${now()}_`,
      "",
    ];
    for (const t of topics) lines.push(...renderTopic(t));
    const file = domainRegistryFile(roots, domain);
    mkdirSync(dirname(file), { recursive: true });
    atomicWrite(file, lines.join("\n") + "\n");
  }

  return [...byDomain.keys()];
}
