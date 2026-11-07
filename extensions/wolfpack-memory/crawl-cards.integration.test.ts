/**
 * The crawl questionnaire through ask cards, end to end over /v1: wolfd boots with the REAL wolfpack-memory durable
 * bundle from `extensions: [memory]` (crawl tools + the askCards capability from run.ts), the scripted model follows the
 * crawl directive, raises batched / confirm cards, the answers arrive as the next submission and drive crawl_plan.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import esbuild from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpConsoleClient } from "@wolfpack/client";
import { readPlan } from "@wolfpack/memory";
import { createScriptedModel, fauxAssistantMessage, fauxToolCall } from "../../packages/harness/src/wolfd/scripted-model.js";
import { startWolf, type RunningWolf } from "../../packages/harness/src/wolfd/run.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `crawl-cards-${p}-`));
  dirs.push(d);
  return d;
};
let wolf: RunningWolf | undefined;
// A developer's KB env must not leak in: declared domains would then come from their live KB.
beforeEach(() => {
  vi.stubEnv("KB_BASE", "");
  vi.stubEnv("KB_OPS", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await wolf?.close();
  wolf = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
type Ctx = { messages: { role: string; content: unknown }[] };
const lastUser = (c: Ctx): string => {
  const u = c.messages.filter((m) => m.role === "user").at(-1);
  return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content);
};
/** The answer to field `label` in the submission text ("- Label: value"). */
/** The answer text for a question; a single-choice answer renders `Label (value)` / `other: "text"`, unwrapped to the value. */
const SINGLE_LABELS = ["Target KB domain", "Grouping strategy", "Folder depth", "Scope", "Resume the outstanding crawl?"];
const answerTo = (submission: string, label: string): string | undefined => {
  const raw = new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (.*)$`, "m").exec(submission)?.[1];
  // unwrap only for single-choice fields (their option values carry no parens); free-text like "foo (bar)" stays as typed
  if (!SINGLE_LABELS.includes(label)) return raw;
  return raw?.replace(/^other: "(.*)"$/, "$1").replace(/^.* \(([^()]*)\)$/, "$1");
};
const lastToolResult = (c: Ctx): string => JSON.stringify(c.messages.filter((m) => m.role === "toolResult").at(-1)?.content);

async function boot(script: Parameters<typeof createScriptedModel>[0]) {
  const root = tmp("wolf");
  const scripted = createScriptedModel(script);
  const tier = { model: scripted.modelId, modelSource: "default", provider: scripted.provider, piModel: `${scripted.provider}/${scripted.modelId}` };
  writeFileSync(join(root, "models.json"), JSON.stringify({ location: "local", transport: "api", transportSource: "default", tiers: { main: tier, smart: tier, fast: tier }, steps: {}, warnings: [] }));
  mkdirSync(join(root, "work"));
  writeFileSync(join(root, "wolf.yaml"), `name: crawler\nworkspace: ${join(root, "work")}\ndomains: [wolfpack]\nextensions: [memory]\n`);
  await esbuild.build({
    entryPoints: [join(__dirname, "durable.ts")],
    outfile: join(root, "den", "extensions", "wolfpack-memory", "index.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "grammy"],
    logLevel: "silent",
  });
  wolf = await startWolf({
    configPath: join(root, "wolf.yaml"),
    env: { WOLFPACK_MODELS_FILE: join(root, "models.json"), WOLFPACK_CRAWL_HOME: join(root, "crawls"), KB_BASE: "", KB_OPS: "" },
    home: root,
    models: scripted.models,
  });
  const client = new HttpConsoleClient({ baseUrl: wolf.url });
  const home = "crawler/home";
  const drain = async () => {
    for await (const _ of client.watch(home)) void _;
  };
  return { root, client, home, scripted, drain };
}

const questionnaire = () =>
  toolUse(
    fauxToolCall("brief", {
      headline: "Crawl plan: where",
      questions: [{ id: "domain", ask: "Target KB domain", choices: [{ label: "wolfpack" }] }],
    }),
    fauxToolCall("brief", {
      headline: "Crawl plan: shape",
      questions: [
        { id: "strategy", ask: "Grouping strategy", choices: [{ label: "by-folder (Recommended)", value: "by-folder" }, { label: "by-pattern", value: "by-pattern" }] },
        // depth is only asked for by-folder
        { id: "depth", ask: "Folder depth", choices: [{ label: "1" }, { label: "2" }, { label: "3" }], showIf: { field: "strategy", equals: "by-folder" } },
        { id: "scope", ask: "Scope", choices: [{ label: "Whole tree", value: "whole" }, { label: "Only some files", value: "some" }] },
      ],
    }),
  );
const confirm = () => toolUse(fauxToolCall("brief", { headline: "Crawl plan", questions: [{ id: "confirm", ask: "Does this plan look good?", kind: "confirm", yesLabel: "Looks good — add to plan", noLabel: "Edit it" }] }));
/** The scripted model's crawl_plan call, derived from the submitted answers (as the directive tells a real model to). */
function planCallFrom(submission: string, path: string) {
  const scope = answerTo(submission, "Scope") ?? "";
  const list = (key: string) => new RegExp(`${key}: ([^;]+)`).exec(scope)?.[1]?.split(",").map((g) => g.trim());
  const include = list("include");
  const exclude = list("exclude");
  return toolUse(
    fauxToolCall("crawl_plan", {
      path,
      domain: answerTo(submission, "Target KB domain"),
      strategy: answerTo(submission, "Grouping strategy"),
      ...(answerTo(submission, "Folder depth") ? { depth: Number(answerTo(submission, "Folder depth")) } : {}),
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
    }),
  );
}
function makeSource(): string {
  const src = tmp("src");
  mkdirSync(join(src, "docs", "guides"), { recursive: true });
  mkdirSync(join(src, "notes"), { recursive: true });
  writeFileSync(join(src, "docs", "a.md"), "# A\nalpha\n");
  writeFileSync(join(src, "docs", "guides", "b.md"), "# B\nbeta\n");
  writeFileSync(join(src, "notes", "c.md"), "# C\ngamma\n");
  writeFileSync(join(src, "notes", "skip.txt"), "skip me\n");
  return src;
}
const planPathOf = (finalized: string) => /plan: (\S+plan\.yaml)/.exec(finalized)![1];

describe("crawl questionnaire via ask cards (/v1, scripted model)", { timeout: 60_000 }, () => {
  it("interviews through batched + confirm cards and the plan reflects the answers", async () => {
    const src = makeSource();
    let directive = "";
    let planArgs: unknown;
    let planResult = "";
    let finalized = "";
    const { root, client, home, scripted, drain } = await boot([
      toolUse(fauxToolCall("crawl_start", { path: src })),
      (c) => {
        directive = lastToolResult(c as never);
        return questionnaire();
      },
      (c) => {
        const call = planCallFrom(lastUser(c as never), src);
        planArgs = (call as unknown as { content: { arguments: unknown }[] }).content[0].arguments;
        return call;
      },
      (c) => {
        planResult = lastToolResult(c as never);
        return toolUse(fauxToolCall("crawl_preview", {}));
      },
      confirm(),
      (c) => {
        expect(lastUser(c as never)).toContain("Looks good — add to plan");
        return toolUse(fauxToolCall("crawl_finalize", {}));
      },
      (c) => {
        finalized = lastToolResult(c as never);
        return fauxAssistantMessage("Plan is ready.");
      },
    ]);

    await client.submit(home, `crawl ${src}`, { whenBusy: "reject" });
    await drain();

    // the interview is a card in the thread, not a deterministic draft; the dead-end command is not offered
    expect(directive).toContain("TWO brief calls");
    expect(directive).toContain(`\`${src}\``);
    expect(directive).not.toContain("/wolf:crawl-run");
    const d1 = await client.getThread(home);
    expect(d1.status).toBe("needs-you");
    const [where, shape] = d1.pendingCards!;
    expect(where.card).toMatchObject({ tool: "brief", brief: { headline: "Crawl plan: where" } });
    expect(where.card.fields.map((f) => [f.id, f.kind])).toEqual([["domain", "single"]]);
    expect(shape.card.fields.map((f) => [f.id, f.kind])).toEqual(["strategy", "depth", "scope"].map((id) => [id, "single"]));
    expect(scripted.faux.state.callCount).toBe(2);
    // depth depends on the strategy answer
    expect(shape.card.fields.find((f) => f.id === "depth")?.showIf).toEqual({ field: "strategy", equals: "by-folder" });

    await client.answerCard!(home, where.callId, { domain: { value: "wolfpack" } });
    await client.answerCard!(home, shape.callId, {
      strategy: { value: "by-folder" },
      depth: { value: "2" },
      scope: { value: "include: **/*.md; exclude: notes/**", other: true },
    });
    await drain();
    // the plan call carries exactly what the answers said
    expect(planArgs).toEqual({ path: src, domain: "wolfpack", strategy: "by-folder", depth: 2, include: ["**/*.md"], exclude: ["notes/**"] });
    expect(planResult).toContain("Plan written");

    const d2 = await client.getThread(home);
    expect(d2.status).toBe("needs-you");
    const [p2] = d2.pendingCards!;
    expect(p2.card.fields[0]).toMatchObject({ kind: "confirm", label: "Does this plan look good?" });
    await client.answerCard!(home, p2.callId, { confirm: { value: true } });
    await drain();

    expect(finalized).toContain("status: ready");
    expect(finalized).not.toContain("/wolf:crawl-run");
    expect(finalized).toContain("crawl_run"); // points at the durable run tool
    const planPath = planPathOf(finalized);
    expect(planPath.startsWith(join(root, "crawls"))).toBe(true);
    const plan = readPlan(planPath);
    expect(plan).toMatchObject({ status: "ready", domain: "wolfpack", source: src, include: ["**/*.md"], exclude: ["notes/**"] });
    // depth 2 splits docs/ from docs/guides/; the excluded notes/ never made it in
    expect(plan.batches.map((b) => b.topic).sort()).toEqual(["docs", "docs-guides"]);
    expect(readFileSync(planPath, "utf8")).toContain("status: ready");
    expect((await client.getThread(home)).status).toBe("idle");
  });

  it("shape card: by-pattern skips the dependent depth field (not required, and dropped if sent)", async () => {
    const src = makeSource();
    let planArgs: unknown;
    const { client, home, drain } = await boot([
      questionnaire(),
      (c) => {
        const call = planCallFrom(lastUser(c as never), src);
        planArgs = (call as unknown as { content: { arguments: unknown }[] }).content[0].arguments;
        return call;
      },
      fauxAssistantMessage("planned"),
    ]);
    await client.submit(home, "plan a crawl", { whenBusy: "reject" });
    await drain();
    const [where, shape] = (await client.getThread(home)).pendingCards!;
    const base = { strategy: { value: "by-pattern" }, scope: { value: "whole" } };
    await client.answerCard!(home, where.callId, { domain: { value: "wolfpack" } });
    // an older console that renders every field also sends depth: wolfd drops the hidden answer instead of rejecting
    await client.answerCard!(home, shape.callId, { ...base, depth: { value: "2" } });
    await drain();
    expect(planArgs).toEqual({ path: src, domain: "wolfpack", strategy: "by-pattern" });
    expect((await client.getThread(home)).messages.flatMap((m) => m.tools ?? []).find((t) => t.name === "brief" && t.answer && "strategy" in (t.answer as object))?.answer).toEqual(base);
  });

  it("a bad path is reported by crawl_plan and the model re-asks", async () => {
    const src = makeSource();
    const bad = join(src, "does-not-exist");
    let badResult = "";
    let finalized = "";
    const { client, home, drain } = await boot([
      toolUse(fauxToolCall("crawl_start", {})),
      toolUse(fauxToolCall("brief", { headline: "Crawl source", questions: [{ id: "source", ask: "Which directory should I crawl?" }] })),
      (c) => toolUse(fauxToolCall("crawl_plan", { path: answerTo(lastUser(c as never), "Which directory should I crawl?") })),
      (c) => {
        badResult = lastToolResult(c as never);
        return toolUse(fauxToolCall("brief", { headline: "Crawl source", questions: [{ id: "source", ask: "That path does not exist. Which directory should I crawl?" }] }));
      },
      (c) => toolUse(fauxToolCall("crawl_plan", { path: answerTo(lastUser(c as never), "That path does not exist. Which directory should I crawl?") })),
      toolUse(fauxToolCall("crawl_finalize", {})),
      (c) => {
        finalized = lastToolResult(c as never);
        return fauxAssistantMessage("ready");
      },
    ]);
    await client.submit(home, "crawl something", { whenBusy: "reject" });
    await drain();
    const [q1] = (await client.getThread(home)).pendingCards!;
    expect(q1.card.fields[0]).toMatchObject({ id: "source", kind: "free-text" });
    await client.answerCard!(home, q1.callId, { source: { value: bad } });
    await drain();
    expect(badResult).toContain(`source is not a directory: ${bad}`);
    const d = await client.getThread(home);
    expect(d.status).toBe("needs-you"); // re-asked
    const [q2] = d.pendingCards!;
    expect(q2.card.fields[0].label).toContain("does not exist");
    await client.answerCard!(home, q2.callId, { source: { value: src } });
    await drain();
    expect(readPlan(planPathOf(finalized))).toMatchObject({ status: "ready", source: src });
  });

  it("rejecting the plan asks what to change, re-plans, and only a later approval finalizes", async () => {
    const src = makeSource();
    const plans: string[] = [];
    let finalized = "";
    const { client, home, drain } = await boot([
      toolUse(fauxToolCall("crawl_plan", { path: src, domain: "wolfpack", strategy: "by-folder", depth: 1 })),
      (c) => {
        plans.push(lastToolResult(c as never));
        return confirm();
      },
      (c) => {
        expect(lastUser(c as never)).toContain("no (Edit it)");
        return toolUse(fauxToolCall("brief", { headline: "Crawl plan", questions: [{ id: "answer", ask: "What should change?" }] }));
      },
      (c) => toolUse(fauxToolCall("crawl_plan", { path: src, domain: "wolfpack", strategy: "by-folder", depth: 2, exclude: [lastUser(c as never).split(": ").pop()] })),
      (c) => {
        plans.push(lastToolResult(c as never));
        return confirm();
      },
      toolUse(fauxToolCall("crawl_finalize", {})),
      (c) => {
        finalized = lastToolResult(c as never);
        return fauxAssistantMessage("ready");
      },
    ]);
    await client.submit(home, "plan a crawl", { whenBusy: "reject" });
    await drain();
    const [c1] = (await client.getThread(home)).pendingCards!;
    await client.answerCard!(home, c1.callId, { confirm: { value: false } });
    await drain();
    const [edit] = (await client.getThread(home)).pendingCards!;
    expect(edit.card.fields[0]).toMatchObject({ kind: "free-text", label: "What should change?" });
    await client.answerCard!(home, edit.callId, { answer: { value: "notes/**" } });
    await drain();
    const [c2] = (await client.getThread(home)).pendingCards!;
    // nothing was finalized yet: the first plan is still a draft on disk
    expect(plans).toHaveLength(2);
    expect(readPlan(/Plan written: (\S+plan\.yaml)/.exec(plans[0])![1]).status).toBe("draft");
    await client.answerCard!(home, c2.callId, { confirm: { value: true } });
    await drain();
    const final = readPlan(planPathOf(finalized));
    expect(final).toMatchObject({ status: "ready", exclude: ["notes/**"] });
    expect(final.batches.map((b) => b.topic).sort()).toEqual(["docs", "docs-guides"]);
  });

  it("an invalid brief call (no headline, a blank entry, duplicate ids) is an error result and raises no card", async () => {
    const seen: string[] = [];
    // Malformed on purpose, but plain JSON: the scripted call takes the tool arguments as JSON.
    const bad: Parameters<typeof fauxToolCall>[1][] = [
      { questions: [{ ask: "A" }] },
      { headline: "h", questions: [{ ask: "A" }, { ask: " " }] },
      { headline: "h", questions: [{ id: "x", ask: "A" }, { id: "x", ask: "B" }] },
    ];
    const { client, home, drain } = await boot([
      ...bad.flatMap((args) => [toolUse(fauxToolCall("brief", args)), ((c: unknown) => (seen.push(lastToolResult(c as never)), fauxAssistantMessage("fixing"))) as never]),
    ]);
    for (let i = 0; i < bad.length; i++) {
      await client.submit(home, `try ${i}`, { whenBusy: "reject" });
      await drain();
      expect((await client.getThread(home)).pendingCards ?? []).toHaveLength(0);
    }
    expect(seen[0]).toMatch(/headline/);
    expect(seen[1]).toMatch(/questions\[1\] is missing its `ask`/);
    expect(seen[2]).toMatch(/share the id \\?"x\\?"/);
  });

  it("draft=true skips the interview and drafts deterministically even in wolfd", async () => {
    const src = tmp("src");
    writeFileSync(join(src, "x.md"), "# X\n");
    let result = "";
    const { client, home, drain } = await boot([
      toolUse(fauxToolCall("crawl_start", { path: src, draft: true, domain: "wolfpack" })),
      (c) => {
        result = lastToolResult(c as never);
        return fauxAssistantMessage("drafted");
      },
    ]);
    await client.submit(home, "draft a crawl plan", { whenBusy: "reject" });
    await drain();
    expect(result).toContain("Plan drafted");
    expect((await client.getThread(home)).pendingCards ?? []).toHaveLength(0);
  });
});
