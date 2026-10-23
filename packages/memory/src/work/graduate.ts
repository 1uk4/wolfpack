/**
 * graduate.ts — graduating finished work into the KB
 *
 * Graduation is manual (`g` in /task, or the durable task_graduate tool) and
 * goes through the SAME route as every other piece of knowledge: the item's
 * plan, Record, Outcomes and tasks are turned into contributions by the normal
 * distill step (with a short graduation framing in its prompt), shown to the
 * owner as a preview, and only then written to the wolf's inbox. Dewey's sweep
 * routes each one by alias or subject check, like any contribution. There are
 * no owned or special entries.
 *
 *   build input   plan (document minus Record/Outcomes) + Record + Outcomes +
 *                 task titles + the parent initiative's title and goal
 *   preview       distill locally; contributions, History lines, warnings
 *   confirm       ship if needed → emit contributions → mark graduated → archive
 *
 * Den topic ids: `work-<domain>-<id>` (the item), `…~<slug>` (splits) and the
 * initiative's own `work-<domain>-<initiativeId>` (a stable alias key).
 */
import { createHash } from "node:crypto";
import type { Engine } from "@wolfpack/engine";
import { isComplete, tryEmitDelta, type WorkItem, type WorkQuery } from "@wolfpack/kb/client";
import { deliveredBullets, mergeDelivered, parseKbNotes, type DeliveredBullet, type KbRoots } from "@wolfpack/kb/shared";
import { distillTopic, type DistilledContribution } from "../distill.js";
import { extractRecord, withoutRecord } from "../work-record.js";
import { outcomesText, totalsText, totalsValues, withoutRollup } from "./rollup.js";

// ════════════════════════════════════════════════════════════════════════════
// 1 · ELIGIBILITY
// ════════════════════════════════════════════════════════════════════════════

const GRADUATABLE_KINDS = ["feature", "initiative", "task", "issue", "spike"];
const STANDALONE_KINDS = ["task", "issue", "spike"];

/**
 * Ready to graduate (shown in /task, triggered with `g` — never automatic):
 *   feature     all its tasks are complete (at least one), not graduated yet
 *   initiative  all its current features have graduated (more can be added
 *               later, so it never completes on its own), not graduated yet,
 *               and not standing (a standing initiative never completes)
 *   task/issue/spike  shipped or live, not graduated yet, and loose: in the
 *               Inbox or without a parent. Tasks inside a real feature
 *               never graduate alone; they go with their feature.
 * Holding containers (the Inbox) never graduate.
 */
export function readyToGraduate(item: WorkItem | undefined, all: WorkItem[]): item is WorkItem {
  if (!item || item.container || item.graduated) return false;
  const kids = all.filter((i) => i.partOf === item.id);
  if (item.kind === "feature") return kids.length > 0 && kids.every(isComplete);
  if (item.kind === "initiative") {
    if (item.standing) return false;
    const features = kids.filter((i) => i.kind === "feature");
    return features.length > 0 && features.every((f) => !!f.graduated);
  }
  if (STANDALONE_KINDS.includes(item.kind)) {
    const parent = item.partOf ? all.find((p) => p.id === item.partOf) : undefined;
    return (!parent || !!parent.container) && isComplete(item);
  }
  return false;
}

/** Check if a work item is eligible for graduation */
export function canGraduate(item: WorkItem): boolean {
  if (item.container) return false;
  if (!isComplete(item)) return false;
  if (!GRADUATABLE_KINDS.includes(item.kind)) return false;
  if (item.graduated) return false;
  return true;
}

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

/** The initiative a feature belongs to (standing ones included), if any. */
export function initiativeOf(feature: WorkItem, all: WorkItem[]): WorkItem | undefined {
  const parent = feature.partOf ? all.find((p) => p.id === feature.partOf) : undefined;
  return parent?.kind === "initiative" ? parent : undefined;
}

// ════════════════════════════════════════════════════════════════════════════
// 2 · THE GRADUATION INPUT
// ════════════════════════════════════════════════════════════════════════════

