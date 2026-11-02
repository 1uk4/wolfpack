/**
 * The console's work page data (list rows, record, children), shaped from a Work item + its materialized document.
 * ONE implementation shared by the wolf-side reader (harness memory-read.ts, over the legacy Work API) and hubd (over its
 * ledger fold). The output is structurally the protocol's WorkListItem / WorkRecordResponse / WorkChild.
 */
import { extractRecord, withoutRecord, RECORD_HEADING } from "./work-record.js";
import { stripSources } from "./record-sources.js";

/** A work item as far as the page data needs it (the Work API's JSON or a folded ledger item). */
export interface ShapeWorkItem {
  id: string;
  title?: string;
  kind?: string;
  stage?: string;
  graduated?: boolean | string | null;
  domain?: string;
  partOf?: string | null;
  dependsOn?: string[];
  container?: boolean;
  successCriteria?: string | null;
  updated?: string;
  assignee?: string;
  created?: string;
  standing?: boolean;
}

export interface ShapedWorkChild { id: string; title: string; kind: string; stage: string; dependsOn: string[] }

export interface ShapedWorkListItem {
  id: string;
  title: string;
  kind: string;
  stage: string;
  domain: string;
  partOf: string | null;
  dependsOn: string[];
  assignee?: string;
  created?: string;
  standing?: boolean;
  container?: boolean;
  graduated?: string;
}

export interface ShapedWorkRecord {
  id: string;
  title: string;
  kind: string;
  stage: string;
  domain?: string;
  partOf?: string | null;
  dependsOn?: string[];
  container?: boolean;
  successCriteria?: string;
  plan: string;
  record: string;
  log?: string[];
  updated?: string;
  children?: ShapedWorkChild[];
  childrenTruncated?: boolean;
  childCount?: number;
}

/** Children cap: a feature past it gets the first CHILDREN_CAP and `childrenTruncated`. */
export const CHILDREN_CAP = 200;
/** How many ledger entries the record carries (the newest). */
export const LOG_TAIL = 10;

export function toWorkChild(c: ShapeWorkItem): ShapedWorkChild {
  return { id: c.id, title: c.title ?? "", kind: c.kind ?? "", stage: c.stage ?? "", dependsOn: Array.isArray(c.dependsOn) ? [...c.dependsOn] : [] };
}

/**
 * Visit each line with the current `#`/`##` heading line (null before the first; headings inside code fences do not count)
 * and whether the line sits inside a code fence. The one fence-aware scan behind withoutLog / logTail.
 */
function eachLine(body: string, visit: (line: string, heading: string | null, inFence: boolean) => void): void {
  let fence: string | null = null;
  let heading: string | null = null;
  for (const line of body.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) fence = fence === null ? f[1][0] : f[1][0] === fence ? null : fence;
    else if (fence === null && /^#{1,2} /.test(line)) heading = line;
    visit(line, heading, fence !== null);
  }
}

const isLogHeading = (h: string | null): boolean => h !== null && /^## Log\s*$/.test(h);

/** The document without its generated `## Log` section (the ledger renders it on every read; it is not plan). */
export function withoutLog(body: string): string {
  const out: string[] = [];
  eachLine(body, (line, h) => {
    if (!isLogHeading(h)) out.push(line);
  });
  return out.join("\n").trim();
}

/** The generated `## Log` section's entries ("- **when** — what" lines), the newest LOG_TAIL, oldest first. */
export function logTail(body: string): string[] {
  const out: string[] = [];
  eachLine(body, (line, h, inFence) => {
    if (isLogHeading(h) && !inFence && /^- /.test(line)) out.push(line.slice(2).trim());
  });
  return out.slice(-LOG_TAIL);
}

/** List rows of one domain; graduated and archived items only when `includeGraduated`. */
export function shapeWorkList(items: ShapeWorkItem[], domain: string, includeGraduated: boolean): ShapedWorkListItem[] {
  const out: ShapedWorkListItem[] = [];
  for (const w of items) {
    if (typeof w.id !== "string") continue;
    const graduated = typeof w.graduated === "string" && w.graduated ? w.graduated : w.graduated === true ? "graduated" : undefined;
    if (!includeGraduated && (graduated !== undefined || w.stage === "archived")) continue;
    out.push({
      id: w.id,
      title: w.title ?? "",
      kind: w.kind ?? "",
      stage: w.stage ?? "",
      domain: w.domain ?? domain,
      partOf: w.partOf ?? null,
      dependsOn: Array.isArray(w.dependsOn) ? [...w.dependsOn] : [],
      ...(w.assignee ? { assignee: w.assignee } : {}),
      ...(w.created ? { created: w.created } : {}),
      ...(w.standing ? { standing: true } : {}),
      ...(w.container ? { container: true } : {}),
      ...(graduated !== undefined ? { graduated } : {}),
    });
  }
  return out;
}

/** The record page data. `listed` = the item's direct children when known (undefined: not listed, best effort). */
export function shapeWorkRecord(item: ShapeWorkItem, body: string, listed: ShapedWorkChild[] | undefined): ShapedWorkRecord {
  const record = extractRecord(body);
  const section = record === null ? null : stripSources(record); // the console reads the Record; the sources stay in the document
  // a container (Inbox) can be huge: only its count goes out; a feature's list is capped
  const childCount = item.container && listed ? listed.length : undefined;
  const truncated = !item.container && listed !== undefined && listed.length > CHILDREN_CAP;
  const children = item.container ? undefined : truncated ? listed!.slice(0, CHILDREN_CAP) : listed;
  const log = logTail(body);
  return {
    id: item.id,
    title: item.title ?? "",
    kind: item.kind ?? "",
    stage: item.stage ?? "",
    ...(item.domain !== undefined ? { domain: item.domain } : {}),
    ...(item.partOf !== undefined ? { partOf: item.partOf } : {}),
    ...(item.dependsOn !== undefined ? { dependsOn: item.dependsOn } : {}),
    ...(item.container ? { container: true } : {}),
    ...(children ? { children } : {}),
    ...(truncated ? { childrenTruncated: true } : {}),
    ...(childCount !== undefined ? { childCount } : {}),
    ...(item.successCriteria?.trim() ? { successCriteria: item.successCriteria } : {}),
    plan: withoutLog(withoutRecord(body)),
    record: section ? section.slice(RECORD_HEADING.length).trim() : "",
    ...(log.length > 0 ? { log } : {}),
    ...(item.updated !== undefined ? { updated: item.updated } : {}),
  };
}
