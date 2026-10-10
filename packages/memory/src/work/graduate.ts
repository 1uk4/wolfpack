/**
 * graduate.ts — Graduate completed work items to KB entries
 * 
 * Features and initiatives graduate to KB entries when completed.
 * Tasks don't graduate directly - they embed in their parent feature.
 * 
 * Graduation is a one-way handoff: the wolf sends Dewey a contribution that
 * names the entry it owns; the work item records only the date it graduated.
 */
import { createHash } from "node:crypto";
import { isComplete, type WorkItem } from "@wolfpack/kb/client";

// ════════════════════════════════════════════════════════════════════════════
// 1 · GRADUATION ELIGIBILITY
// ════════════════════════════════════════════════════════════════════════════

const GRADUATABLE_KINDS = ["feature", "initiative"];

/**
 * Ready to graduate (shown in /task, triggered with `g` — never automatic):
 *   feature     all its tasks are complete (at least one), not graduated yet
 *   initiative  all its current features have graduated (more can be added
 *               later, so it never completes on its own), not graduated yet
 * Holding containers (the Inbox) never graduate.
 */
export function readyToGraduate(item: WorkItem | undefined, all: WorkItem[]): item is WorkItem {
  if (!item || item.container || item.graduated) return false;
  const kids = all.filter((i) => i.partOf === item.id);
  if (item.kind === "feature") return kids.length > 0 && kids.every(isComplete);
  if (item.kind === "initiative") {
    const features = kids.filter((i) => i.kind === "feature");
    return features.length > 0 && features.every((f) => !!f.graduated);
  }
  return false;
}

/**
 * Check if a work item is eligible for graduation
 */
