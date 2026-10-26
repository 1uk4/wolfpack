/**
 * Per-observation domain classification on the durable observer, through a real sandboxed durable wolf (startTestWolf)
 * and the createWolfHarness-style path. Parity with pi's orchestrator: domain context is built once when the wolf
 * subscribes to more than one domain, the model tags each observation, and untagged ones are stamped with the
 * wolf.yaml `memory.defaultDomain` (default: first domain) at observe time. A work binding adds `work`, never a domain.
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { loadWolfConfig, takeSnapshot, WolfConfigError } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { conversationReaderFor } from "../../packages/harness/src/engine/conversation-reader.js";
import { fauxAssistantMessage } from "../../packages/harness/src/wolfd/scripted-model.js";
import { parkExtension, startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import createMemoryExtension from "./unified.js";
import { writeBindingFile } from "./conversation-binding.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `dom-${p}-`));
  dirs.push(d);
  return d;
};
let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const say = (marker: string) => `${marker}: we decided to cache the session lookups for five minutes because the profile endpoint was the hot path.`;

/** A KB_BASE fixture shaped like the real one: domains.yaml registry plus per-domain digests. */
function kbFixture(): string {
  const kb = tmp("kb");
  writeFileSync(
    join(kb, "domains.yaml"),
    "domains:\n  billing:\n    label: Billing\n    description: Invoices, payments and ledgers\n  devtools:\n    label: Devtools\n    description: Build tooling and CI\n",
  );
  for (const d of ["billing", "devtools"]) mkdirSync(join(kb, "domains", d, "entries"), { recursive: true });
  return kb;
}

/** Classify stub: DOM_<name> in the chunk tags the observation with <name>; no marker leaves it untagged. */
function stubEngine() {
  const systems: string[] = [];
  const engine = {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }, args: { system: string; prompt: string }) => {
      if (step !== "classify") throw new Error(`unexpected step ${step}`);
      systems.push(args.system);
      const dom = args.prompt.match(/DOM_([a-z]+)/)?.[1];
      return schema.parse({ observations: [{ timestamp: "2026-10-25 10:00", content: "Cache lookups", ...(dom ? { domain: dom } : {}) }] });
    },
  } as unknown as Engine;
  return { engine, systems };
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

async function startDomainWolf(opts: { domains: string[]; memoryYaml?: string; engine: Engine; kb: string; replies: string[]; beforeTurn?: (den: string) => void }) {
  const dev = await devRoot();
  const domainsYaml = `domains: [${opts.domains.join(", ")}]\n`;
  tw = await startTestWolf({
    script: opts.replies.map((r) => fauxAssistantMessage(r)),
    yaml: `${domainsYaml}sandbox:\n  root: ${dev}\n${opts.memoryYaml ? `memory:\n${opts.memoryYaml}` : ""}`,
    hooks: {
      extensions: ({ config, den, env }) => [
        parkExtension,
        adaptToDurable(
          createMemoryExtension(
            { ...config.memory, engine: opts.engine },
            { wolfDen: den, wolfName: "testwolf", domains: config.identity.domains, wolfConfig: { sandbox: config.sandbox }, env: { ...env, KB_BASE: opts.kb } },
          ),
          { wolfDen: den, wolfName: "testwolf" },
        ),
      ],
    },
  });
  opts.beforeTurn?.(tw.wolf.config.den);
  return tw;
}

