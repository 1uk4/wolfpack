/**
 * wolfpack work backfill-feature-stages [--dry-run] [--domain d]
 *
 * One-shot migration for the feature auto-ship rule: every feature whose tasks
 * are all complete (and that has at least one) moves to `shipped`, with the
 * note "auto: all tasks shipped". Runs against whatever WORK_ENDPOINT points
 * at; --dry-run only lists what would move.
 */
import { fetchWorkItems, type WorkItemLite } from "./work-doctor.js";

export interface BackfillOptions {
  dryRun?: boolean;
  domain?: string;
  endpoint?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

const COMPLETE = (s: string) => s === "shipped" || s === "live" || s === "archived";

/** Features that should be `shipped` but are not. */
export function planBackfill(items: WorkItemLite[]): WorkItemLite[] {
  const kids = new Map<string, WorkItemLite[]>();
  for (const i of items) if (i.partOf) kids.set(i.partOf, [...(kids.get(i.partOf) ?? []), i]);
  return items.filter((f) => {
    if (f.kind !== "feature" || f.container || f.standing || f.graduated) return false;
    if (f.stage === "shipped" || f.stage === "live" || f.stage === "archived") return false;
    const k = kids.get(f.id) ?? [];
    return k.length > 0 && k.every((t) => COMPLETE(t.stage));
  });
}

export async function workBackfillFeatureStages(opts: BackfillOptions = {}): Promise<{ moved: string[]; dryRun: boolean }> {
  const endpoint = (opts.endpoint ?? process.env.WORK_ENDPOINT ?? "").replace(/\/$/, "");
  const token = opts.token ?? process.env.WORK_TOKEN ?? "";
  const f = opts.fetchImpl ?? fetch;
  const targets = planBackfill(await fetchWorkItems(opts));
  const dryRun = !!opts.dryRun;
  console.log(`${dryRun ? "Would move" : "Moving"} ${targets.length} feature(s) to shipped at ${endpoint}`);
  const moved: string[] = [];
  for (const t of targets) {
    console.log(`  ${t.id}  ${t.stage} -> shipped  ${t.title}`);
    if (dryRun) continue;
    for (const body of [{ stage: "shipped" }, { note: "auto: all tasks shipped" }]) {
      const res = await f(`${endpoint}/work/${t.id}`, {
        method: "PATCH",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Work API error (${res.status}) updating ${t.id}`);
    }
    moved.push(t.id);
  }
  return { moved, dryRun };
}