const WORK_ID = /\bwork-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7}\b/g;
const SECTION_CAP = 8_000;
const MAX_INPUT_CHARS = 28_000;

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n).trimEnd()}\n…(truncated)` : t);

export interface GraduationInput {
  /** What distill reads. */
  text: string;
  /** The graduating item, whose id History lines cite. */
  workId: string;
  /** Totals values that must survive distill. */
  totals: Array<{ key: string; value: string }>;
  /** The initiative whose entry this graduation also updates, if any. */
  initiative?: WorkItem;
}

/**
 * The raw material for distill: the item's plan (its document minus Record and
 * Outcomes), its Record, its Outcomes (and Totals), its tasks, and the parent
 * initiative's title and goal. Work ids other than the item's own are removed.
 */
export function buildGraduationInput(opts: {
  item: WorkItem;
  all: WorkItem[];
  /** The item's working document. */
  body: string;
}): GraduationInput {
  const { item, all } = opts;
  const body = opts.body ?? "";
  const isInitiative = item.kind === "initiative";
  const initiative = isInitiative ? item : initiativeOf(item, all);
  const tasks = all.filter((t) => t.partOf === item.id && t.kind !== "feature");
  const features = isInitiative ? all.filter((f) => f.partOf === item.id && f.kind === "feature") : [];

  const record = extractRecord(body);
  const plan = withoutRollup(withoutRecord(body)).replace(/^#\s+.*\n+/, "").trim();
  const outcomes = outcomesText(body);
  const totals = totalsValues(body);

  // Entries the initiative's earlier graduations already updated (from the link-back notes).
  const siblings = initiative ? all.filter((f) => f.partOf === initiative.id && f.kind === "feature" && f.graduated && f.id !== item.id) : [];
  const known = [...new Set(siblings.flatMap((f) => parseKbNotes(f.log).all))];

  const lines: string[] = [`GRADUATION OF ${item.kind}: ${item.title}`, `WORK ID: ${item.id}`];
  if (item.successCriteria) lines.push(`DONE WHEN: ${item.successCriteria}`);
  if (initiative) {
    lines.push(
      "",
      `INITIATIVE${isInitiative ? " (THIS ITEM: write ONLY the initiative contribution)" : ""}${initiative.standing ? " (standing: never completes)" : isInitiative ? " (COMPLETE)" : ""}: ${initiative.title}`,
      ...(initiative.successCriteria ? [`INITIATIVE GOAL: ${initiative.successCriteria}`] : []),
      ...(known.length ? [`KNOWN ENTRIES (subjects earlier features of this initiative updated): ${known.map((k) => `[[${k}]]`).join(", ")}`] : []),
    );
  }
  if (features.length) {
    lines.push("", "FEATURES DELIVERED:");
    for (const f of features) {
      const kb = parseKbNotes(f.log).all;
      lines.push(`- ${f.title}${f.successCriteria ? ` — ${f.successCriteria}` : ""}${kb.length ? ` (entries: ${kb.map((k) => `[[${k}]]`).join(", ")})` : ""}`);
    }
  }
  if (plan) lines.push("", "PLAN (written before the work; may be outdated, the Record and Outcomes win):", clip(plan, SECTION_CAP));
  if (record) lines.push("", clip(record.replace(/^## Record/, "RECORD:"), SECTION_CAP));
  if (outcomes) lines.push("", "OUTCOMES:", clip(outcomes, SECTION_CAP));
  if (totals.length) {
    lines.push("", "TOTALS (each value must appear unchanged in what you write):", ...totals.map((t) => `- ${t.key}: ${t.value}`));
  } else if (totalsText(body)) {
    lines.push("", "TOTALS:", totalsText(body));
  }
  if (tasks.length) {
    lines.push("", "TASKS:");
    for (const t of tasks) lines.push(`- ${t.title} (${t.stage})${t.successCriteria ? `: ${t.successCriteria}` : ""}`);
  }

  const text = lines.join("\n").replace(WORK_ID, (m) => (m === item.id ? m : "")).replace(/\(\s*\)/g, "");
  return {
    text: clip(text, MAX_INPUT_CHARS),
    workId: item.id as string,
    totals,
    ...(initiative ? { initiative } : {}),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 3 · PREVIEW
// ════════════════════════════════════════════════════════════════════════════

/** The Work API as graduation needs it (the extensions' WorkClient fits). */
export interface GraduationClient {
  query(q?: WorkQuery): Promise<WorkItem[]>;
  getWithBody(id: string): Promise<{ item: WorkItem; body: string | null }>;
  graduate(id: string): Promise<WorkItem>;
  stage(id: string, to: string): Promise<WorkItem>;
  note(id: string, text: string): Promise<WorkItem>;
}

export interface PreviewContribution {
  /** Den topic id it is emitted under. */
  id: string;
  title: string;
  summary: string;
  body: string;
  initiative: boolean;
  /** The `- ` lines of its History section (they carry the work id). */
  history: string[];
}

export interface GraduationPreview {
  itemId: string;
  kind: string;
  title: string;
  domain: string;
  contributions: PreviewContribution[];
  /** Non-blocking: Totals values not carried over, a missing History line… */
  warnings: string[];
  /** Set when distill's output still breaks the knowledge lint: it cannot be sent. */
  blocked?: string;
  /** Items archived by a confirmed graduation (the item first, then what it contains). */
  archive: Array<{ id: string; title: string }>;
  /** Identifies exactly this preview (the durable confirmation token). */
  token: string;
  createdAt: string;
}

/**
 * The initiative entry's `## Delivered` bullets: each graduated feature of the
 * initiative (and the one graduating now) with the entries its link-back notes
 * name. A feature with no notes yet is listed without links.
 */