async function observedAll(t: TestWolf): Promise<void> {
  const den = t.wolf.config.den;
  const reader = conversationReaderFor(den)!;
  const wm = join(den, ".memory", "watermarks", "1.json");
  const end = Date.now() + 4000;
  for (;;) {
    const msgs = await reader.messagesSince(1, 0);
    if (msgs.length && existsSync(wm) && JSON.parse(readFileSync(wm, "utf8")).lastEntryId >= msgs[msgs.length - 1].entryId) return;
    if (Date.now() > end) throw new Error("timed out waiting for the observer");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const pool = (den: string): Array<{ content: string; domain?: string; work?: string }> =>
  readFileSync(join(den, ".memory", "pool", "observations.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("per-observation domain classification (durable)", () => {
  it("(a) a 2-domain wolf puts domain context in the observe prompt and keeps the tags the model returned", async () => {
    const stub = stubEngine();
    const t = await startDomainWolf({ domains: ["billing", "devtools"], engine: stub.engine, kb: kbFixture(), replies: [say("billing reply"), say("devtools reply")] });
    await t.submit(say("DOM_billing user"));
    await observedAll(t);
    await t.submit(say("DOM_devtools user"));
    await observedAll(t);
    expect(stub.systems[0]).toContain("Domains this wolf subscribes to:");
    expect(stub.systems[0]).toContain("- billing: Invoices, payments and ledgers");
    expect(stub.systems[0]).toContain("- devtools: Build tooling and CI");
    const doms = pool(t.wolf.config.den).map((o) => o.domain);
    expect(doms).toContain("billing");
    expect(doms).toContain("devtools");
  });

  it("(b) an untagged observation gets wolf.yaml memory.defaultDomain, else the first domain", async () => {
    const stub = stubEngine();
    const t = await startDomainWolf({ domains: ["billing", "devtools"], memoryYaml: "  defaultDomain: devtools\n", engine: stub.engine, kb: kbFixture(), replies: [say("plain reply")] });
    await t.submit(say("plain user"));
    await observedAll(t);
    expect(pool(t.wolf.config.den).every((o) => o.domain === "devtools")).toBe(true);
    await t.stop();

    const stub2 = stubEngine();
    const t2 = await startDomainWolf({ domains: ["billing", "devtools"], engine: stub2.engine, kb: kbFixture(), replies: [say("plain reply")] });
    await t2.submit(say("plain user"));
    await observedAll(t2);
    expect(pool(t2.wolf.config.den).every((o) => o.domain === "billing")).toBe(true);
  });

  it("(c) a single-domain wolf: no domain context, everything stamped with that domain", async () => {
    const stub = stubEngine();
    const t = await startDomainWolf({ domains: ["billing"], engine: stub.engine, kb: kbFixture(), replies: [say("plain reply")] });
    await t.submit(say("plain user"));
    await observedAll(t);
    expect(stub.systems.join("\n")).not.toContain("Domain Classification");
    const obs = pool(t.wolf.config.den);
    expect(obs.length).toBeGreaterThan(0);
    expect(obs.every((o) => o.domain === "billing")).toBe(true);
  });

  it("(d) a defaultDomain outside the subscribed domains is rejected at load", async () => {
    const dir = tmp("cfg");
    const file = join(dir, "wolf.yaml");
    writeFileSync(file, "name: w\ndomains: [billing, devtools]\nmemory:\n  defaultDomain: nope\n");
    expect(() => loadWolfConfig(file)).toThrow(WolfConfigError);
    expect(() => loadWolfConfig(file)).toThrow(/defaultDomain "nope" is not one of the subscribed domains/);
    await expect(startDomainWolf({ domains: ["billing"], memoryYaml: "  defaultDomain: nope\n", engine: stubEngine().engine, kb: kbFixture(), replies: [] })).rejects.toThrow(/defaultDomain/);
    writeFileSync(file, "name: w\ndomains: [billing, devtools]\nmemory:\n  defaultDomain: devtools\n");
    expect(loadWolfConfig(file).config.memory.defaultDomain).toBe("devtools");
  });

  it("(e) a bound observation keeps its classified domain (as pi) and gains the work tag; untagged gets the default", async () => {
    const stub = stubEngine();
    const t = await startDomainWolf({
      domains: ["billing", "devtools"],
      engine: stub.engine,
      kb: kbFixture(),
      replies: [say("plain reply")],
      beforeTurn: (den) => writeBindingFile(den, 1, { workId: "work-x-1", domain: "devtools", boundAt: "2026-10-25T00:00:00Z" }),
    });
    await t.submit(say("DOM_billing user"));
    await observedAll(t);
    const obs = pool(t.wolf.config.den);
    expect(obs.every((o) => o.work === "work-x-1")).toBe(true);
    expect(obs.some((o) => o.domain === "billing")).toBe(true); // classified, not the binding's devtools
    expect(obs.every((o) => o.domain)).toBe(true);
  });
});
