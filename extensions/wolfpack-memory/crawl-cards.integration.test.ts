/**
 * The crawl questionnaire through ask cards, end to end over /v1: wolfd boots with the REAL wolfpack-memory durable
 * bundle from `extensions: [memory]` (crawl tools + the askCards capability from run.ts), the scripted model follows the
 * crawl directive, raises batched / confirm cards, the answers arrive as the next submission and drive crawl_plan.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import esbuild from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
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
afterEach(async () => {
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
    env: { WOLFPACK_MODELS_FILE: join(root, "models.json"), WOLFPACK_CRAWL_HOME: join(root, "crawls") },
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

describe("crawl questionnaire via ask cards (/v1, scripted model)", { timeout: 60_000 }, () => {
  it("interviews through batched + confirm cards and the plan reflects the answers", async () => {
    const src = tmp("src");
    mkdirSync(join(src, "docs", "guides"), { recursive: true });
    mkdirSync(join(src, "notes"), { recursive: true });
    writeFileSync(join(src, "docs", "a.md"), "# A\nalpha\n");
    writeFileSync(join(src, "docs", "guides", "b.md"), "# B\nbeta\n");
    writeFileSync(join(src, "notes", "c.md"), "# C\ngamma\n");
    writeFileSync(join(src, "notes", "skip.txt"), "skip me\n");

    let directive = "";
    let answersSeen = "";
    let planResult = "";
    let finalized = "";
    const { root, client, home, scripted, drain } = await boot([
      // 1. the user asked to crawl: start the questionnaire
      toolUse(fauxToolCall("crawl_start", { path: src })),
      // 2. the directive (tool result) says to batch into one card: do exactly that
      (c) => {
        directive = lastToolResult(c as never);
        return toolUse(
          fauxToolCall("ask_user_question", {
            title: "Crawl plan",
            questions: [
              { id: "domain", question: "Target KB domain", options: [{ label: "wolfpack" }] },
              { id: "strategy", question: "Grouping strategy", options: [{ label: "by-folder (Recommended)", value: "by-folder" }, { label: "by-pattern", value: "by-pattern" }] },
              { id: "depth", question: "Folder depth", options: [{ label: "1" }, { label: "2" }, { label: "3" }] },
              { id: "scope", question: "Scope", options: [{ label: "Whole tree", value: "whole" }, { label: "Only some files", value: "some" }] },
            ],
          }),
        );
      },
      // 3. the answers arrive as the next submission; the plan call follows them
      (c) => {
        answersSeen = lastUser(c as never);
        return toolUse(fauxToolCall("crawl_plan", { path: src, domain: "wolfpack", strategy: "by-folder", depth: 2, include: ["**/*.md"], exclude: ["notes/**"] }));
      },
      (c) => {
        planResult = lastToolResult(c as never);
        return toolUse(fauxToolCall("crawl_preview", {}));
      },
      toolUse(fauxToolCall("ask_user_question", { kind: "confirm", question: "Does this plan look good?", confirmLabel: "Looks good — add to plan", rejectLabel: "Edit it" })),
      (c) => {
        expect(lastUser(c as never)).toContain("Looks good — add to plan");
        return toolUse(fauxToolCall("crawl_finalize", {}));
      },
      (c) => {
        finalized = lastToolResult(c as never);
        return fauxAssistantMessage("Plan is ready. Run /wolf:crawl-run.");
      },
    ]);

    await client.submit(home, `crawl ${src}`, { whenBusy: "reject" });
    await drain();

    // the interview is a card in the thread, not a deterministic draft
    expect(directive).toContain("ONE ask_user_question call whose `questions` list");
    expect(directive).toContain(`\`${src}\``);
    const d1 = await client.getThread(home);
    expect(d1.status).toBe("needs-you");
    const [p1] = d1.pendingCards!;
    expect(p1.card).toMatchObject({ tool: "ask_user_question", title: "Crawl plan" });
    expect(p1.card.fields.map((f) => [f.id, f.kind])).toEqual([["domain", "single"], ["strategy", "single"], ["depth", "single"], ["scope", "single"]]);
    expect(scripted.faux.state.callCount).toBe(2);

    await client.answerCard!(home, p1.callId, {
      domain: { value: "wolfpack" },
      strategy: { value: "by-folder" },
      depth: { value: "2" },
      scope: { value: "include: **/*.md; exclude: notes/**", other: true },
    });
    await drain();
    expect(answersSeen).toContain("Folder depth: 2");
    expect(answersSeen).toContain("Scope: ");
    expect(planResult).toContain("Plan written");

    // the plan on disk reflects the answers: domain, strategy, scope (and only the in-scope files are batched)
    const d2 = await client.getThread(home);
    expect(d2.status).toBe("needs-you");
    const [p2] = d2.pendingCards!;
    expect(p2.card.fields[0]).toMatchObject({ kind: "confirm", label: "Does this plan look good?" });
    await client.answerCard!(home, p2.callId, { confirm: { value: true } });
    await drain();

    expect(finalized).toContain("status: ready");
    const planPath = /plan: (\S+plan\.yaml)/.exec(finalized)![1];
    expect(planPath.startsWith(join(root, "crawls"))).toBe(true);
    const plan = readPlan(planPath);
    expect(plan).toMatchObject({ status: "ready", domain: "wolfpack", source: src, include: ["**/*.md"], exclude: ["notes/**"] });
    // depth 2 splits docs/ from docs/guides/; the excluded notes/ never made it in
    expect(plan.batches.map((b) => b.topic).sort()).toEqual(["docs", "docs-guides"]);
    expect(readFileSync(planPath, "utf8")).toContain("status: ready");
    expect((await client.getThread(home)).status).toBe("idle");
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
