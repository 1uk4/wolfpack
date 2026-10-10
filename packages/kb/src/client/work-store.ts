/**
 * work-store — read/write WorkItem files + append work events.
 *
 * WorkItems are stored as markdown files with YAML frontmatter at
 * domains/<domain>/work/<WorkId>.md. The structured state lives in
 * frontmatter; the body holds freeform plan/notes/log prose.
 *
 * The event log (work-events.jsonl) is the source of truth for stage
 * transitions and structured state. The .md files are the materialized
 * view — always re-derivable from the log via foldWork().
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { atomicWrite, parseFrontmatter } from "@wolfpack/engine";
import { type KbRoots, workDir, workLedgerFile } from "../shared/index.js";
import {
  type WorkItem,
  type WorkId,
  WorkEvent,
  parseWorkEvent,
  foldWork,
} from "../schema/work.js";

// ── frontmatter parsing (read) ──────────────────────────────────────────────

export interface ResolvedWorkItem {
  item: WorkItem;
  body: string;
  filePath: string;
}

function parseWorkFrontmatter(raw: string, filePath: string): ResolvedWorkItem | null {
  const { fields, body } = parseFrontmatter(raw);
  if (!fields.id || fields.nodeType !== "work") return null;

  const item: WorkItem = {
    id: fields.id as WorkItem["id"],
    nodeType: "work",
    kind: fields.kind as WorkItem["kind"],
    domain: fields.domain as WorkItem["domain"],
    area: (fields.area as WorkItem["area"]) ?? null,
    title: String(fields.title ?? ""),
    summary: (fields.summary as string) ?? null,
    stage: fields.stage as WorkItem["stage"],
    assignee: fields.assignee as WorkItem["assignee"],
    successCriteria: (fields.successCriteria as string) ?? null,
    partOf: (fields.partOf as WorkItem["partOf"]) ?? null,
    references: asStringArray(fields.references) as WorkItem["references"],
    dependsOn: asStringArray(fields.dependsOn) as WorkItem["dependsOn"],
    blocks: asStringArray(fields.blocks) as WorkItem["blocks"],
    graduatedTo: asStringArray(fields.graduatedTo) as WorkItem["graduatedTo"],
    log: Array.isArray(fields.log) ? (fields.log as WorkItem["log"]) : [],
    created: fields.created as WorkItem["created"],
    updated: fields.updated as WorkItem["updated"],
  };
  return { item, body: body.trim(), filePath };
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return [];
}

// ── read ────────────────────────────────────────────────────────────────────

export function resolveWorkItem(
  roots: KbRoots,
  domain: string,
  id: string,
): ResolvedWorkItem | null {
  const dir = workDir(roots, domain);
  const path = join(dir, `${id}.md`);
  if (!existsSync(path)) return null;
  return parseWorkFrontmatter(readFileSync(path, "utf-8"), path);
}

export function listWorkItems(roots: KbRoots, domain: string): string[] {
  const dir = workDir(roots, domain);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

// ── write (materialized view) ───────────────────────────────────────────────

function yamlStr(s: string): string {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderWorkItem(item: WorkItem, body: string): string {
  const lines: string[] = ["---"];

  lines.push(`id: ${item.id}`);
  lines.push(`nodeType: work`);
  lines.push(`kind: ${item.kind}`);
  lines.push(`domain: ${item.domain}`);
  if (item.area) lines.push(`area: ${item.area}`);
  lines.push(`title: ${yamlStr(item.title)}`);
  if (item.summary) lines.push(`summary: ${yamlStr(item.summary)}`);
  lines.push(`stage: ${item.stage}`);
  lines.push(`assignee: ${item.assignee}`);
  if (item.successCriteria) lines.push(`successCriteria: ${yamlStr(item.successCriteria)}`);
  if (item.partOf) lines.push(`partOf: ${item.partOf}`);

  const refs = item.references ?? [];
  const deps = item.dependsOn ?? [];
  const blks = item.blocks ?? [];
  const grads = item.graduatedTo ?? [];
  
  if (refs.length > 0) {
    lines.push(`references:`);
    for (const r of refs) lines.push(`  - ${r}`);
  }
  if (deps.length > 0) {
    lines.push(`dependsOn:`);
    for (const d of deps) lines.push(`  - ${d}`);
  }
  if (blks.length > 0) {
    lines.push(`blocks:`);
    for (const b of blks) lines.push(`  - ${b}`);
  }
  if (grads.length > 0) {
    lines.push(`graduatedTo:`);
    for (const g of grads) lines.push(`  - ${g}`);
  }

  lines.push(`created: ${item.created}`);
  lines.push(`updated: ${item.updated}`);

  lines.push("---");
  lines.push("");
  lines.push(`# ${item.title}`);
  lines.push("");
  if (body) {
    // Strip any existing title lines that match (from previous buggy commits)
    const titlePattern = new RegExp(`^(# ${item.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n)+`, 'g');
    const cleanBody = body.replace(titlePattern, '').trimStart();
    lines.push(cleanBody);
  } else {
    lines.push("## Plan");
    lines.push("");
    lines.push("## Notes");
    lines.push("");
  }

  if (item.log.length > 0) {
    lines.push("");
    lines.push("## Log");
    lines.push("");
    for (const entry of item.log) {
      lines.push(`- **${entry.at}** — ${entry.text}`);
    }
  }

  return lines.join("\n") + "\n";
}

export function commitWorkItem(
  roots: KbRoots,
  item: WorkItem,
  body: string = "",
): void {
  const dir = workDir(roots, item.domain as string);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, `${item.id}.md`), renderWorkItem(item, body));
}

export function deleteWorkItemFile(roots: KbRoots, item: WorkItem): void {
  const path = join(workDir(roots, item.domain as string), `${item.id}.md`);
  if (existsSync(path)) unlinkSync(path);
}

// ── event ledger (source of truth) ──────────────────────────────────────────

export function readWorkLedger(roots: KbRoots): WorkEvent[] {
  const file = workLedgerFile(roots);
  if (!existsSync(file)) return [];
  const out: WorkEvent[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = parseWorkEvent(JSON.parse(line));
      if (parsed) out.push(parsed);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/**
 * Append events to the work ledger. Every event is validated first and nothing
 * is written if any fails — the reader silently skips invalid lines, so an
 * unvalidated write would leave an orphan event that never folds.
 */
export function appendWorkLedger(roots: KbRoots, events: WorkEvent[]): void {
  if (events.length === 0) return;
  const valid = events.map((e) => {
    const r = WorkEvent.safeParse(e);
    if (!r.success) {
      const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid ${e.type} event for ${e.id} — ${issues}`);
    }
    return r.data;
  });
  const file = workLedgerFile(roots);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, valid.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

export function loadWorkState(roots: KbRoots): Map<WorkId, WorkItem> {
  return foldWork(readWorkLedger(roots));
}
