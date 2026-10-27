/**
 * Durable crawl run / status / stop / release tools, against a stub runner (a real run needs an LLM, a real release the
 * KB inbox): the stepped wizard card, the background run + progress, and the release confirmation gate. Temp dirs only.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Card, CardAnswers } from "@wolfpack/protocol";
import { CardSchema } from "@wolfpack/protocol";
import { validateAnswers } from "../../packages/harness/src/wolfd/cards.js";
import type { CrawlRunner } from "./unified-crawl-run.js";
import { crawlMode } from "./crawl-mode.js";
import createCrawlExtension from "./unified-crawl.js";

type R = { content: { text: string }[]; isError?: boolean; card?: Card; endTurn?: boolean };

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `crawl-run-${p}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A conversation whose cards we control: `cards` is what the structured transcript would report. */
interface FakeCard {
  tool: string;
  card: Card;
  status: "pending" | "answered" | "dismissed";
  answers?: CardAnswers;
  laterResults: { message: { content: string } }[];
}
const fakeConversation = (cards: FakeCard[], kind: "root" | "task" = "root") => ({
  classify: async () => ({ kind }) as never,
  messagesSince: async () => [],
  latestCard: async (tool: string, matches: (c: Card) => boolean) => {
    const f = [...cards].reverse().find((c) => c.tool === tool && matches(c.card));
    return f ? { callId: "c", card: f.card, status: f.status, answers: f.answers, laterResults: f.laterResults as never } : undefined;
  },
});

function setup(opts: { cards?: boolean; opsRoot?: string | null } = {}) {
  const den = tmp("den");
  const crawlHome = join(tmp("home"), "crawls");
  mkdirSync(crawlHome, { recursive: true });
  const ops = opts.opsRoot === null ? undefined : (opts.opsRoot ?? tmp("ops"));
  const calls = { run: [] as { planFile: string; opts: Parameters<CrawlRunner["run"]>[1] }[], emit: [] as { runDir: string; dryRun?: boolean; roots?: unknown }[] };
  const gates: { release: (r: { ok: boolean; dir: string; cancelled?: boolean }) => void }[] = [];
  const behavior = { mode: "hold" as "hold" | "reject" | "throw" };
  const runner: CrawlRunner = {
    run(planFile, o) {
      if (behavior.mode === "throw") throw new Error("no key");
      calls.run.push({ planFile, opts: o });
      const dir = o.runDir ?? join(crawlHome, `run-${calls.run.length}`);
      mkdirSync(dir, { recursive: true });
      o.onSink?.(dir);
      o.onProgress?.({ phase: "gate", ok: true });
      o.onProgress?.({ phase: "batch", batch: { topic: "docs", index: 0, total: 2, files: 2, stage: "extract", scanned: 1, observations: 3 } });
      if (behavior.mode === "reject") return Promise.reject(new Error("boom"));
      return new Promise((resolve) => {
        gates.push({ release: resolve });
        o.signal?.addEventListener("abort", () => resolve({ ok: false, cancelled: true, dir }));
      });
    },
    emit(runDir, o) {
      calls.emit.push({ runDir, dryRun: o.dryRun, roots: o.roots });
      return {
        emitted: o.dryRun ? 2 : 2,
        skipped: 0,
        dest: join(ops ?? "", "inbox", "w"),
        dir: runDir,
        contributions: [
          { kind: "topic", topic: "docs", denTopicId: "crawl-wolfpack-docs", title: "Docs", summary: "s", bodyChars: 100, currency: "current", status: "emit" },
          { kind: "history", topic: "history", denTopicId: "crawl-wolfpack-history", title: "History", summary: "s", bodyChars: 50, currency: "archived", status: "emit" },
        ],
      };
    },
  };
  const env: NodeJS.ProcessEnv = { WOLFPACK_CRAWL_HOME: crawlHome, KB_BASE: "", KB_OPS: ops ?? "" };
  const ext = createCrawlExtension({ runner }, { wolfDen: den, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env, ...(opts.cards === false ? {} : { capabilities: { askCards: true } }) } as never);
  const cardLog: FakeCard[] = [];
  const conv = fakeConversation(cardLog);
  let convId = 1;
  const tool = (name: string) => ext.tools!.find((t) => t.name === name)!;
  const call = async (name: string, args: object = {}, c: unknown = conv): Promise<R> => {
    const r = (await tool(name).execute(args, { wolfDen: den, wolfName: "w", conversationId: convId, cwd: den, conversation: c } as never)) as R;
    if (r.card) cardLog.push({ tool: name, card: r.card, status: "pending", laterResults: [] });
    return r;
  };
  const src = tmp("src");
  mkdirSync(join(src, "docs"), { recursive: true });
  writeFileSync(join(src, "docs", "a.md"), "# A\n");
  writeFileSync(join(src, "docs", "b.md"), "# B\n");
  mkdirSync(join(src, "notes"), { recursive: true });
  writeFileSync(join(src, "notes", "c.md"), "# C\n");
  const plan = async () => {
    const r = await call("crawl_plan", { path: src, domain: "wolfpack", strategy: "by-folder", depth: 1 });
    const planPath = /Plan written: (\S+)/.exec(r.content[0].text)![1];
    await call("crawl_finalize", { planPath });
    return planPath;
  };
  return { den, crawlHome, ops, calls, gates, behavior, call, cardLog, conv, plan, src, setConv: (n: number) => (convId = n) };
}