export function canGraduate(item: WorkItem): boolean {
  // Holding containers (the Inbox) never graduate
  if (item.container) return false;

  // Must be complete
  if (!isComplete(item)) return false;
  
  // Must be feature or initiative (tasks embed in parent)
  if (!GRADUATABLE_KINDS.includes(item.kind)) return false;
  
  // Must not already be graduated
  if (item.graduated) return false;
  
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// 2 · CONTRIBUTION BUILDING
// ════════════════════════════════════════════════════════════════════════════

export interface GraduationContribution {
  /** Work item id (used as denTopicId for contribution) */
  workId: string;
  /** Domain hint for KB routing */
  domain: string;
  /** Title for the KB entry */
  title: string;
  /** Summary line (≤140 chars) */
  summary: string;
  /** Full body content */
  body: string;

}

/**
 * Build a contribution from a completed work item
 */
export function buildContribution(item: WorkItem, body: string): GraduationContribution {
  return {
    workId: item.id,
    domain: item.domain,
    title: item.title,
    summary: item.summary || deriveSummary(item, body),
    body: cleanBodyForKB(body, item),
  };
}

/**
 * Derive a summary from the work item if not set
 */
function deriveSummary(item: WorkItem, body: string): string {
  // Try to extract first meaningful line from body
  const lines = body.split("\n").filter(l => 
    l.trim() && 
    !l.startsWith("#") && 
    !l.startsWith("-") &&
    l.length > 20
  );
  
  if (lines.length > 0) {
    const first = lines[0].trim();
    return first.length > 140 ? first.slice(0, 137) + "..." : first;
  }
  
  // Fall back to title + kind
  return `${item.kind}: ${item.title}`.slice(0, 140);
}

/**
 * Clean up work item body for KB entry
 * Remove temporal language, in-progress markers, etc.
 */
function cleanBodyForKB(body: string, item: WorkItem): string {
  let cleaned = body;
  
  // TODO: Use LLM to rewrite body for KB (clean prose, no work IDs)
  // For now, basic cleanup only
  
  // Remove "## Implementation Log" header (content stays)
  cleaned = cleaned.replace(/^## Implementation Log\s*\n/gm, "## Implementation\n");
  
  // Remove task completion timestamps (keep content)
  cleaned = cleaned.replace(/_Completed \d{4}-\d{2}-\d{2}_\n/g, "");
  
  // Add metadata header if not present
  if (!cleaned.startsWith("#")) {
    cleaned = `# ${item.title}\n\n${cleaned}`;
  }
  
  // Add success criteria if present
  if (item.successCriteria && !cleaned.includes(item.successCriteria)) {
    cleaned = cleaned.replace(
      /^(# .+\n)/,
      `$1\n**Criteria:** ${item.successCriteria}\n`
    );
  }
  
  return cleaned.trim();
}

// ════════════════════════════════════════════════════════════════════════════
// 2b · GRADUATION CONTRIBUTIONS (what the wolf sends Dewey)
// ════════════════════════════════════════════════════════════════════════════

/**
 * What graduating `item` archives: the item and everything under it that is
 * not archived yet (a feature's tasks; an initiative's remaining children).
 * Archived work leaves /task; its ledger history stays.
 */
export function archiveSet(item: WorkItem, all: WorkItem[]): WorkItem[] {
  const out: WorkItem[] = [];
  const walk = (i: WorkItem) => {
    if (i.stage !== "archived") out.push(i);
    for (const child of all.filter((c) => c.partOf === i.id)) walk(child);
  };
  walk(item);
  return out;
}

/** The KB entry a graduated work item owns: kb-<domain>-<its 7-char id>. */
export function graduationEntryId(item: Pick<WorkItem, "id" | "domain">): string {
  return `kb-${item.domain}-${String(item.id).split("-").pop()}`;
}

/** Work item ids never reach the KB. */
const WORK_ID = /\bwork-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7}\b/g;
const PROCESS_NOTE = /^(Completed\.|Stage: |Shipped( for graduation)?: )/;

/** Max dossier size, so one graduation stays well inside the sweep's budget. */
const MAX_DOSSIER_CHARS = 24_000;

/**
 * The raw material Dewey turns into a past-tense feature entry: the feature's
 * document and, per task, its done-when and latest notes. Work ids and
 * completion stamps are stripped; the graduation prompt removes the rest.
 */
export function featureDossier(
  feature: WorkItem,
  body: string,
  tasks: WorkItem[]
): string {
  const lines = [`# ${feature.title}`, ""];
  if (feature.successCriteria) lines.push(`Goal: ${feature.successCriteria}`, "");
  const doc = body
    .replace(/^#\s+.*\n+/, "") // the document repeats the title
    .replace(/_Completed \d{4}-\d{2}-\d{2}_\n?/g, "")
    .trim();
  if (doc) lines.push("## Feature document", "", doc, "");
  if (tasks.length) {
    lines.push("## What the tasks built", "");
    for (const t of tasks) {
      lines.push(`### ${t.title}`);
      if (t.successCriteria) lines.push(`Done when: ${t.successCriteria}`);
      const notes = (t.log ?? []).map((l) => l.text).filter((n) => !PROCESS_NOTE.test(n)).slice(-3);
      for (const n of notes) lines.push(`- ${n}`);
      lines.push("");
    }
  }
  const out = lines.join("\n").replace(WORK_ID, "").trim();
  return out.length > MAX_DOSSIER_CHARS ? out.slice(0, MAX_DOSSIER_CHARS) + "\n…(truncated)" : out;
}

export interface GraduationFile {
  /** File name for the wolf's ops inbox. */
  name: string;
  content: string;
}

/**
 * Render a graduation contribution for the ops inbox. It names the entry it
 * owns (entry_id), so the KB never needs to interpret work ids.
 */
export function graduationFile(opts: {
  from: string;
  item: Pick<WorkItem, "id" | "domain">;
  graduation: "feature" | "hub";
  body: string;
  final?: boolean;
  submitted: Date;
}): GraduationFile {
  const { from, item, graduation, body, final, submitted } = opts;
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const fm = [
    "---",
    `from: ${from}`,
    `den_topic_id: ${item.id}`,
    `change: create`,
    `content_hash: ${hash}`,
    `prev_hash: null`,
    `domain_hint: ${item.domain}`,
    `origin: wolf`,
    `currency: live`,
    `graduation: ${graduation}`,
    `entry_id: ${graduationEntryId(item)}`,
    ...(final ? ["final: true"] : []),
    `submitted: ${submitted.toISOString()}`,
    "---",
  ];
  return {
    name: `grad-${graduation}-${item.id}-${submitted.getTime()}.md`,
    content: `${fm.join("\n")}\n\n${body}\n`,
  };
}
