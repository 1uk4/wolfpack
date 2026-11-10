/**
 * The crawl questionnaire through ask cards, end to end over /v1: wolfd boots with the REAL wolfpack-memory durable
 * bundle from `extensions: [memory]` (crawl tools + the askCards capability from run.ts), the scripted model follows the
 * crawl directive, raises batched / confirm cards, the answers arrive as the next submission and drive crawl_plan.
 */
import { answerPaged } from "../../packages/harness/src/wolfd/test-ask-call.js";
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
  const raw = new RegExp(`^- (?:Q\\d+ )?${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (.*)$`, "m").exec(submission)?.[1];
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

const choice = (label: string, value = label) => ({ label, value, tradeoff: `Picks ${label}.` });
const q = (id: string, ask: string, kind: string, choices?: ReturnType<typeof choice>[]) => ({ id, ask, kind, required: true, ...(choices ? { choices } : {}) });
/** The directive's ONE ask: page 1 where, page 2 shape. */
const questionnaire = () =>
  toolUse(
    fauxToolCall("ask", {
      pages: [
        { title: "Crawl plan: where", questions: [q("domain", "Target KB domain", "single", [choice("wolfpack")])] },
        {
          title: "Crawl plan: shape",
          questions: [
            q("strategy", "Grouping strategy", "single", [choice("by-folder (Recommended)", "by-folder"), choice("by-pattern")]),
            q("depth", "Folder depth", "single", [choice("1"), choice("2"), choice("3")]),
            q("scope", "Scope", "single", [choice("Whole tree", "whole"), choice("Only some files", "some")]),
          ],
        },
      ],
    }),
  );
const confirm = () => toolUse(fauxToolCall("ask", { pages: [{ title: "Crawl plan", questions: [q("confirm", "Does this plan look good?", "confirm")] }] }));
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
        expect(lastUser(c as never)).toContain("- Q1 Does this plan look good?: yes");
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
    expect(directive).toContain("ONE ask call");
    expect(directive).toContain(`\`${src}\``);
    expect(directive).not.toContain("/wolf:crawl-run");
    const d1 = await client.getThread(home);
    expect(d1.status).toBe("needs-you");
    expect(d1.pendingCards).toHaveLength(1); // ONE ask, two pages
    const [card] = d1.pendingCards!;
    expect(card.card).toMatchObject({ tool: "ask", paged: true, steps: [{ title: "Crawl plan: where", fields: ["domain"] }, { title: "Crawl plan: shape", fields: ["strategy", "depth", "scope"] }] });
    expect(card.card.fields.map((f) => [f.id, f.kind])).toEqual(["domain", "strategy", "depth", "scope"].map((id) => [id, "single"]));
    expect(scripted.faux.state.callCount).toBe(2);

    await answerPaged(client, home, card.callId, {
      domain: { value: "wolfpack" },
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
    await answerPaged(client, home, p2.callId, { confirm: { value: true } });
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

  it("a bad path is reported by crawl_plan and the model re-asks", async () => {
    const src = makeSource();
    const bad = join(src, "does-not-exist");
    let badResult = "";
    let finalized = "";
    const { client, home, drain } = await boot([
      toolUse(fauxToolCall("crawl_start", {})),
      toolUse(fauxToolCall("ask", { pages: [{ title: "Crawl source", questions: [q("source", "Which directory should I crawl?", "free")] }] })),
      (c) => toolUse(fauxToolCall("crawl_plan", { path: answerTo(lastUser(c as never), "Which directory should I crawl?") })),
      (c) => {
        badResult = lastToolResult(c as never);
        return toolUse(fauxToolCall("ask", { pages: [{ title: "Crawl source", questions: [q("source", "That path does not exist. Which directory should I crawl?", "free")] }] }));
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
    await answerPaged(client, home, q1.callId, { source: { value: bad } });
    await drain();
    expect(badResult).toContain(`source is not a directory: ${bad}`);
    const d = await client.getThread(home);
    expect(d.status).toBe("needs-you"); // re-asked
    const [q2] = d.pendingCards!;
    expect(q2.card.fields[0].label).toContain("does not exist");
    await answerPaged(client, home, q2.callId, { source: { value: src } });
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
        expect(lastUser(c as never)).toContain("- Q1 Does this plan look good?: no");
        return toolUse(fauxToolCall("ask", { pages: [{ title: "Crawl plan", questions: [q("answer", "What should change?", "free")] }] }));
      },
      (c) => toolUse(fauxToolCall("crawl_plan", { path: src, domain: "wolfpack", strategy: "by-folder", depth: 2, exclude: [answerTo(lastUser(c as never), "What should change?")] })),
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
    await answerPaged(client, home, c1.callId, { confirm: { value: false } });
    await drain();
    const [edit] = (await client.getThread(home)).pendingCards!;
    expect(edit.card.fields[0]).toMatchObject({ kind: "free-text", label: "What should change?" });
    await answerPaged(client, home, edit.callId, { answer: { value: "notes/**" } });
    await drain();
    const [c2] = (await client.getThread(home)).pendingCards!;
    // nothing was finalized yet: the first plan is still a draft on disk
    expect(plans).toHaveLength(2);
    expect(readPlan(/Plan written: (\S+plan\.yaml)/.exec(plans[0])![1]).status).toBe("draft");
    await answerPaged(client, home, c2.callId, { confirm: { value: true } });
    await drain();
    const final = readPlan(planPathOf(finalized));
    expect(final).toMatchObject({ status: "ready", exclude: ["notes/**"] });
    expect(final.batches.map((b) => b.topic).sort()).toEqual(["docs", "docs-guides"]);
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
