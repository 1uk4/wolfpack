/**
 * registry rendering — project the ledger into the human-auditable
 * kb-base/registry/topics.md (markdown, git-diffable, read-only to wolves).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWrite } from "@wolfpack/engine";
import { type KbRoots, type Registry, registryFile, now } from "../shared/index.js";

export function renderRegistry(roots: KbRoots, reg: Registry): void {
  const lines: string[] = ["# Topic Registry", "", `_Updated: ${now()}_`, ""];
  const topics = [...reg.values()].sort((a, b) =>
    a.domain.localeCompare(b.domain)
  );

  for (const t of topics) {
    lines.push(
      `## ${t.canonicalId}${t.crystallized ? "" : " _(forming)_"}`,
      "",
      `- domain: ${t.domain || "—"}${t.subcategory ? ` / ${t.subcategory}` : ""}`,
      `- entries: ${t.entries.join(", ") || "—"}`,
      `- subscribers: ${t.subscribers.join(", ") || "—"}`,
      `- aliases:`
    );
    for (const a of t.aliases) {
      lines.push(`  - ${a.wolf}:${a.denTopicId} (${a.lastSeen})`);
    }
    lines.push("");
  }

  const file = registryFile(roots);
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, lines.join("\n") + "\n");
}
