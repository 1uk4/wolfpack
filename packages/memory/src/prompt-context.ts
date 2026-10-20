/**
 * Prompt context rendering — shared functions for injecting memory context
 * into the system prompt. Used by both Pi-CLI and Pi-durable extensions.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { KbRoots } from "@wolfpack/kb/shared";
import { denTopicStates, describeStatus, type DenTopicState, type DenTopicStatus } from "./den-reconcile.js";

/**
 * Render den topics context for system prompt injection.
 *
 * Lists only den topics the KB has NOT absorbed yet (see den-reconcile.ts);
 * everything else is reachable through kb_access. Returns null when nothing is
 * pending, so the section is omitted. Without KB roots every topic is pending.
 */
export function renderDenContext(
  wolfDen: string,
  wolfName: string,
  kbRoots?: KbRoots,
): string | null {
  try {
    const pending = denTopicStates(wolfDen, kbRoots, wolfName).filter(
      (s): s is DenTopicState & { status: Exclude<DenTopicStatus, { kind: "absorbed" }> } =>
        s.status.kind !== "absorbed",
    );
    if (pending.length === 0) return null;

    const topicsDir = join(wolfDen, "memory", "topics");
    return [
      `Wolf ${wolfName}'s den topics not yet in the shared KB (${pending.length}), in ${topicsDir}/:`,
      ...pending.map(
        ({ topic, status }) =>
          `- ${basename(topic.filePath)} [${describeStatus(status)}] -- ${topic.summary || "(no summary)"}`,
      ),
      "Read a topic file when you need its details. Everything else lives in the KB.",
    ].join("\n");
  } catch {
    return null;
  }
}

type DigestNode = { title?: string; summary?: string; entryIds?: string[]; children?: DigestNode[] };

/** Entries in a section and all its descendants. */
function subtreeEntries(s: DigestNode): number {
  return (s.entryIds?.length ?? 0) + (s.children ?? []).reduce((n, c) => n + subtreeEntries(c), 0);
}

/** Indented section tree: `- Title (N) — summary`, one line per section. */
function renderSectionTree(secs: DigestNode[], depth: number): string {
  let result = "";
  for (const s of secs) {
    const title = (s.title ?? "").replace(/^#+\s*/, "").trim();
    if (!title) continue;
    const summary = (s.summary ?? "").trim();
    result += `\n${"  ".repeat(depth + 1)}- ${title} (${subtreeEntries(s)})${summary ? " — " + summary : ""}`;
    if (s.children?.length) result += renderSectionTree(s.children, depth + 1);
  }
  return result;
}

/**
 * Render KB access context for system prompt injection.
 * Lists subscribed domains with entry counts and Dewey's full section tree
 * (title, entry count, summary per section) from each domain's _digest.json.
 *
 * @param kbBase - Path to knowledge base root
 * @param subscribedDomains - Domain names the wolf is subscribed to (empty = show all)
 */
export function renderKbAccess(
  kbBase: string | undefined,
  subscribedDomains: string[],
): string | null {
  if (!kbBase) return null;

  try {
    const domainsRoot = join(kbBase, "domains");
    if (!existsSync(domainsRoot)) return null;

    // Get domain names - filter by subscription if provided, otherwise show all
    let names: string[];
    if (subscribedDomains.length > 0) {
      names = subscribedDomains
        .filter((name) => existsSync(join(domainsRoot, name)))
        .sort();
    } else {
      names = readdirSync(domainsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name)
        .sort();
    }

    if (names.length === 0) return null;

    const domainOutlines = names.map((name) => {
      const domainDir = join(domainsRoot, name);

      // Count entries
      let entries = 0;
      try {
        const entriesDir = join(domainDir, "entries");
        if (existsSync(entriesDir)) {
          entries = readdirSync(entriesDir).filter((f) => f.endsWith(".md")).length;
        }
      } catch { /* no entries dir */ }

      // Build section tree from digest for wolf navigation
      let sectionTree = "";
      try {
        const digestPath = join(domainDir, "_digest.json");
        if (existsSync(digestPath)) {
          const digest = JSON.parse(readFileSync(digestPath, "utf-8"));
          sectionTree = renderSectionTree(digest.sections ?? [], 0);
        }
      } catch { /* no digest */ }

      const sectionStr = sectionTree ? ":" + sectionTree : "";
      return `- ${name} (${entries} entries)${sectionStr}`;
    });

    return [
      `You have access to ${names.length} shared knowledge domain(s):`,
      ...domainOutlines,
      `(N) = entries in that section. Each domain lives at ${domainsRoot}/<domain>/.`,
      `When a question touches one of these sections, find its entry ids in`,
      `<domain>/_digest.json (sections[].entryIds) or browse <domain>/INDEX.md (every`,
      `entry with title + summary), then read entries/<id>.md on demand.`,
      `Trust entries (authority: curated).`,
    ].join("\n");
  } catch {
    return null;
  }
}
