import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LlmInfraError, type Engine } from "@wolfpack/engine";
import { contentHash, type KbRoots } from "@wolfpack/kb/shared";
import { promoteTopics, distillTopic, existingFor, readDistillRecord, DistillOutputSchema, type PromoteTopic } from "./distill.js";
import { writeDenTopic, readDenTopics } from "./den.js";
import { denTopicStates, isAbsorbed } from "./den-reconcile.js";

const WOLF = "w1";
let root: string;
let roots: KbRoots;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "distill-"));
  roots = { kbBase: join(root, "kb"), opsRoot: join(root, "ops"), denLocal: join(root, "den", "kb") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const topic = (id: string, body: string, extra: Partial<PromoteTopic> = {}): PromoteTopic => ({ id, title: id, summary: "s", body, change: "create", ...extra });
const clean = { slug: "main", title: "Sweep performance", summary: "How the sweep budgets its time.", body: "## Design\nOne item per run." };
const engineOf = (...answers: unknown[]) => {
  const call = vi.fn(async (_s: string, schema: { parse: (v: unknown) => unknown }) => schema.parse(answers.shift() ?? { contributions: [clean] }));
  return { call, engine: { call } as unknown as Engine };
};
const inbox = () => (existsSync(join(roots.opsRoot, "inbox", WOLF)) ? readdirSync(join(roots.opsRoot, "inbox", WOLF)) : []);
const opts = (engine: Engine, extra = {}) => ({ engine, roots, wolf: WOLF, defaultDomain: "wolfpack", today: "2026-10-22", ...extra });

describe("DistillOutputSchema", () => {
  it("treats a null target as absent (models say 'no existing entry' as null)", () => {
    const base = { slug: "x", title: "Title x", summary: "s", body: "# Title x\n\nb" };
    const out = DistillOutputSchema.parse({ contributions: [{ ...base, target: null }, { ...base, target: "kb-a" }, base] });
    expect(out.contributions.map((c) => c.target)).toEqual([undefined, "kb-a", undefined]);
  });
});

describe("distillTopic", () => {
  it("retries once with the findings, then strips; clean second answer is emitted", async () => {
    const { call, engine } = engineOf(
      { contributions: [{ ...clean, body: "## Design\nFixed in commit ee17088. 682 tests passed." }] },
      { contributions: [clean] }
    );
    const r = await distillTopic(engine, { id: "t", title: "T", summary: "s", body: "raw", domain: "wolfpack", date: "2026-10-22" });
    expect(call).toHaveBeenCalledTimes(2);
    expect((call.mock.calls[1] as any)[2].prompt).toContain("commit-hash");
    expect(r.retried).toBe(true);
    expect(r.heldCodes).toEqual([]);
    expect(r.outputs[0].body).toBe("# Sweep performance\n\n## Design\nOne item per run.\n");
  });

  it("reports hard findings still present after the retry", async () => {
    const bad = { contributions: [{ ...clean, body: "## Design\nDeployed to the VPS. Task AbC1234." }] };
    const r = await distillTopic(engineOf(bad, bad).engine, { id: "t", title: "T", summary: "s", body: "raw", domain: "wolfpack", date: "2026-10-22" });
    expect(r.heldCodes.sort()).toEqual(["deploy-status", "work-id"]);
  });

  it("splits: the first keeps the topic id, extras get <id>~<slug>; slugs are fed back", async () => {
    const two = { contributions: [clean, { slug: "Telegram Reliability!", title: "Telegram reliability", summary: "Bot reconnects.", body: "## Design\nBackoff." }] };
    const { call, engine } = engineOf(two);
    const r = await distillTopic(engine, { id: "t", title: "T", summary: "s", body: "raw", domain: "wolfpack", date: "2026-10-22", previous: [{ slug: "main", title: "Sweep performance" }] });
    expect(r.outputs.map((o) => o.id)).toEqual(["t", "t~telegram-reliability"]);
    expect((call.mock.calls[0] as any)[2].prompt).toContain("- main: Sweep performance");
  });
});

describe("distillTopic: standing feature graduation", () => {
  const grad = { workId: "work-wp-FEAT001", initiativeTopicId: "work-wp-INITI01", initiativeTitle: "Area", standingFeature: { title: "Period one" } };
  const base = { id: "work-wp-FEAT001", title: "Period one", summary: "s", body: "GRADUATION OF feature: Period one", domain: "wolfpack", date: "2026-10-22" };
  const feature = { slug: "feature", feature: true, title: "Model's own title", summary: "This period did things.", body: "short" };
  const initiative = { slug: "initiative", initiative: true, title: "Area", summary: "Live.", body: "## Scope\n\nx\n\n## History\n\n- 2026-10-22: added (work-wp-FEAT001)" };
  const subject = { slug: "rule", title: "A lasting rule", summary: "How X works.", body: "## Rule\n\nAlways.\n\n## History\n\n- 2026-10-22: chose X (work-wp-FEAT001)" };

  it("the feature output takes the item's id and the forced title; only the initiative and subjects get other ids", async () => {
    const { call, engine } = engineOf({ contributions: [subject, feature, initiative] });
    const r = await distillTopic(engine, { ...base, graduation: grad });
    expect((call.mock.calls[0] as any)[2].system).toContain("STANDING FEATURE");
    expect(call).toHaveBeenCalledTimes(1);
    expect(r.outputs.map((o) => [o.id, o.title, !!o.feature, !!o.initiative])).toEqual([
      ["work-wp-FEAT001~rule", "A lasting rule", false, false],
      ["work-wp-FEAT001", "Period one", true, false],
      ["work-wp-INITI01", "Area", false, true],
    ]);
    expect(r.outputs[1].summary).toBe("This period did things.");
  });

  it("the feature needs no History line (no warning); a subject without one still warns", async () => {
    const noHistory = { ...subject, body: "## Rule\n\nAlways." };
    const r = await distillTopic(engineOf({ contributions: [feature, initiative, noHistory] }).engine, { ...base, graduation: grad });
    expect(r.warnings).toEqual([`"A lasting rule" has no History line citing the work`]);
  });

  it("a missing feature contribution is asked for once (retry), by slug or flag", async () => {
    const { call, engine } = engineOf({ contributions: [initiative] }, { contributions: [initiative, feature] });
    const r = await distillTopic(engine, { ...base, graduation: grad });
    expect(call).toHaveBeenCalledTimes(2);
    expect((call.mock.calls[1] as any)[2].prompt).toContain("the FEATURE contribution is missing");
    expect(r.retried).toBe(true);
    expect(r.outputs.some((o) => o.feature)).toBe(true);
    // recognised by slug alone
    const bySlug = await distillTopic(engineOf({ contributions: [{ ...feature, feature: undefined }, initiative] }).engine, { ...base, graduation: grad });
    expect(bySlug.outputs.find((o) => o.id === "work-wp-FEAT001")?.feature).toBe(true);
  });

  it("still missing after the retry: a warning, no further call", async () => {
    const { call, engine } = engineOf({ contributions: [initiative] });
    const r = await distillTopic(engine, { ...base, graduation: grad });
    expect(call).toHaveBeenCalledTimes(2);
    expect(r.warnings).toContain("no summary of the feature was produced");
  });

  it("zero subject contributions is fine; Totals are not demanded of the model's text", async () => {
    const r = await distillTopic(engineOf({ contributions: [feature, initiative] }).engine, { ...base, graduation: { ...grad, totals: [{ key: "N", value: "3" }] } });
    expect(r.missingTotals).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.retried).toBe(false);
  });

  it("an ordinary graduation or plain topic never sees a feature flag", async () => {
    const plain = await distillTopic(engineOf({ contributions: [{ ...clean, feature: true }] }).engine, { id: "t", title: "T", summary: "s", body: "raw", domain: "wolfpack", date: "2026-10-22" });
    expect(plain.outputs[0].feature).toBeUndefined();
    const ordinary = await distillTopic(engineOf({ contributions: [subject, initiative] }).engine, { ...base, graduation: { ...grad, standingFeature: undefined } });
    expect(ordinary.outputs.map((o) => o.id)).toEqual(["work-wp-FEAT001", "work-wp-INITI01"]);
  });
});