export function deliveredFor(initiative: WorkItem, item: WorkItem, all: WorkItem[]): DeliveredBullet[] {
  return all
    .filter((f) => f.partOf === initiative.id && f.kind === "feature" && (f.graduated || f.id === item.id))
    .map((f) => ({ title: f.title, links: parseKbNotes(f.log).all }));
}

const historyOf = (body: string): string[] => {
  const at = body.search(/^## History[ \t]*$/m);
  if (at < 0) return [];
  return body.slice(at).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
};

/**
 * Build the graduation input, distill it locally and return what would be
 * sent. Nothing is written anywhere. Throws when the item is not ready.
 */
export async function previewGraduation(opts: {
  client: GraduationClient;
  engine: Engine;
  id: string;
  /** Today (YYYY-MM-DD); tests pin it. */
  today?: string;
  onProgress?: (msg: string) => void;
}): Promise<GraduationPreview> {
  const { client, engine, id } = opts;
  const all = (await client.query({})) ?? [];
  const item = all.find((i) => i.id === id);
  if (!item || !readyToGraduate(item, all)) throw new Error(`${(item as WorkItem | undefined)?.title ?? id} is not ready to graduate`);

  const { body } = await client.getWithBody(id);
  const input = buildGraduationInput({ item, all, body: body ?? "" });
  const isInitiative = item.kind === "initiative";
  opts.onProgress?.(`distilling ${input.text.length} chars…`);
  const r = await distillTopic(engine, {
    id: item.id as string,
    title: item.title,
    summary: item.successCriteria || item.title,
    body: input.text,
    domain: item.domain as string,
    date: opts.today ?? new Date().toISOString().slice(0, 10),
    graduation: {
      workId: input.workId,
      ...(input.initiative ? { initiativeTopicId: input.initiative.id as string, initiativeTitle: input.initiative.title } : {}),
      totals: input.totals,
      ...(isInitiative ? { only: "initiative" as const } : {}),
    },
  });

  const delivered = input.initiative ? deliveredFor(input.initiative, item, all) : [];
  const contributions: PreviewContribution[] = r.outputs.map((o: DistilledContribution) => {
    // The initiative's list of delivered features is built here, not by the model.
    const body = o.initiative ? mergeDelivered(o.body, delivered) : o.body;
    return { id: o.id, title: o.title, summary: o.summary, body, initiative: !!o.initiative, history: historyOf(body) };
  });
  const warnings = [
    ...r.missingTotals.map((m) => `Totals: ${m} is not in the distilled text`),
    ...r.warnings,
    ...r.after.filter((f) => !["commit-hash", "work-id", "test-count", "deploy-status", "dated-heading"].includes(f.code)).map((f) => `lint: ${f.message}`),
  ];
  const blocked = r.heldCodes.length ? `the distilled text still breaks the knowledge lint (${r.heldCodes.join(", ")}); run g again` : undefined;
  const archive = archiveSet(item, all).map((a) => ({ id: a.id as string, title: a.title }));
  const token = createHash("sha256")
    .update(JSON.stringify({ id, c: contributions.map((c) => [c.id, c.body]) }))
    .digest("hex")
    .slice(0, 12);
  return {
    itemId: id,
    kind: item.kind,
    title: item.title,
    domain: item.domain as string,
    contributions,
    warnings,
    ...(blocked ? { blocked } : {}),
    archive,
    token,
    createdAt: new Date().toISOString(),
  };
}

const oneLine = (t: string, n: number) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

/** The preview as text, for the confirm dialog / the agent's reply. */
export function renderGraduationPreview(p: GraduationPreview): string {
  const n = p.contributions.length;
  const out: string[] = [
    `Graduating "${p.title}" (${p.kind}): ${n} contribution${n === 1 ? "" : "s"} for the ${p.domain} knowledge base.`,
    "",
  ];
  p.contributions.forEach((c, i) => {
    out.push(`${i + 1}. ${c.initiative ? "[initiative] " : ""}${c.title}`);
    out.push(`   ${oneLine(c.summary, 280)}`);
    for (const h of c.history) out.push(`   ${oneLine(h, 240)}`);
  });
  if (p.warnings.length) out.push("", "Warnings:", ...p.warnings.map((w) => `- ${w}`));
  if (p.blocked) out.push("", `Cannot send: ${p.blocked}`);
  const rest = p.archive.length - 1;
  out.push(
    "",
    "Dewey routes each contribution to the entry it is about (or creates one). " +
      `Then ${p.kind === "feature" || p.kind === "initiative" ? "it" : "the item"} is marked graduated and archived${rest > 0 ? ` with its ${rest} item(s)` : ""}; history is kept.`,
  );
  return out.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// 4 · CONFIRM
// ════════════════════════════════════════════════════════════════════════════

export interface ConfirmedGraduation {
  /** Den topic ids written to the inbox. */
  sent: string[];
  /** Items archived. */
  archived: string[];
}

/**
 * Send a previewed graduation: ship the item when it is not complete yet,
 * write the contributions to the wolf's inbox, mark the item graduated and
 * archive it with what it contains. Nothing is archived unless every
 * contribution reached the inbox. Throws on failure.
 */
export async function confirmGraduation(opts: {
  client: GraduationClient;
  roots: KbRoots;
  wolf: string;
  preview: GraduationPreview;
  /** Ships an item (the caller's runtime folds it into its feature's Outcomes). */
  ship: (id: string) => Promise<unknown>;
  session?: string;
}): Promise<ConfirmedGraduation> {
  const { client, roots, wolf, preview } = opts;
  if (preview.blocked) throw new Error(`cannot send: ${preview.blocked}`);
  const all = (await client.query({})) ?? [];
  const item = all.find((i) => i.id === preview.itemId);
  if (!item || !readyToGraduate(item, all)) throw new Error(`${(item as WorkItem | undefined)?.title ?? preview.itemId} is no longer ready to graduate`);

  if (!isComplete(item)) {
    await opts.ship(item.id as string);
    await client.note(item.id as string, "Shipped for graduation: all tasks complete.");
  }

  // The initiative's contribution is anchored to its work id (routed by that key
  // alone), so it needs no ordering against the subjects: nothing it says can be
  // merged into a subject, and no subject can merge into it.
  const sent: string[] = [];
  for (const c of preview.contributions) {
    let failure: string | undefined;
    const written = tryEmitDelta(
      {
        roots,
        wolf,
        denTopicId: c.id,
        change: c.initiative ? "merge" : "create",
        ...(c.initiative ? { anchor: c.id } : {}),
        domainHint: preview.domain,
        summary: c.summary,
        body: c.body,
        session: opts.session,
      },
      (why) => { failure = why; },
    );
    if (failure) throw new Error(failure);
    // `written` is null when the same text was sent before (hash guard): it is already in the inbox or swept.
    void written;
    sent.push(c.id);
  }

  await client.graduate(item.id as string);
  const archived: string[] = [];
  for (const a of archiveSet(item, all)) {
    await client.stage(a.id as string, "archived");
    archived.push(a.id as string);
  }
  const rest = archived.length - 1;
  await client.note(item.id as string, `Archived on graduation${rest > 0 ? ` with ${rest} item(s)` : ""}.`);
  return { sent, archived };
}
