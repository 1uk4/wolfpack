/**
 * wolfpack work doctor [--domain d] [--json]
 *
 * Read-only work-item hygiene check against the Work API (GET only; endpoint and
 * key from WORK_ENDPOINT / WORK_TOKEN). It never writes: it lists what looks
 * stale or contradicted so the owner can fix it by hand.
 *
 * Groups: stale stages, shipped-not-graduated, live features/initiatives without
 * success criteria, items under archived parents, and a domain × kind × stage
 * count. "Task clearly complete but still open" is not detectable, so it is not
 * checked.
 */
import { c } from "../render.js";

export interface WorkItemLite {
  id: string;
  kind: string;
  domain: string;
  title: string;
  stage: string;
  successCriteria?: string | null;
  partOf?: string | null;
  graduated?: string | null;
  container?: boolean;
  standing?: boolean;
  updated?: string;
}

export interface DoctorOptions {
  domain?: string;
  json?: boolean;
  /** Days an in_build item may sit untouched (default 5). */
  idleDays?: number;
  /** Work API location (tests); default from the environment. */
  endpoint?: string;
  token?: string;
  /** Reference time (tests). */
  now?: Date;
  fetchImpl?: typeof fetch;
}

export interface Finding {
  id: string;
  title: string;
  detail: string;
}

export interface DoctorReport {
  staleStages: Finding[];
  shippedNotGraduated: Finding[];
  missingCriteria: Finding[];
  underArchived: Finding[];
  counts: Record<string, Record<string, Record<string, number>>>;
  total: number;
}

const RANK: Record<string, number> = { idea: 0, plan: 1, feasibility: 2, approved: 3, in_build: 4, shipped: 5, live: 6 };
const COMPLETE = (s: string) => s === "shipped" || s === "live";
const DAY = 86_400_000;

const short = (id: string) => id.replace(/^work-[a-z]+-/, "");
const find = (i: WorkItemLite, detail: string): Finding => ({ id: i.id, title: i.title, detail });

export function analyze(items: WorkItemLite[], opts: { now?: Date; idleDays?: number } = {}): DoctorReport {
  const now = (opts.now ?? new Date()).getTime();
  const idle = opts.idleDays ?? 5;
  const byId = new Map(items.map((i) => [i.id, i]));
  const kids = new Map<string, WorkItemLite[]>();
  for (const i of items) if (i.partOf) kids.set(i.partOf, [...(kids.get(i.partOf) ?? []), i]);

  const staleStages: Finding[] = [];
  for (const p of items) {
    if (p.container || p.stage === "archived" || (p.kind !== "feature" && p.kind !== "initiative")) continue;
    const live = (kids.get(p.id) ?? []).filter((k) => k.stage !== "archived");
    if (live.length === 0) continue;
    const pr = RANK[p.stage] ?? 0;
    const maxChild = Math.max(...live.map((k) => RANK[k.stage] ?? 0));
    if (pr <= RANK.plan! && maxChild >= RANK.in_build!) {
      staleStages.push(find(p, `${p.stage} but has children in progress or done (behind its children)`));
    } else if (p.stage === "in_build" && !p.standing && live.every((k) => COMPLETE(k.stage))) {
      staleStages.push(find(p, `in_build but all ${live.length} children are shipped (behind its children)`));
    } else if (COMPLETE(p.stage) && !p.standing) {
      const open = live.filter((k) => !COMPLETE(k.stage));
      if (open.length) staleStages.push(find(p, `${p.stage} but ${open.length} child(ren) not shipped (ahead of its children)`));
    }
  }
  for (const i of items) {
    if (i.stage !== "in_build" || i.container || !i.updated) continue;
    const age = Math.floor((now - Date.parse(i.updated)) / DAY);
    if (age > idle) staleStages.push(find(i, `in_build, idle ${age} days (last update ${i.updated})`));
  }

  const shippedNotGraduated: Finding[] = [];
  for (const i of items) {
    if (i.stage !== "shipped" || i.graduated || i.container) continue;
    if (i.kind === "feature") shippedNotGraduated.push(find(i, "shipped feature, not graduated"));
    else if (["task", "issue", "spike"].includes(i.kind) && i.partOf && byId.get(i.partOf)?.container) {
      shippedNotGraduated.push(find(i, "lone shipped Inbox item, not graduated"));
    }
  }

  const missingCriteria = items
    .filter((i) => (i.kind === "feature" || i.kind === "initiative") && !i.container && i.stage !== "archived" && !i.successCriteria?.trim())
    .map((i) => find(i, `live ${i.kind} (${i.stage}) has no success criteria`));

  const underArchived: Finding[] = [];
  for (const i of items) {
    const p = i.partOf ? byId.get(i.partOf) : undefined;
    if (p && p.stage === "archived" && i.stage !== "archived") underArchived.push(find(i, `${i.stage} under archived parent ${short(p.id)} "${p.title}"`));
  }

  const counts: DoctorReport["counts"] = {};
  for (const i of items) {
    const d = ((counts[i.domain] ??= {})[i.kind] ??= {});
    d[i.stage] = (d[i.stage] ?? 0) + 1;
  }
  return { staleStages, shippedNotGraduated, missingCriteria, underArchived, counts, total: items.length };
}

export function formatDoctor(r: DoctorReport): string {
  const out: string[] = [];
  let n = 0;
  const group = (title: string, list: Finding[]) => {
    out.push("", c.bold(`${title} (${list.length})`));
    if (!list.length) out.push("  none");
    for (const f of list) out.push(`  ${++n}. ${short(f.id)}  ${f.title.slice(0, 70)}\n       ${f.detail}`);
  };
  group("Stale stages", r.staleStages);
  group("Shipped, not graduated", r.shippedNotGraduated);
  group("Live features/initiatives without success criteria", r.missingCriteria);
  group("Items under archived parents", r.underArchived);
  out.push("", c.bold(`Counts (${r.total} items)`));
  for (const [dom, kinds] of Object.entries(r.counts).sort()) {
    for (const [kind, stages] of Object.entries(kinds).sort()) {
      out.push(`  ${dom} ${kind}: ` + Object.entries(stages).map(([s, k]) => `${s} ${k}`).join(", "));
    }
  }
  return out.join("\n").replace(/^\n/, "");
}

export async function fetchWorkItems(opts: DoctorOptions): Promise<WorkItemLite[]> {
  const endpoint = (opts.endpoint ?? process.env.WORK_ENDPOINT ?? "").replace(/\/$/, "");
  const token = opts.token ?? process.env.WORK_TOKEN ?? "";
  if (!endpoint || !token) throw new Error("Work API not configured (set WORK_ENDPOINT and WORK_TOKEN)");
  const qs = opts.domain ? `?domain=${encodeURIComponent(opts.domain)}` : "";
  const res = await (opts.fetchImpl ?? fetch)(`${endpoint}/work${qs}`, { headers: { "x-api-key": token } });
  if (!res.ok) throw new Error(`Work API error (${res.status})`);
  return ((await res.json()) as { items: WorkItemLite[] }).items;
}

export async function workDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const report = analyze(await fetchWorkItems(opts), opts);
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
  return report;
}
