/**
 * The crawl run wizard as ONE stepped card, end to end over /v1: the REAL durable bundle (crawl_run raising the card), the
 * scripted model, wolfd validating the answers (a hidden field is not required). The run engine is the real one, so a run
 * that gets past the card fails fast at engine creation (the scripted provider is not an engine provider): no LLM, no live KB.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import esbuild from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpConsoleClient } from "@wolfpack/client";
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
const answerTo = (submission: string, label: string): string | undefined => new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (.*)$`, "m").exec(submission)?.[1];
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


function makeSource(): string {
  const src = tmp("src");
  mkdirSync(join(src, "docs"), { recursive: true });
  mkdirSync(join(src, "notes"), { recursive: true });
  writeFileSync(join(src, "docs", "a.md"), "# A\nalpha\n");
  writeFileSync(join(src, "notes", "c.md"), "# C\ngamma\n");
  return src;
}
const planPathOf = (s: string) => /plan: (\S+plan\.yaml)/.exec(s)![1];

/** plan → finalize → (seed an unfinished run of the plan) → crawl_run, which raises the wizard card. */
const prefix = (src: string, state: { root?: string; planPath: string; seeded: string }) => [
  toolUse(fauxToolCall("crawl_plan", { path: src, domain: "wolfpack", strategy: "by-folder", depth: 1 })),
  toolUse(fauxToolCall("crawl_finalize", {})),
  (c: unknown) => {
    state.planPath = planPathOf(lastToolResult(c as never));
    // an unfinished run of this plan: extraction began, one of the two batches never landed
    state.seeded = join(state.root!, "crawls", "run-old");
    mkdirSync(state.seeded, { recursive: true });
    copyFileSync(state.planPath, join(state.seeded, "plan.yaml"));
    writeFileSync(join(state.seeded, "observations.jsonl"), "");
    writeFileSync(join(state.seeded, "topics.json"), JSON.stringify([["docs", {}]]));
    return toolUse(fauxToolCall("crawl_run", { planPath: state.planPath }));
  },
];

describe("crawl run wizard as a stepped card (/v1, scripted model)", { timeout: 60_000 }, () => {
  it("one stepped card; fresh needs a concurrency, cancel hides it; cancel starts nothing", async () => {
    const state = { root: undefined as string | undefined, planPath: "", seeded: "" };
    let reply = "";
    const script: unknown[] = [];
    const b = await boot([
      ...(prefix(makeSource(), state) as never[]),
      (c: unknown) => {
        reply = lastUser(c as never);
        return fauxAssistantMessage("not running it");
      },
    ]);
    state.root = b.root;
    void script;
    await b.client.submit(b.home, "run the crawl", { whenBusy: "reject" });
    await b.drain();
    const d1 = await b.client.getThread(b.home);
    expect(d1.status).toBe("needs-you");
    const [p1] = d1.pendingCards!;
    expect(p1.card.tool).toBe("crawl_run");
    expect(p1.card.steps).toEqual([{ title: "Resume", fields: ["resume"] }, { title: "Concurrency", fields: ["concurrency"] }]);
    expect(p1.card.fields.map((f) => f.id)).toEqual(["resume", "concurrency"]);
    expect(p1.card.fields[1].showIf).toEqual({ field: "resume", oneOf: [state.seeded, "fresh"] });
    expect((p1.card.fields[0] as { options: { value: string }[] }).options.map((o) => o.value)).toEqual([state.seeded, "fresh", "cancel"]);

    await expect(b.client.answerCard!(b.home, p1.callId, { resume: { value: "fresh" } })).rejects.toMatchObject({ code: "invalid_request" }); // concurrency required
    await expect(b.client.answerCard!(b.home, p1.callId, { resume: { value: "cancel" }, concurrency: { value: "8" } })).rejects.toMatchObject({ code: "invalid_request" }); // hidden
    await b.client.answerCard!(b.home, p1.callId, { resume: { value: "cancel" } });
    await b.drain();
    expect(reply).toContain("- Resume the outstanding crawl?: cancel");
    expect(reply).not.toContain("How many batches");
    expect((await b.client.getThread(b.home)).status).toBe("idle");
  });

  it("fresh + 8 reach crawl_run (answers are held to one submission); the real engine refuses the scripted provider without any LLM call", async () => {
    const state = { root: undefined as string | undefined, planPath: "", seeded: "" };
    let reply = "";
    let startResult = "";
    const b = await boot([
      ...(prefix(makeSource(), state) as never[]),
      (c: unknown) => {
        reply = lastUser(c as never);
        return toolUse(fauxToolCall("crawl_run", { planPath: state.planPath, resume: "fresh", concurrency: 8 }));
      },
      (c: unknown) => {
        startResult = lastToolResult(c as never);
        return fauxAssistantMessage("could not start");
      },
    ]);
    state.root = b.root;
    await b.client.submit(b.home, "run the crawl", { whenBusy: "reject" });
    await b.drain();
    const [p1] = (await b.client.getThread(b.home)).pendingCards!;
    await b.client.answerCard!(b.home, p1.callId, { resume: { value: "fresh" }, concurrency: { value: "8" } });
    await b.drain();
    expect(reply).toContain("- How many batches to run at once?: 8");
    expect(startResult).toContain("crawl run failed to start");
    const call = (await b.client.getThread(b.home)).messages.flatMap((m) => m.tools ?? []).find((t) => t.name === "crawl_run" && t.answer);
    expect(call?.answer).toEqual({ resume: { value: "fresh" }, concurrency: { value: "8" } });
    const names = readdirSync(join(b.root, "crawls"));
    expect(names).toHaveLength(2); // the plan dir and the seeded run: the refused start created no run dir
    expect(names.filter((n) => n.startsWith("run-"))).toEqual(["run-old"]);
  });
});
