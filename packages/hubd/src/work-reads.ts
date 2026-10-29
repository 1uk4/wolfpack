/**
 * Work reads over the hub's ledger, shaped as the protocol's WorkListResponse / WorkRecordResponse. Folds through the kb
 * work-ops (loadWorkState / resolveWorkItem), never a second fold. The shaping mirrors the wolf-side reader in
 * @wolfpack/harness (memory-read.ts), which reads the same shapes over the legacy Work API.
 */
import { loadWorkState, resolveWorkItem } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { RECORD_HEADING, extractRecord, stripSources, withoutRecord } from "@wolfpack/memory";
import type { WorkChild, WorkListItem, WorkListResponse, WorkRecordResponse } from "@wolfpack/protocol";

export const CHILDREN_CAP = 200;
export const LOG_TAIL = 10;

export function listWorkItems(roots: KbRoots, domain: string, includeGraduated: boolean): WorkListResponse {
  const items: WorkListItem[] = [];
  for (const w of loadWorkState(roots).values()) {
    if (w.domain !== domain) continue;
    const graduated = w.graduated ?? undefined;
    if (!includeGraduated && (graduated !== undefined || w.stage === "archived")) continue;
    items.push({
      id: w.id,
      title: w.title,
      kind: w.kind,
      stage: w.stage,
      domain: w.domain,
      partOf: w.partOf ?? null,
      dependsOn: [...w.dependsOn],
      ...(w.assignee ? { assignee: w.assignee } : {}),
      ...(w.created ? { created: w.created } : {}),
      ...(w.standing ? { standing: true } : {}),
      ...(w.container ? { container: true } : {}),
      ...(graduated !== undefined ? { graduated } : {}),
    });
  }
  return { items };
}

/** Undefined when the item is unknown. */
export function readWorkRecordFor(roots: KbRoots, id: string): WorkRecordResponse | undefined {
  const all = loadWorkState(roots);
  const item = all.get(id as never);
  if (!item) return undefined;
  const body = resolveWorkItem(roots, item.domain as string, item.id as string)?.body ?? "";
  const record = extractRecord(body);
  const section = record === null ? null : stripSources(record);
  let children: WorkChild[] | undefined;
  let childCount: number | undefined;
  let truncated = false;
  if (item.kind === "feature" || item.container) {
    const kids: WorkChild[] = [...all.values()]
      .filter((c) => c.partOf === item.id)
      .map((c) => ({ id: c.id, title: c.title, kind: c.kind, stage: c.stage, dependsOn: [...c.dependsOn] }));
    if (item.container) childCount = kids.length;
    else {
      truncated = kids.length > CHILDREN_CAP;
      children = truncated ? kids.slice(0, CHILDREN_CAP) : kids;
    }
  }
  const log = logTail(body);
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    stage: item.stage,
    domain: item.domain,
    partOf: item.partOf ?? null,
    dependsOn: [...item.dependsOn],
    ...(item.container ? { container: true } : {}),
    ...(children ? { children } : {}),
    ...(truncated ? { childrenTruncated: true } : {}),
    ...(childCount !== undefined ? { childCount } : {}),
    ...(item.successCriteria?.trim() ? { successCriteria: item.successCriteria } : {}),
    plan: withoutLog(withoutRecord(body)),
    record: section ? section.slice(RECORD_HEADING.length).trim() : "",
    ...(log.length > 0 ? { log } : {}),
    ...(item.updated ? { updated: item.updated } : {}),
  };
}

function scan(body: string, onLine: (line: string, inLog: boolean) => void): void {
  let fence: string | null = null;
  let inLog = false;
  for (const line of body.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) fence = fence === null ? f[1][0] : f[1][0] === fence ? null : fence;
    else if (fence === null && /^#{1,2} /.test(line)) inLog = /^## Log\s*$/.test(line);
    onLine(line, inLog && fence === null);
  }
}

function withoutLog(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let skipping = false;
  for (const line of body.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) fence = fence === null ? f[1][0] : f[1][0] === fence ? null : fence;
    else if (fence === null && /^#{1,2} /.test(line)) skipping = /^## Log\s*$/.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n").trim();
}

function logTail(body: string): string[] {
  const out: string[] = [];
  scan(body, (line, inLog) => {
    if (inLog && /^- /.test(line)) out.push(line.slice(2).trim());
  });
  return out.slice(-LOG_TAIL);
}
