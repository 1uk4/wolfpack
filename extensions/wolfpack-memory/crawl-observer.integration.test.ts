/**
 * Full-transcript observer, driven through a real sandboxed durable wolf (startTestWolf: real sqlite + pi-durable,
 * /v1 over HTTP, scripted model). The memory Engine is the stubbed `engine.call` seam; forks and task-owned
 * conversations are created through the opened Harness (engine.harness), because /v1 only drives the home thread.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { ENGINE_CONTEXT as ctx } from "../../packages/harness/src/engine/index.js";
import { conversationReaderFor } from "../../packages/harness/src/engine/conversation-reader.js";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "../../packages/harness/src/wolfd/scripted-model.js";
import { Park, parkExtension, startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import createMemoryExtension from "./unified.js";
import createCrawlExtension from "./unified-crawl.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `crawl-obs-${p}-`));
  dirs.push(d);
  return d;
};
let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

/** Pads a marker into a sentence long enough to pass the observer's minimum text length. */
const say = (marker: string) => `${marker}: we decided to cache the session lookups for five minutes because the profile endpoint was the hot path.`;
const reply = (marker: string) => fauxAssistantMessage(say(marker));
const toolTurn = (callMarker: string): FauxResponseStep =>
  fauxAssistantMessage([fauxText(say(callMarker)), fauxToolCall("write", { path: "out.txt", content: "TOOLFILE" })], { stopReason: "toolUse" });

/** Engine stub: every classify call is recorded (its prompt) and yields one distinct observation. */
function stubEngine(opts: { failClassifyCall?: number } = {}) {
  const prompts: string[] = [];
  const steps: string[] = [];
  let classifyCalls = 0;
  const engine = {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }, args: { prompt: string }) => {
      steps.push(step);
      if (step === "classify") {
        if (opts.failClassifyCall === ++classifyCalls) throw new Error("boom");
        prompts.push(args.prompt);
        return schema.parse({ observations: [{ timestamp: `2026-10-25 10:${String(prompts.length).padStart(2, "0")}`, content: `Observation number ${prompts.length} about caching` }] });
      }
      if (step === "consolidate") {
        return schema.parse({
          actions: [{ sessionTopicId: "x", action: "create", reasoning: "new", result: { id: "caching", title: "Caching", summary: "Session lookups are cached", body: "Cache session lookups for five minutes." } }],
        });
      }
      if (step === "distill") {
        return schema.parse({ contributions: [{ slug: "main", title: "Caching", summary: "Session lookups are cached", body: "## Details\nCache session lookups." }] });
      }
      throw new Error(`unexpected step ${step}`);
    },
  } as unknown as Engine;
  return { engine, prompts, steps, text: () => prompts.join("\n=====\n") };
}

async function devRoot(): Promise<string> {
  const live = tmp("live");
  const work = join(live, "work");
  const srv = await startLocalWorkServer({ ledgerDir: work, token: "live-fixture" });
  await srv.close();
  mkdirSync(join(live, "ops"), { recursive: true });
  mkdirSync(join(live, "den"), { recursive: true });
  const dev = join(tmp("dev"), "snap");
  takeSnapshot({ source: { workDir: work, workBaseDir: join(work, "base"), opsDir: join(live, "ops"), denDir: join(live, "den") }, devRoot: dev });
  return dev;
}

function startObserverWolf(opts: { dev: string; script: FauxResponseStep[]; engine: Engine; memoryYaml?: string }) {
  return startTestWolf({
    script: opts.script,
    yaml: `sandbox:\n  root: ${opts.dev}\n${opts.memoryYaml ?? ""}`,
    hooks: {
      extensions: ({ config, den, env }) => [
        parkExtension,
        adaptToDurable(
          createMemoryExtension(
            // config.memory is the wolf.yaml memory block as the loader normalizes it (incl. consolidation).
            { ...config.memory, engine: opts.engine },
            { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: { sandbox: config.sandbox }, env },
          ),
          { wolfDen: den, wolfName: "testwolf" },
        ),
        adaptToDurable(createCrawlExtension({}, { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: {}, env, capabilities: { askCards: true } }), { wolfDen: den, wolfName: "testwolf" }),
      ],
    },
  });
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
/** Positive signal: the conversation's watermark has caught up with its newest committed entry (observation done). */
async function observed(t: TestWolf, cid = 1): Promise<void> {
  const den = t.wolf.config.den;
  const reader = conversationReaderFor(den)!;
  await waitFor(async () => {
    const msgs = await reader.messagesSince(cid, 0);
    if (!msgs.length || !existsSync(watermarkFile(den, cid))) return false;
    return JSON.parse(readFileSync(watermarkFile(den, cid), "utf8")).lastEntryId >= msgs[msgs.length - 1].entryId;
  });
}
/** Negative case only (nothing to wait for): a short quiet period. */
const quiet = () => new Promise((r) => setTimeout(r, 300));
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const watermarkFile = (den: string, cid: number) => join(den, ".memory", "watermarks", `${cid}.json`);


describe("durable observer pauses during crawl planning", () => {
  it("skips the planning turns of the conversation and resumes (past them) after crawl_cancel", async () => {
    const dev = await devRoot();
    const stub = stubEngine();
    const src = tmp("PLANSRC");
    writeFileSync(join(src, "note.md"), "# n\n");
    tw = await startObserverWolf({
      dev,
      engine: stub.engine,
      script: [
        reply("A_BEFORE"),
        fauxAssistantMessage([fauxToolCall("crawl_start", { path: src, draft: true })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText(say("PLAN_CHATTER")), fauxToolCall("crawl_plan", { path: src })], { stopReason: "toolUse" }),
        reply("PLAN_DONE_CHATTER"),
        fauxAssistantMessage([fauxToolCall("crawl_cancel", {})], { stopReason: "toolUse" }),
        reply("A_CANCELLED"),
        reply("A_AFTER"),
      ],
    });
    await tw.submit(say("USER_BEFORE"));
    await observed(tw);
    await tw.submit(say("USER_CRAWL"));
    await tw.submit(say("USER_CANCEL"));
    await tw.submit(say("USER_AFTER"));
    // the re-seed also advances the watermark, so wait for the positive signal itself, then a quiet period
    await waitFor(() => stub.text().includes("A_AFTER"));
    await quiet();

    const all = stub.text();
    expect(all).toContain("USER_BEFORE");
    expect(all).toContain("USER_AFTER");
    expect(all).toContain("A_AFTER");
    for (const planning of ["PLAN_CHATTER", "PLAN_DONE_CHATTER", "PLANSRC", "Plan drafted"]) expect(all).not.toContain(planning);
  });
});
