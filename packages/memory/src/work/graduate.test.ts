/**
 * Graduation: input → distill (mocked engine) → preview → confirm. A local
 * fake Work API (in-memory) and temp dirs; nothing leaves the process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import type { WorkItem } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import {
  archiveSet,
  buildGraduationInput,
  confirmGraduation,
  previewGraduation,
  readyToGraduate,
  renderGraduationPreview,
  type GraduationClient,
} from "./graduate.js";

let n = 0;
const w = (kind: string, title: string, partOf: string | null, extra: Record<string, unknown> = {}) =>
  ({
    id: `work-wp-${kind.slice(0, 3)}${String(++n).padStart(4, "0")}`.slice(0, 7 + 8),
    kind, title, partOf, domain: "wp", stage: "shipped", successCriteria: null,
    log: [], dependsOn: [], graduated: null, container: false, ...extra,
  }) as unknown as WorkItem;

const PLAN = "# F\n\n## Plan\n\nUse two panes. See work-wp-zzz9999.\n\n";
const RECORD = "## Record\n\n### Decisions\n\n- Cache in the client — why: round trips dominate.\n";
const OUTCOMES = "## Outcomes\n\n<!-- rollup:children -->\n<!-- rollup:item id=t1 when=2026-10-15 -->\n- Add cache, shipped 2026-10-15\n<!-- /rollup:item -->\n<!-- /rollup:children -->\n";

describe("buildGraduationInput", () => {
  const init = w("initiative", "Dockerize", null, { successCriteria: "Everything runs in containers" });
  const earlier = w("feature", "Base image", init.id, { graduated: "2026-10-01", log: [{ at: "x", text: "KB: created kb-wp-AAAAAAA" }, { at: "x", text: "KB: updated kb-wp-BBBBBBB" }] });
  const f = w("feature", "Compose", init.id, { successCriteria: "compose up works" });
  const t1 = w("task", "Write compose file", f.id, { successCriteria: "file exists" });
  const all = [init, earlier, f, t1];

  it("has the plan without Record/Outcomes, the Record, the Outcomes, the tasks and the initiative's title and goal", () => {
    const { text, workId, initiative } = buildGraduationInput({ item: f, all, body: PLAN + RECORD + "\n" + OUTCOMES });
    expect(workId).toBe(f.id);
    expect(initiative?.id).toBe(init.id);
    expect(text).toContain(`GRADUATION OF feature: Compose`);
    expect(text).toContain(`WORK ID: ${f.id}`);
    expect(text).toContain("INITIATIVE: Dockerize");
    expect(text).toContain("INITIATIVE GOAL: Everything runs in containers");
    const plan = text.slice(text.indexOf("PLAN"), text.indexOf("RECORD:"));
    expect(plan).toContain("Use two panes.");
    expect(plan).not.toContain("Cache in the client");
    expect(plan).not.toContain("Add cache, shipped");
    expect(text).toContain("RECORD:\n\n### Decisions\n\n- Cache in the client — why: round trips dominate.");
    expect(text).toContain("OUTCOMES:\n- Add cache, shipped 2026-10-15");
    expect(text).not.toContain("rollup:");
    expect(text).toContain("- Write compose file (shipped): file exists");
    // other work ids are stripped; only the item's own stays
    expect(text).not.toContain("work-wp-zzz9999");
    // entries earlier features of the initiative updated (the link-back), for wikilinks
    expect(text).toContain("KNOWN ENTRIES");
    expect(text).toContain("[[kb-wp-AAAAAAA]], [[kb-wp-BBBBBBB]]");
  });

  it("Totals values are listed for the check; a loose Inbox task has no initiative", () => {
    const body = '# F\n\n## Totals\n<!-- rollup:totals keys="Sets,Volume" -->\n- Sessions: **2**\n- Sets: **44**\n- Volume: **34,843 lb**\n<!-- /rollup:totals -->\n';
    const r = buildGraduationInput({ item: f, all, body });
    expect(r.totals).toEqual([{ key: "Sessions", value: "2" }, { key: "Sets", value: "44" }, { key: "Volume", value: "34,843 lb" }]);
    expect(r.text).toContain("- Volume: 34,843 lb");
    const inbox = w("feature", "Inbox", null, { container: true });
    const stray = w("task", "Fix typo", inbox.id);
    const s = buildGraduationInput({ item: stray, all: [inbox, stray], body: "# T\n\nx\n\n" + RECORD });
    expect(s.initiative).toBeUndefined();
    expect(s.text).not.toContain("INITIATIVE");
    expect(s.text).toContain("RECORD:");
  });

  it("an initiative's own input lists its delivered features with their entries and says THIS ITEM", () => {
    const g = { ...f, graduated: "2026-10-05", log: [{ at: "x", text: "KB: created kb-wp-CCCCCCC" }] } as WorkItem;
    const r = buildGraduationInput({ item: init, all: [init, earlier, g], body: "# Dockerize\n\n## Plan\n\nContainerise.\n" });
    expect(r.text).toContain("INITIATIVE (THIS ITEM: write ONLY the initiative contribution) (COMPLETE): Dockerize");
    expect(r.text).toContain("- Base image");
    expect(r.text).toContain("[[kb-wp-CCCCCCC]]");
  });
});

// ── fake Work API + mock engine ──────────────────────────────────────────────

function fakeClient(items: WorkItem[], bodies: Record<string, string>) {
  const calls: string[] = [];
  const client: GraduationClient = {
    query: async () => items,
    getWithBody: async (id) => ({ item: items.find((i) => i.id === id)!, body: bodies[id] ?? null }),
    graduate: async (id) => { calls.push(`graduate ${id}`); const it = items.find((i) => i.id === id)!; (it as any).graduated = "2026-10-22"; return it; },
    stage: async (id, to) => { calls.push(`stage ${id} ${to}`); const it = items.find((i) => i.id === id)!; (it as any).stage = to; return it; },
    note: async (id, text) => { calls.push(`note ${id} ${text}`); return items.find((i) => i.id === id)!; },
  };
  return { client, calls };
}

const answer = (workId: string, over: Record<string, unknown>[] = []) => ({
  contributions: [
    { slug: "compose-stack", title: "Compose stack", summary: "The stack runs with compose up.", body: `## How\n\nOne compose file.\n\n## History\n\n- 2026-10-22: moved the stack to compose, because one command is easier (${workId})` },
    { slug: "initiative", initiative: true, title: "Dockerize", summary: "Everything runs in containers.", body: `## Scope\n\nContainers.\n\n## History\n\n- 2026-10-22: compose stack delivered` },
    ...over,
  ],
});

function engineOf(...answers: unknown[]) {
  let i = 0;
  const call = vi.fn(async (_step: string, schema: { parse: (v: unknown) => unknown }) => schema.parse(answers[Math.min(i++, answers.length - 1)]));
  return { engine: { call, usage: { summarize: () => ({}) } } as unknown as Engine, call };
}

describe("graduation: preview then confirm", () => {
  let dir: string;
  let roots: KbRoots;
  const inbox = () => join(roots.opsRoot, "inbox", "owner");
  const sentTopics = () => (existsSync(inbox()) ? readdirSync(inbox()) : []).map((f) => /den_topic_id: (\S+)/.exec(readFileSync(join(inbox(), f), "utf8"))![1]).sort();
  let init: WorkItem, f: WorkItem, t1: WorkItem, t2: WorkItem;

  beforeEach(() => {
    n = 0;
    dir = mkdtempSync(join(tmpdir(), "grad-"));
    roots = { kbBase: join(dir, "kb"), opsRoot: join(dir, "ops"), denLocal: join(dir, "den") };
    init = w("initiative", "Dockerize", null, { successCriteria: "Everything runs in containers", stage: "in_build" });
    f = w("feature", "Compose", init.id, { successCriteria: "compose up works", stage: "in_build" });
    t1 = w("task", "Write compose file", f.id);
    t2 = w("task", "Add healthchecks", f.id);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("preview distills locally and sends nothing; cancel (never confirming) changes nothing", async () => {
    const { client, calls } = fakeClient([init, f, t1, t2], { [f.id]: PLAN + RECORD });
    const { engine, call } = engineOf(answer(f.id));
    const p = await previewGraduation({ client, engine, id: f.id as string, today: "2026-10-22" });
    expect(call).toHaveBeenCalledTimes(1);
    expect((call.mock.calls[0] as any)[2].system).toContain("GRADUATION INPUT"); // the framing, same distill step
    expect(p.contributions.map((c) => c.id)).toEqual([f.id, init.id]); // item first, then the initiative's stable topic
    expect(p.contributions[1].initiative).toBe(true);
    expect(p.contributions[0].history).toEqual([`- 2026-10-22: moved the stack to compose, because one command is easier (${f.id})`]);
    // the initiative's History line had no citation: code added it
    expect(p.contributions[1].history[0]).toBe(`- 2026-10-22: compose stack delivered (${f.id})`);
    expect(p.warnings).toEqual([]);
    expect(p.archive.map((a) => a.id)).toEqual([f.id, t1.id, t2.id]);

    const text = renderGraduationPreview(p);
    expect(text).toContain('Graduating "Compose" (feature): 2 contributions for the wp knowledge base.');
    expect(text).toContain("1. Compose stack\n   The stack runs with compose up.\n   - 2026-10-22: moved the stack");
    expect(text).toContain("2. [initiative] Dockerize");
    expect(text).toContain("archived with its 2 item(s)");

    // cancel = the caller never confirms: nothing was written or changed
    expect(calls).toEqual([]);
    expect(sentTopics()).toEqual([]);
  });

  it("confirm writes the contributions under work-<d>-<id>, the initiative's topic and splits, then graduates and archives", async () => {
    const items = [init, f, t1, t2];
    const { client, calls } = fakeClient(items, { [f.id]: PLAN + RECORD });
    const extra = { slug: "Compose Healthchecks", title: "Healthcheck policy", summary: "Every service has one.", body: `## Rule\n\nAlways.\n\n## History\n\n- 2026-10-22: added (${f.id})` };
    const p = await previewGraduation({ client, engine: engineOf(answer(f.id, [extra])).engine, id: f.id as string, today: "2026-10-22" });
    const ship = vi.fn(async () => {});
    const done = await confirmGraduation({ client, roots, wolf: "owner", preview: p, ship });
    expect(sentTopics()).toEqual([f.id, `${f.id}~compose-healthchecks`, init.id].sort());
    expect(done.archived).toEqual([f.id, t1.id, t2.id]);
    expect(calls).toContain(`graduate ${f.id}`);
    expect(calls).toContain(`stage ${t1.id} archived`);
    expect(calls.some((c) => c.startsWith(`note ${f.id} Archived on graduation with 2 item(s)`))).toBe(true);
    expect(ship).toHaveBeenCalledWith(f.id); // the feature itself was still in_build: shipped on confirm
    // the subjects are submitted before the initiative's entry (the sweep takes the oldest first)
    const submitted = (topic: string) => /submitted: (.+)/.exec(readFileSync(join(inbox(), readdirSync(inbox()).find((x) => new RegExp(`^${topic}-[0-9a-f]+\\.md$`).test(x))!), "utf8"))![1];
    expect(submitted(f.id as string) < submitted(init.id as string)).toBe(true);
    // the files carry no frontmatter graduation markers: ordinary contributions
    const file = readdirSync(inbox()).map((x) => readFileSync(join(inbox(), x), "utf8")).join("\n");
    expect(file).not.toMatch(/graduation:|entry_id:|preserve_body:|part_of:/);
  });

  it("a forgotten initiative flag is recovered by slug or title; a missing initiative contribution is asked for once", async () => {
    const { client } = fakeClient([init, f, t1, t2], { [f.id]: PLAN });
    const noFlag = answer(f.id);
    delete (noFlag.contributions[1] as any).initiative; // slug "initiative" stays
    const p1 = await previewGraduation({ client, engine: engineOf(noFlag).engine, id: f.id as string, today: "2026-10-22" });
    expect(p1.contributions.map((c) => [c.id, c.initiative])).toEqual([[f.id, false], [init.id, true]]);

    const byTitle = answer(f.id);
    Object.assign(byTitle.contributions[1], { slug: "overview", title: "Dockerize" });
    delete (byTitle.contributions[1] as any).initiative;
    const p2 = await previewGraduation({ client, engine: engineOf(byTitle).engine, id: f.id as string, today: "2026-10-22" });
    expect(p2.contributions.map((c) => c.id)).toEqual([f.id, init.id]);

    const none = { contributions: [answer(f.id).contributions[0]] };
    const { engine, call } = engineOf(none, answer(f.id));
    const p3 = await previewGraduation({ client, engine, id: f.id as string, today: "2026-10-22" });
    expect(call).toHaveBeenCalledTimes(2);
    expect((call.mock.calls[1] as any)[2].prompt).toContain("the INITIATIVE contribution is missing");
    expect(p3.contributions.map((c) => c.id)).toEqual([f.id, init.id]);
    const stillNone = await previewGraduation({ client, engine: engineOf(none).engine, id: f.id as string, today: "2026-10-22" });
    expect(stillNone.warnings).toContain("no initiative entry was produced");
  });

  it("an Inbox task graduates alone: no initiative contribution", async () => {
    const inboxItem = w("feature", "Inbox", null, { container: true });
    const stray = w("task", "Fix the typo", inboxItem.id, { successCriteria: "typo fixed" });
    const { client } = fakeClient([inboxItem, stray], { [stray.id]: "# Fix the typo\n\nplan\n\n" + RECORD });
    expect(readyToGraduate(stray, [inboxItem, stray])).toBe(true);
    const single = { contributions: [answer(stray.id as string).contributions[0]] };
    const { engine, call } = engineOf(single);
    const p = await previewGraduation({ client, engine, id: stray.id as string, today: "2026-10-22" });
    expect((call.mock.calls[0] as any)[2].prompt).toContain("RECORD:");
    expect((call.mock.calls[0] as any)[2].prompt).not.toContain("INITIATIVE");
    expect(p.contributions.map((c) => c.id)).toEqual([stray.id]);
    expect(p.warnings).toEqual([]);
    await confirmGraduation({ client, roots, wolf: "owner", preview: p, ship: async () => {} });
    expect(sentTopics()).toEqual([stray.id]);
  });

  it("an initiative graduates with only its own contribution, under its own topic", async () => {
    const g = { ...f, graduated: "2026-10-05", stage: "archived" } as WorkItem;
    const { client } = fakeClient([init, g], { [init.id]: "# Dockerize\n\n## Plan\n\nContainerise.\n" });
    expect(readyToGraduate(init, [init, g])).toBe(true);
    const twoOfThem = { contributions: [{ ...answer("x").contributions[1], initiative: true }, answer("x").contributions[0]] };
    const p = await previewGraduation({ client, engine: engineOf(twoOfThem).engine, id: init.id as string, today: "2026-10-22" });
    expect(p.contributions.map((c) => c.id)).toEqual([init.id]);
    expect(p.warnings.some((x) => x.includes("dropped an extra contribution"))).toBe(true);
  });

  it("not-ready items are refused", async () => {
    const { client } = fakeClient([init, f, { ...t1, stage: "in_build" } as WorkItem], {});
    await expect(previewGraduation({ client, engine: engineOf(answer(f.id)).engine, id: f.id as string })).rejects.toThrow(/not ready/);
  });

  it("a lint failure after the retry blocks the send", async () => {
    const bad = { contributions: [{ slug: "x", title: "Compose stack", summary: "s", body: "## How\n\nFixed in commit ee17088. 682 tests passed." }] };
    const { client } = fakeClient([init, f, t1, t2], { [f.id]: PLAN });
    const p = await previewGraduation({ client, engine: engineOf(bad).engine, id: f.id as string, today: "2026-10-22" });
    expect(p.blocked).toMatch(/commit-hash/);
    await expect(confirmGraduation({ client, roots, wolf: "owner", preview: p, ship: async () => {} })).rejects.toThrow(/cannot send/);
    expect(sentTopics()).toEqual([]);
  });

  it("a feature that is not shipped yet is shipped on confirm (through the caller's ship)", async () => {
    const unshipped = { ...f, stage: "in_build" } as WorkItem; // tasks shipped, feature not
    const { client, calls } = fakeClient([init, unshipped, t1, t2], { [f.id]: PLAN });
    const p = await previewGraduation({ client, engine: engineOf(answer(f.id)).engine, id: f.id as string, today: "2026-10-22" });
    const ship = vi.fn(async () => {});
    await confirmGraduation({ client, roots, wolf: "owner", preview: p, ship });
    expect(ship).toHaveBeenCalledWith(f.id);
    expect(calls.some((c) => c.includes("Shipped for graduation"))).toBe(true);
  });
});

describe("Totals check", () => {
  let dir: string;
  beforeEach(() => { n = 0; dir = mkdtempSync(join(tmpdir(), "grad-t-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const body = '# W\n\n## Totals\n<!-- rollup:totals keys="Sets,Volume" -->\n- Sessions: **2**\n- Sets: **44**\n- Volume: **34,843 lb**\n<!-- /rollup:totals -->\n';
  const setup = () => {
    const f = w("feature", "Week 42", null, { stage: "in_build" });
    const t = w("task", "Lower A", f.id);
    return { f, ...fakeClient([f, t], { [f.id]: body }) };
  };
  const out = (text: string, id: string) => ({ contributions: [{ slug: "week", title: "Week 42 training", summary: "Training week.", body: `## Outcomes\n\n${text}\n\n## History\n\n- 2026-10-22: week 42 done (${id})` }] });

  it("a missing value triggers one retry listing it; present after the retry → no warning", async () => {
    const { f, client } = setup();
    const missing = out("2 sessions, 44 sets.", f.id);
    const ok = out("2 sessions, 44 sets, 34,843 lb moved.", f.id);
    const { engine, call } = engineOf(missing, ok);
    const p = await previewGraduation({ client, engine, id: f.id as string, today: "2026-10-22" });
    expect(call).toHaveBeenCalledTimes(2);
    expect((call.mock.calls[1] as any)[2].prompt).toContain("Volume: 34,843 lb");
    const failures = (call.mock.calls[1] as any)[2].prompt.split("CHECK FAILURES")[1];
    expect(failures).not.toContain("Sets: 44");
    expect(p.warnings).toEqual([]);
  });

  it("still missing after the retry → a warning in the preview, not a block", async () => {
    const { f, client } = setup();
    const { engine, call } = engineOf(out("2 sessions, 44 sets.", f.id));
    const p = await previewGraduation({ client, engine, id: f.id as string, today: "2026-10-22" });
    expect(call).toHaveBeenCalledTimes(2); // one retry only
    expect(p.warnings).toContain("Totals: Volume: 34,843 lb is not in the distilled text");
    expect(p.blocked).toBeUndefined();
    expect(renderGraduationPreview(p)).toContain("Warnings:\n- Totals: Volume: 34,843 lb");
  });

  it("a number inside a longer number does not count", async () => {
    const { f, client } = setup();
    const { engine } = engineOf(out("2 sessions, 144 sets, 134,843 lb.", f.id));
    const p = await previewGraduation({ client, engine, id: f.id as string, today: "2026-10-22" });
    expect(p.warnings.join("\n")).toContain("Sets: 44");
    expect(p.warnings.join("\n")).toContain("Volume: 34,843 lb");
  });
});

describe("archiveSet", () => {
  it("is the item plus everything under it not already archived", () => {
    n = 0;
    const init = w("initiative", "I", null, { stage: "in_build" });
    const f = w("feature", "F", init.id);
    const t1 = w("task", "T1", f.id);
    const t2 = w("task", "T2", f.id, { stage: "archived" });
    expect(archiveSet(f, [init, f, t1, t2]).map((i) => i.id)).toEqual([f.id, t1.id]);
    expect(archiveSet(init, [init, f, t1, t2]).map((i) => i.id)).toEqual([init.id, f.id, t1.id]);
  });
});