/** An unfinished run of the plan: extraction began (observations.jsonl) and one of two batches is missing. */
function seedOutstanding(crawlHome: string, planPath: string, name: string, done: string[] = ["docs"]): string {
  const dir = join(crawlHome, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(planPath, join(dir, "plan.yaml"));
  writeFileSync(join(dir, "observations.jsonl"), "");
  writeFileSync(join(dir, "topics.json"), JSON.stringify(done.map((t) => [t, {}])));
  return dir;
}

beforeEach(() => {
  // a developer's KB env must not leak in
  process.env.KB_BASE = "";
  process.env.KB_OPS = "";
});

describe("crawl_run wizard card", () => {
  it("no outstanding run: one concurrency question (a plain card, no steps), skipped when given", async () => {
    const t = setup();
    const planPath = await t.plan();
    const r = await t.call("crawl_run", { planPath });
    expect(r.card).toMatchObject({ tool: "crawl_run" });
    expect(CardSchema.safeParse(r.card).success).toBe(true);
    expect(r.card!.fields.map((f) => f.id)).toEqual(["concurrency"]);
    expect(r.card!.steps).toBeUndefined();
    expect(r.card!.fields[0]).toMatchObject({ kind: "single", allowOther: true });
    expect((r.card!.fields[0] as { options: { value: string }[] }).options.map((o) => o.value)).toEqual(["5", "8", "12", "16", "24", "32"]);
    expect(t.calls.run).toHaveLength(0);
    // the same question again while it waits: no duplicate card
    const again = await t.call("crawl_run", { planPath });
    expect(again.card).toBeUndefined();
    expect(again.endTurn).toBe(true);
    // given: no card, the run starts
    const go = await t.call("crawl_run", { planPath, concurrency: 7 });
    expect(go.card).toBeUndefined();
    expect(t.calls.run[0].opts.concurrency).toBe(7);
  });

  it("one outstanding run: a stepped card (resume/fresh/cancel, then concurrency); cancel hides the concurrency step", async () => {
    const t = setup();
    const planPath = await t.plan();
    const dir = seedOutstanding(t.crawlHome, planPath, "run-old");
    const r = await t.call("crawl_run", { planPath });
    const card = r.card!;
    expect(CardSchema.safeParse(card).success).toBe(true);
    expect(card.steps).toEqual([{ title: "Resume", fields: ["resume"] }, { title: "Concurrency", fields: ["concurrency"] }]);
    const resume = card.fields[0] as { options: { value: string; label: string }[] };
    expect(resume.options.map((o) => o.value)).toEqual([dir, "fresh", "cancel"]);
    expect(resume.options[0].label).toBe("Resume — finish the 1 remaining batch(es)");
    expect(card.fields[1].showIf).toEqual({ field: "resume", oneOf: [dir, "fresh"] });
    // cancel: concurrency is neither required nor accepted
    expect(validateAnswers(card, { resume: { value: "cancel" } })).toBeUndefined();
    expect(validateAnswers(card, { resume: { value: "cancel" }, concurrency: { value: "8" } })).toMatch(/not shown/);
    expect(validateAnswers(card, { resume: { value: "fresh" } })).toMatch(/missing answer for field "concurrency"/);
    expect(validateAnswers(card, { resume: { value: dir }, concurrency: { value: "12" } })).toBeUndefined();
  });

  it("several outstanding runs: pick which one; the picked run resumes only its missing batches in its own dir", async () => {
    const t = setup();
    const planPath = await t.plan();
    const a = seedOutstanding(t.crawlHome, planPath, "run-a");
    const b = seedOutstanding(t.crawlHome, planPath, "run-b", []);
    const r = await t.call("crawl_run", { planPath, concurrency: 5 }); // concurrency given: only the resume question
    expect(r.card!.fields.map((f) => f.id)).toEqual(["resume"]);
    expect(r.card!.fields[0].label).toBe("2 outstanding runs — pick one to resume");
    expect((r.card!.fields[0] as { options: { value: string }[] }).options.map((o) => o.value).sort()).toEqual([a, b, "cancel", "fresh"].sort());
    expect((await t.call("crawl_run", { planPath, concurrency: 5, resume: "/nowhere" })).isError).toBe(true);
    const go = await t.call("crawl_run", { planPath, concurrency: 5, resume: a });
    expect(go.content[0].text).toContain("resumed");
    expect(t.calls.run[0]).toMatchObject({ planFile: join(a, "plan.yaml"), opts: { runDir: a } });
    expect(t.calls.run[0].opts.only).toHaveLength(1); // the one batch of the two that never landed
  });

  it("without cards (or in a task-owned conversation) it does not ask: fresh run at the default concurrency", async () => {
    const t = setup({ cards: false });
    const planPath = await t.plan();
    seedOutstanding(t.crawlHome, planPath, "run-old");
    const r = await t.call("crawl_run", { planPath });
    expect(r.card).toBeUndefined();
    expect(t.calls.run[0].opts.concurrency).toBe(5);
    expect(t.calls.run[0].opts.runDir).toBeUndefined();

    const t2 = setup();
    const p2 = await t2.plan();
    const sub = fakeConversation([], "task");
    const r2 = await t2.call("crawl_run", { planPath: p2 }, sub);
    expect(r2.card).toBeUndefined();
    expect(t2.calls.run).toHaveLength(1);
  });

  it("refuses a plan that is not ready, and a plan that does not exist", async () => {
    const t = setup();
    const r = await t.call("crawl_plan", { path: t.src, domain: "wolfpack" });
    const draft = /Plan written: (\S+)/.exec(r.content[0].text)![1];
    const notReady = await t.call("crawl_run", { planPath: draft, concurrency: 5 });
    expect(notReady.isError).toBe(true);
    expect(notReady.content[0].text).toContain("gate fails");
    expect((await t.call("crawl_run", { planPath: join(t.crawlHome, "nope", "plan.yaml"), concurrency: 5 })).isError).toBe(true);
    expect(t.calls.run).toHaveLength(0);
  });
});

describe("a run in the background", () => {
  it("returns at once; crawl_status follows it; completion and a second start are handled", async () => {
    const t = setup();
    const planPath = await t.plan();
    const start = await t.call("crawl_run", { planPath, concurrency: 9 });
    expect(start.isError).toBeFalsy();
    expect(start.content[0].text).toContain("started in the background");
    expect(t.calls.run[0].opts).toMatchObject({ concurrency: 9, sinkBase: t.crawlHome });
    const running = (await t.call("crawl_status")).content[0].text;
    expect(running).toContain("RUNNING run-1 (9 at once)");
    expect(running).toContain("docs [extract] 1/2 files");
    // the same plan is not started twice
    expect((await t.call("crawl_run", { planPath, concurrency: 9 })).content[0].text).toContain("already in progress");
    expect(t.calls.run).toHaveLength(1);
    t.gates[0].release({ ok: true, dir: join(t.crawlHome, "run-1") });
    await new Promise((r) => setTimeout(r, 0));
    expect((await t.call("crawl_status", { runDir: join(t.crawlHome, "run-1") })).content[0].text).toContain("COMPLETE run-1");
  });

  it("crawl_stop aborts cooperatively; the run reports CANCELLED", async () => {
    const t = setup();
    const planPath = await t.plan();
    await t.call("crawl_run", { planPath, concurrency: 5 });
    expect((await t.call("crawl_stop")).content[0].text).toContain("Stopping");
    await new Promise((r) => setTimeout(r, 0));
    expect(t.calls.run[0].opts.signal?.aborted).toBe(true);
    expect((await t.call("crawl_status")).content[0].text).toContain("CANCELLED run-1");
    expect((await t.call("crawl_stop")).isError).toBe(true); // nothing running now
  });

  it("a run that rejects is FAILED with its error; a start that throws is an error result", async () => {
    const t = setup();
    const planPath = await t.plan();
    t.behavior.mode = "reject";
    await t.call("crawl_run", { planPath, concurrency: 5 });
    await new Promise((r) => setTimeout(r, 0));
    expect((await t.call("crawl_status")).content[0].text).toContain("FAILED run-1 (5 at once): boom");
    t.behavior.mode = "throw";
    const r = await t.call("crawl_run", { planPath, concurrency: 5 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("failed to start: no key");
  });

  it("starting a run ends the planning window: observation is never left paused", async () => {
    const t = setup();
    const planPath = await t.plan();
    crawlMode.begin(t.den, 1);
    expect(crawlMode.active(t.den, 1)).toBe(true);
    await t.call("crawl_run", { planPath, concurrency: 5 });
    expect(crawlMode.active(t.den, 1)).toBe(false);
  });
});

describe("crawl_release", () => {
  const complete = (crawlHome: string, planPath: string, name: string, history = true) => {
    const dir = seedOutstanding(crawlHome, planPath, name, ["docs"]);
    if (history) writeFileSync(join(dir, "history.json"), "{}");
    return dir;
  };

  it("nothing to release; an unfinished journey blocks it; the KB must be configured", async () => {
    const t = setup();
    const planPath = await t.plan();
    expect((await t.call("crawl_release")).content[0].text).toContain("No completed crawl");
    const dir = complete(t.crawlHome, planPath, "run-x", false);
    const r = await t.call("crawl_release", { runDir: dir });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("journey is not written");
    const t2 = setup({ opsRoot: null });
    const p2 = await t2.plan();
    const d2 = complete(t2.crawlHome, p2, "run-y");
    expect((await t2.call("crawl_release", { runDir: d2 })).content[0].text).toContain("not configured");
    expect(t.calls.emit.every((e) => e.dryRun)).toBe(true);
  });

  it("several complete crawls: a pick card first; a runDir outside the crawl home is refused", async () => {
    const t = setup();
    const planPath = await t.plan();
    const a = complete(t.crawlHome, planPath, "run-a");
    const b = complete(t.crawlHome, planPath, "run-b");
    const r = await t.call("crawl_release");
    expect(r.card).toMatchObject({ tool: "crawl_release", title: "Release which crawl?" });
    expect((r.card!.fields[0] as { options: { value: string }[] }).options.map((o) => o.value).sort()).toEqual([a, b].sort());
    const outside = tmp("outside");
    copyFileSync(planPath, join(outside, "plan.yaml"));
    const bad = await t.call("crawl_release", { runDir: outside });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("not a crawl run");
  });

  it("emits only after a structured yes on its own confirm card, once", async () => {
    const t = setup();
    const planPath = await t.plan();
    const dir = complete(t.crawlHome, planPath, "run-a");
    const first = await t.call("crawl_release", { runDir: dir });
    expect(first.card?.fields[0]).toMatchObject({ kind: "confirm", label: `Release crawl run-a to the librarian?`, confirmLabel: "Release" });
    expect(first.card!.fields[0].description).toContain("**2** contribution(s)");
    expect(t.calls.emit.filter((e) => !e.dryRun)).toHaveLength(0);
    // waiting for the answer: nothing happens, no second card
    const waiting = await t.call("crawl_release", { runDir: dir });
    expect(waiting.card).toBeUndefined();
    expect(waiting.endTurn).toBe(true);
    // the model cannot self-confirm with an argument
    const sneaky = await t.call("crawl_release", { runDir: dir, confirm: true });
    expect(sneaky.card).toBeUndefined();
    expect(t.calls.emit.filter((e) => !e.dryRun)).toHaveLength(0);
    // a "no" asks again, not releases
    const f = t.cardLog.find((c) => c.tool === "crawl_release" && c.card.title === "Release to the librarian?")!;
    f.status = "answered";
    f.answers = { confirm: { value: false } };
    expect((await t.call("crawl_release", { runDir: dir })).card).toBeDefined();
    expect(t.calls.emit.filter((e) => !e.dryRun)).toHaveLength(0);
    // a yes releases (into the explicit roots, not the process env)
    const last = t.cardLog.filter((c) => c.tool === "crawl_release").at(-1)!;
    last.status = "answered";
    last.answers = { confirm: { value: true } };
    const done = await t.call("crawl_release", { runDir: dir });
    expect(done.content[0].text).toContain("Released crawl run-a: 2 contribution(s)");
    const real = t.calls.emit.filter((e) => !e.dryRun);
    expect(real).toHaveLength(1);
    expect(real[0].roots).toMatchObject({ opsRoot: t.ops, denLocal: join(t.den, "kb") });
    expect(existsSync(join(dir, "emitted.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "emitted.json"), "utf8")).emitted).toBe(2);
    // the yes is spent: a further call asks again instead of re-emitting
    last.laterResults.push({ message: { content: done.content[0].text } });
    const after = await t.call("crawl_release", { runDir: dir });
    expect(after.card).toBeDefined();
    expect(t.calls.emit.filter((e) => !e.dryRun)).toHaveLength(1);
  });

  it("without cards it needs the user's chat confirmation as confirm: true", async () => {
    const t = setup({ cards: false });
    const planPath = await t.plan();
    const dir = complete(t.crawlHome, planPath, "run-a");
    const preview = await t.call("crawl_release", { runDir: dir });
    expect(preview.card).toBeUndefined();
    expect(preview.content[0].text).toContain("Ask the user to confirm");
    expect(t.calls.emit.filter((e) => !e.dryRun)).toHaveLength(0);
    expect((await t.call("crawl_release", { runDir: dir, confirm: true })).content[0].text).toContain("Released crawl run-a");
  });
});