describe("promoteTopics", () => {
  it("emits the distilled body (not the raw one) and records the raw body", async () => {
    const raw = "# Raw\n\nCommit dd44478 fixed it. 682 tests pass.";
    const { engine } = engineOf();
    const stats = await promoteTopics([topic("sweep", raw)], opts(engine));
    expect(stats).toMatchObject({ distilled: 1, split: 0, held: 0, emitted: 1 });
    const file = readFileSync(join(roots.opsRoot, "inbox", WOLF, inbox()[0]), "utf8");
    expect(file).toContain("# Sweep performance");
    expect(file).not.toContain("dd44478");
    expect(readDistillRecord(roots, "sweep")).toMatchObject({ rawBody: raw, slugs: [{ slug: "main", title: "Sweep performance" }] });
  });

  it("an unchanged raw topic costs no LLM call; a changed one re-distills with the same slugs", async () => {
    const { call, engine } = engineOf();
    await promoteTopics([topic("sweep", "first body about the sweep and its budget")], opts(engine));
    const again = await promoteTopics([topic("sweep", "first body about the sweep and its budget.")], opts(engine));
    expect(again).toMatchObject({ trivialSkipped: 1, distilled: 0 });
    expect(call).toHaveBeenCalledTimes(1);
    await promoteTopics([topic("sweep", "completely different body now")], opts(engine));
    expect(call).toHaveBeenCalledTimes(2);
    expect((call.mock.calls[1] as any)[2].prompt).toContain("- main: Sweep performance");
  });

  it("a legacy topic (raw emitted, no record) is skipped when unchanged", async () => {
    mkdirSync(join(roots.denLocal, "emitted-bodies"), { recursive: true });
    writeFileSync(join(roots.denLocal, "emitted-bodies", "old.md"), "same raw body here");
    const { call, engine } = engineOf();
    const stats = await promoteTopics([topic("old", "same raw body here")], opts(engine));
    expect(stats.trivialSkipped).toBe(1);
    expect(call).not.toHaveBeenCalled();
  });

  it("emits a split under stable ids and counts it", async () => {
    const two = { contributions: [clean, { slug: "second", title: "Second subject", summary: "Another.", body: "## X\ny" }] };
    const { engine } = engineOf(two);
    const stats = await promoteTopics([topic("t", "raw")], opts(engine));
    expect(stats).toMatchObject({ distilled: 1, split: 1, emitted: 2 });
    expect(inbox().map((f) => f.split("-")[0]).sort()).toEqual(["t", "t~second"]);
  });

  it("holds a topic whose distilled text still has junk, calls onHold, emits nothing, and does not retry unchanged", async () => {
    const bad = { contributions: [{ ...clean, body: "## Design\nVerified live on a real inbox item." }] };
    const { call, engine } = engineOf(bad, bad);
    const onHold = vi.fn();
    const stats = await promoteTopics([topic("t", "raw body one")], opts(engine, { onHold }));
    expect(stats).toMatchObject({ held: 1, emitted: 0 });
    expect(onHold).toHaveBeenCalledWith(expect.objectContaining({ id: "t" }), "distill: deploy-status");
    expect(inbox()).toEqual([]);
    expect(call).toHaveBeenCalledTimes(2);
    const again = await promoteTopics([topic("t", "raw body one")], opts(engine));
    expect(again.trivialSkipped).toBe(1);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("an infra failure keeps the topic pending (nothing recorded), the next promote retries", async () => {
    const call = vi.fn().mockRejectedValueOnce(new LlmInfraError("usage limit")).mockImplementation(async (_s: string, schema: any) => schema.parse({ contributions: [clean] }));
    const engine = { call } as unknown as Engine;
    const progress: string[] = [];
    const first = await promoteTopics([topic("t", "raw body")], opts(engine, { onProgress: (m: string) => progress.push(m) }));
    expect(first).toMatchObject({ pending: 1, emitted: 0 });
    expect(progress.some((m) => m.includes("distill unavailable, topic stays pending: t"))).toBe(true);
    expect(readDistillRecord(roots, "t")).toBeNull();
    const second = await promoteTopics([topic("t", "raw body")], opts(engine));
    expect(second).toMatchObject({ distilled: 1, emitted: 1 });
  });

  it("force reuses stored outputs for an unchanged topic (resend-all) without an LLM call", async () => {
    const { call, engine } = engineOf();
    await promoteTopics([topic("t", "raw body")], opts(engine));
    rmSync(join(roots.opsRoot, "inbox"), { recursive: true });
    // emitted.json still records the body: force must re-send it anyway.
    const r = await promoteTopics([topic("t", "raw body")], opts(engine, { force: true }));
    expect(r).toMatchObject({ distilled: 0, emitted: 1 });
    expect(inbox()).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("without force an unchanged topic is still not re-sent", async () => {
    const { engine } = engineOf();
    await promoteTopics([topic("t", "raw body")], opts(engine));
    rmSync(join(roots.opsRoot, "inbox"), { recursive: true });
    const r = await promoteTopics([topic("t", "raw body")], opts(engine));
    expect(r.emitted).toBe(0);
    expect(inbox()).toHaveLength(0);
  });
});

describe("reconcile with distilled contributions", () => {
  const receipt = (id: string, body: string, outcome = "create", detail = "kb-wolfpack-AAAAAAA") => {
    const dir = join(roots.opsRoot, "receipts", WOLF);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}-${contentHash(body).slice(7, 17)}.md`), `---\nfrom: ${WOLF}\nden_topic_id: ${id}\noutcome: ${outcome}\nprocessed: 2026-10-22 10:00\n---\n\n${detail}\n`);
  };

  it("a topic is absorbed only when every distilled contribution has a receipt", async () => {
    const den = join(root, "den");
    writeDenTopic(den, { id: "t", title: "t", summary: "s", updated: "2026-10-22 10:00", body: "raw body of the topic" });
    const two = { contributions: [clean, { slug: "second", title: "Second subject", summary: "Another.", body: "## X\ny" }] };
    await promoteTopics(readDenTopics(den).map((t) => topic(t.id, t.body)), opts(engineOf(two).engine));
    const rec = readDistillRecord(roots, "t")!;
    expect(denTopicStates(den, roots, WOLF)[0].status.kind).toBe("awaiting-sweep");
    receipt(rec.outputs[0].id, rec.outputs[0].body);
    expect(denTopicStates(den, roots, WOLF)[0].status.kind).toBe("awaiting-sweep");
    expect(isAbsorbed(roots, WOLF, "t", "raw body of the topic")).toBe(false);
    receipt(rec.outputs[1].id, rec.outputs[1].body, "merge");
    expect(denTopicStates(den, roots, WOLF)[0].status).toMatchObject({ kind: "absorbed", entryId: "kb-wolfpack-AAAAAAA" });
    expect(isAbsorbed(roots, WOLF, "t", "raw body of the topic")).toBe(true);
  });

  it("a held topic reports held", async () => {
    const den = join(root, "den");
    writeDenTopic(den, { id: "t", title: "t", summary: "s", updated: "2026-10-22 10:00", body: "raw body" });
    const bad = { contributions: [{ ...clean, body: "## Design\nTask AbC1234." }] };
    await promoteTopics([topic("t", "raw body")], opts(engineOf(bad, bad).engine));
    expect(denTopicStates(den, roots, WOLF)[0].status).toMatchObject({ kind: "held" });
  });
});

describe("distill sees the nearest existing entries", () => {
  const index = (rows: string[]) => {
    mkdirSync(join(roots.kbBase, "domains", "wolfpack", "entries"), { recursive: true });
    writeFileSync(join(roots.kbBase, "domains", "wolfpack", "INDEX.md"), `# wolfpack — knowledge index\n\n${rows.length} entries.\n\n${rows.join("\n")}\n`);
  };
  const SWEEP = "- [[kb-wolfpack-AbC1234|KB sweep system (shared tick, resilience, hardening)]] — How the KB sweep ticks, budgets each item and recovers from outages.";
  const OTHER = "- [[kb-wolfpack-ZzZ9999|Dashboard Work View]] — The agent serves a dashboard of the work graph.";

  it("lists them in the prompt and keeps only offered targets", async () => {
    index([SWEEP, OTHER]);
    const { call, engine } = engineOf({
      contributions: [
        { ...clean, title: "KB sweep system (shared tick, resilience, hardening)", target: "kb-wolfpack-AbC1234" },
        { slug: "other", title: "Another subject", summary: "x.", body: "## Design\nY.", target: "kb-wolfpack-NotOffered" },
      ],
    });
    const existing = existingFor(roots, "wolfpack", { title: "Sweep resilience", summary: "The KB sweep recovers from outages and budgets each item." });
    expect(existing[0].id).toBe("kb-wolfpack-AbC1234");
    const r = await distillTopic(engine, { id: "t", title: "T", summary: "s", body: "raw", domain: "wolfpack", date: "2026-10-22", existing });
    const prompt = (call.mock.calls[0] as any)[2].prompt as string;
    expect(prompt).toContain("EXISTING ENTRIES (id: title — summary):");
    expect(prompt).toContain("- kb-wolfpack-AbC1234: KB sweep system (shared tick, resilience, hardening) — How the KB sweep ticks");
    expect(r.outputs.map((o) => o.target)).toEqual(["kb-wolfpack-AbC1234", undefined]);
  });

  it("an anchored (initiative) entry is never offered", async () => {
    index([SWEEP]);
    writeFileSync(join(roots.kbBase, "domains", "wolfpack", "entries", "kb-wolfpack-AbC1234.md"), "---\nid: kb-wolfpack-AbC1234\nanchor: work-wolfpack-AbC1234\n---\n\nbody\n");
    expect(existingFor(roots, "wolfpack", { title: "KB sweep", summary: "sweep" })).toEqual([]);
  });

  it("promote emits the target hint into the inbox contribution; no mirror means none offered", async () => {
    index([SWEEP]);
    const { engine } = engineOf({ contributions: [{ ...clean, target: "kb-wolfpack-AbC1234" }] });
    await promoteTopics([topic("t", "The KB sweep ticks and budgets each item; resilience hardening.", { title: "KB sweep resilience", summary: "sweep tick" })], opts(engine));
    const f = inbox()[0];
    expect(readFileSync(join(roots.opsRoot, "inbox", WOLF, f), "utf-8")).toContain("target: kb-wolfpack-AbC1234");
    rmSync(join(roots.kbBase), { recursive: true, force: true });
    expect(existingFor(roots, "wolfpack", { title: "x", summary: "y" })).toEqual([]);
  });
});
