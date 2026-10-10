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
// 2 · GRADUATION CONTRIBUTIONS (what the wolf sends Dewey)
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

/**
 * The raw material for an initiative's hub entry: its goal and document, and
 * the features delivered so far, each with the entry id it graduated to. Only
 * graduated features are listed, never remaining ones (more may be added).
 */
export function hubDossier(initiative: WorkItem, body: string, delivered: WorkItem[]): string {
  const lines = [`# ${initiative.title}`, ""];
  if (initiative.successCriteria) lines.push(`Goal: ${initiative.successCriteria}`, "");
  // Implementation detail belongs to the features' entries, not the hub: drop
  // any "## Implementation Log" the initiative document collected.
  const doc = body
    .replace(/^#\s+.*\n+/, "")
    .replace(/(^|\n)## Implementation Log\n[\s\S]*?(?=\n## |$)/, "$1")
    .trim();
  if (doc) lines.push("## Initiative document", "", doc, "");
  lines.push("## Delivered features", "");
  for (const f of delivered) {
    lines.push(`- [[${graduationEntryId(f)}]] ${f.title}${f.successCriteria ? ` — ${f.successCriteria}` : ""}`);
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
  // The sweep skips content it has seen: a final hub can have the same body as
  // the last update, so "final" is part of what is hashed.
  const hash = createHash("sha256").update(`${graduation}|${final ? "final" : ""}|${body}`).digest("hex").slice(0, 16);
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

/**
 * The contributions graduating `item` sends, in order:
 *   feature under an initiative → its entry, then the initiative's hub (updated
 *                                 to list it; created on the first feature)
 *   standalone feature          → its entry
 *   initiative (completing it)  → its hub, marked final
 * `item` is treated as graduated (it is being graduated now).
 */
export function graduationFiles(opts: {
  item: WorkItem;
  all: WorkItem[];
  bodyOf: (item: WorkItem) => string;
  from: string;
  now: Date;
}): GraduationFile[] {
  const { item, all, bodyOf, from, now } = opts;
  const at = (ms: number) => new Date(now.getTime() + ms);
  const delivered = (initiative: WorkItem) =>
    all.filter((f) => f.partOf === initiative.id && f.kind === "feature" && (f.graduated || f.id === item.id));
  const hub = (initiative: WorkItem, final: boolean, ms: number) =>
    graduationFile({
      from,
      item: initiative,
      graduation: "hub",
      body: hubDossier(initiative, bodyOf(initiative), delivered(initiative)),
      final,
      submitted: at(ms),
    });

  if (item.kind === "initiative") return [hub(item, true, 0)];

  const tasks = all.filter((t) => t.partOf === item.id && t.kind !== "feature");
  const files = [
    graduationFile({ from, item, graduation: "feature", body: featureDossier(item, bodyOf(item), tasks), submitted: at(0) }),
  ];
  const parent = item.partOf ? all.find((p) => p.id === item.partOf) : undefined;
  // The hub is sent after the feature, so Dewey has written the feature entry
  // (and can read its summary) by the time it writes the hub.
  if (parent?.kind === "initiative") files.push(hub(parent, false, 1));
  return files;
}

/** The initiative whose hub a feature's graduation updates, if any. */
export function hubOf(feature: WorkItem, all: WorkItem[]): WorkItem | undefined {
  const parent = feature.partOf ? all.find((p) => p.id === feature.partOf) : undefined;
  return parent?.kind === "initiative" ? parent : undefined;
}
