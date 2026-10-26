/**
 * Sandbox + fail-closed memory gate, driven through a real durable wolf (startTestWolf: real sqlite + pi-durable,
 * /v1 over HTTP, scripted model). "Live" is a temp fixture standing in for sfo-01; no real root, host or env is
 * read or written.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { fauxAssistantMessage } from "../../packages/harness/src/wolfd/scripted-model.js";
import { getSweepManager } from "../../packages/harness/src/sweep-worker.js";
import { startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import createMemoryExtension, { type MemoryConfig } from "./unified.js";
import createTasksExtension from "./unified-tasks.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `sbx-${p}-`));
  dirs.push(d);
  return d;
};
let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

const LONG_REPLY = "We decided to cache the session lookups for five minutes because the profile endpoint was the hot path in the load test. ".repeat(2);

/** Stub of the memory Engine: `classify` returns one observation per call. */
function stubEngine(): { engine: Engine; calls: string[] } {
  const calls: string[] = [];
  const engine = {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      calls.push(step);
      if (step === "classify") return schema.parse({ observations: [{ timestamp: "2026-10-25 10:00", content: "Cache session lookups for five minutes" }] });
      if (step === "workRecord") return schema.parse({ decisions: [{ decision: "Cache five minutes", why: "hot path" }], changes: [], findings: [], problems: [] });
      throw new Error(`unexpected step ${step}`);
    },
  } as unknown as Engine;
  return { engine, calls };
}

/** Build a "live host": a real ledger/work item (made through the work server), ops lanes, a den. */
async function liveFixture(): Promise<{ root: string; source: Parameters<typeof takeSnapshot>[0]["source"] }> {
  const root = tmp("live");
  const work = join(root, "work");
  const srv = await startLocalWorkServer({ ledgerDir: work, token: "live-fixture" });
  const res = await fetch(`${srv.url}/work`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "live-fixture" },
    body: JSON.stringify({ kind: "task", domain: "wolfpack", title: "live task", assignee: "owner", successCriteria: "ok" }),
  });
  expect(res.status).toBe(201);
  await srv.close();
  mkdirSync(join(root, "ops/inbox/testwolf"), { recursive: true });
  writeFileSync(join(root, "ops/inbox/testwolf/c1.md"), "contribution\n");
  mkdirSync(join(root, "ops/receipts/testwolf"), { recursive: true });
  mkdirSync(join(root, "den/memory"), { recursive: true });
  writeFileSync(join(root, "den/memory/t1.md"), "live topic\n");
  return { root, source: { workDir: work, workBaseDir: join(work, "base"), opsDir: join(root, "ops"), denDir: join(root, "den") } };
}

/** path -> sha256 for every file under dir (and the dir listing itself, so new/removed files show up). */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        out[p + "/"] = "dir";
        walk(p);
      } else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex") + ":" + statSync(p).size;
    }
  };
  walk(dir);
  return out;
}

function startMemoryWolf(opts: { yaml?: string; memory?: MemoryConfig; sandbox?: boolean; engine: Engine }) {
  return startTestWolf({
    script: [fauxAssistantMessage(LONG_REPLY)],
    yaml: opts.yaml,
    hooks: {
      extensions: ({ config, den, env }) => [
        adaptToDurable(
          createMemoryExtension(
            { ...opts.memory, engine: opts.engine },
            { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: { ...(config.sandbox ? { sandbox: config.sandbox } : {}) }, env },
          ),
          { wolfDen: den, wolfName: "testwolf" },
        ),
      ],
    },
  });
}

const poolFile = (den: string) => join(den, ".memory", "pool", "observations.jsonl");
const poolHas = (den: string) => existsSync(poolFile(den)) && readFileSync(poolFile(den), "utf8").includes("Cache session lookups");

describe("memory gate (fail closed)", () => {
  it("(a) is inert without sandbox or memory.live: a turn produces no pool file and no engine call", async () => {
    const { engine, calls } = stubEngine();
    tw = await startMemoryWolf({ engine });
    await tw.submit("hello");
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toEqual([]);
    expect(existsSync(poolFile(tw.wolf.config.den))).toBe(false);
  });

  it("(a, control) the same wolf with memory.live: true does observe", async () => {
    const { engine } = stubEngine();
    tw = await startMemoryWolf({ engine, memory: { live: true } });
    await tw.submit("hello");
    const den = tw.wolf.config.den;
    await waitFor(() => poolHas(den));
    expect(readFileSync(poolFile(den), "utf8")).toContain("Cache session lookups");
  });

  it("memory.enabled: false wins over live", async () => {
    const { engine, calls } = stubEngine();
    tw = await startMemoryWolf({ engine, memory: { live: true, enabled: false } });
    await tw.submit("hello");
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toEqual([]);
  });
});

describe("sandbox over a snapshot", () => {
  it("(b) a turn writes only under the dev root; the live fixture is byte-identical; Work writes hit the local server", async () => {
    const live = await liveFixture();
    const before = hashTree(live.root);
    const dev = join(tmp("dev"), "snap");
    takeSnapshot({ source: live.source, devRoot: dev });
    const devBefore = hashTree(dev);
    const { engine, calls } = stubEngine();

    tw = await startMemoryWolf({ engine, yaml: `sandbox:\n  root: ${dev}\n` });
    const sb = tw.wolf.sandbox!;
    expect(tw.wolf.config.den).toBe(join(dev, "den"));
    expect(sb.env).toMatchObject({ WOLF_DEN: join(dev, "den"), KB_OPS: join(dev, "ops"), KB_DEN_LOCAL: join(dev, "den", "kb") });
    expect(sb.resolved.workEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    await tw.submit("hello");
    await waitFor(() => poolHas(join(dev, "den")));
    expect(calls).toContain("classify");
    // session.sqlite etc. were created in the dev den, not the (non-existent) wolf-home den
    expect(existsSync(join(dev, "den", "session.sqlite"))).toBe(true);
    expect(existsSync(join(tw.wolf.config.dir, "den"))).toBe(false);

    // The snapshot ledger is served: the live item is visible, and a write lands in the dev ledger only.
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${sb.resolved.workEndpoint}/work${path}`, {
        method,
        headers: { "Content-Type": "application/json", "X-API-Key": sb.env.WORK_TOKEN },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const listed = JSON.stringify(await (await call("GET", "")).json());
    expect(listed).toContain("live task");
    const created = await call("POST", "", { kind: "task", domain: "wolfpack", title: "sandbox only", assignee: "owner", successCriteria: "ok" });
    expect(created.status).toBe(201);
    expect(readFileSync(join(dev, "ledger/work-events.jsonl"), "utf8")).toContain("sandbox only");

    expect(hashTree(live.root)).toEqual(before);
    expect(hashTree(dev)).not.toEqual(devBefore);
  });

  it("(c) refuses a root that is not a snapshot, and a sandbox whose env/den resolve outside the dev root", async () => {
    const { engine } = stubEngine();
    const notSnap = tmp("not-a-snapshot");
    await expect(startMemoryWolf({ engine, yaml: `sandbox:\n  root: ${notSnap}\n` })).rejects.toThrow(/not a snapshot/);
    expect(readdirSync(notSnap)).toEqual([]);

    // Extension level: wolfConfig says sandbox, but KB_OPS still points at a live location -> memory refuses to boot.
    const live = await liveFixture();
    const dev = join(tmp("dev"), "snap");
    takeSnapshot({ source: live.source, devRoot: dev });
    const ctx = (env: NodeJS.ProcessEnv, den = join(dev, "den")) => ({
      wolfDen: den, wolfName: "testwolf", domains: [], wolfConfig: { sandbox: { root: dev } }, env,
    });
    const goodEnv = { KB_OPS: join(dev, "ops"), WORK_ENDPOINT: "http://127.0.0.1:1" };
    expect(() => createMemoryExtension({}, ctx(goodEnv))).not.toThrow();
    expect(() => createMemoryExtension({}, ctx({ ...goodEnv, KB_OPS: join(live.root, "ops") }))).toThrow(/kbOps .* outside the dev root/);
    expect(() => createMemoryExtension({}, ctx({ ...goodEnv, KB_OPS: undefined }))).toThrow(/not set/);
    expect(() => createMemoryExtension({}, ctx({ ...goodEnv, WORK_ENDPOINT: "http://100.120.154.69:3141" }))).toThrow(/loopback/);
    expect(() => createMemoryExtension({}, ctx(goodEnv, join(live.root, "den")))).toThrow(/den .* outside the dev root/);
    expect(() => createMemoryExtension({}, { ...ctx(goodEnv), wolfConfig: { sandbox: true } })).toThrow(/no resolved dev root/);
  });
});

describe("sandbox: KB_BASE and task tools", () => {
  it("a Record write goes to the snapshot ledger via context.env, never the ambient WORK_ENDPOINT", async () => {
    const live = await liveFixture();
    const before = hashTree(live.root);
    const dev = join(tmp("dev"), "snap");
    takeSnapshot({ source: live.source, devRoot: dev });
    const { engine } = stubEngine();
    const ambient = { e: process.env.WORK_ENDPOINT, t: process.env.WORK_TOKEN };
    process.env.WORK_ENDPOINT = "http://127.0.0.1:9"; // a "live" endpoint that must never be used
    process.env.WORK_TOKEN = "live-token";
    try {
      let mem: ReturnType<typeof createMemoryExtension> | undefined;
      tw = await startTestWolf({
        script: [fauxAssistantMessage("ok")],
        yaml: `sandbox:\n  root: ${dev}\n`,
        hooks: {
          extensions: ({ config, den, env }) => {
            mem = createMemoryExtension({ engine }, { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: { sandbox: config.sandbox }, env });
            return [];
          },
        },
      });
      const sb = tw.wolf.sandbox!;
      // Process env now carries the sandbox patch; make the ambient one wrong again to prove context.env is used.
      process.env.WORK_ENDPOINT = "http://127.0.0.1:9";
      const created = await (await fetch(`${sb.resolved.workEndpoint}/work`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": sb.env.WORK_TOKEN },
        body: JSON.stringify({ kind: "feature", domain: "wolfpack", title: "rec feature", assignee: "owner" }),
      })).json() as { id: string };
      const pool = join(tw.wolf.config.den, ".memory", "pool");
      mkdirSync(pool, { recursive: true });
      writeFileSync(join(pool, "observations.jsonl"), JSON.stringify({ timestamp: "2026-10-25 10:00", content: "Cache session lookups", work: created.id, recordedAt: "2026-10-25T10:00:00Z" }) + "\n");
      const tool = mem!.tools!.find((t) => t.name === "memory_consolidate")!;
      const res = await tool.execute({}, { cwd: dev, wolfDen: tw.wolf.config.den, wolfName: "testwolf", conversationId: 1 });
      expect(res.isError).toBeFalsy();
      const body = await (await fetch(`${sb.resolved.workEndpoint}/work/${created.id}`, { headers: { "X-API-Key": sb.env.WORK_TOKEN } })).json() as { body?: string; item?: { body?: string } };
      expect(JSON.stringify(body)).toContain("Cache five minutes");
      expect(hashTree(live.root)).toEqual(before);
    } finally {
      if (ambient.e === undefined) delete process.env.WORK_ENDPOINT; else process.env.WORK_ENDPOINT = ambient.e;
      if (ambient.t === undefined) delete process.env.WORK_TOKEN; else process.env.WORK_TOKEN = ambient.t;
    }
  });

  it("refuses librarian mode in a sandbox (startWolf and the memory gate)", async () => {
    const live = await liveFixture();
    const dev = join(tmp("dev"), "snap");
    takeSnapshot({ source: live.source, devRoot: dev });
    const { engine } = stubEngine();
    await expect(startMemoryWolf({ engine, yaml: `sandbox:\n  root: ${dev}\nmemory:\n  librarian: true\n` })).rejects.toThrow(/librarian/);
    const env = { KB_OPS: join(dev, "ops"), WORK_ENDPOINT: "http://127.0.0.1:1" };
    expect(() =>
      createMemoryExtension({ librarian: true }, { wolfDen: join(dev, "den"), wolfName: "t", domains: [], wolfConfig: { sandbox: { root: dev } }, env }),
    ).toThrow(/librarian/);
  });

  it("allows librarian mode ONLY on a KB copy: the gate and startWolf accept a snapshot with kb-base and refuse one without", async () => {
    const live = await liveFixture();
    const kbLive = join(live.root, "kbbase");
    mkdirSync(join(kbLive, "domains/wolfpack/entries"), { recursive: true });
    writeFileSync(join(kbLive, "domains/wolfpack/entries/kb-wolfpack-x.md"), "entry\n");
    writeFileSync(join(kbLive, "domains.yaml"), "domains: [wolfpack]\n");
    const kbBefore = hashTree(kbLive);

    const dev = join(tmp("dev"), "snap");
    takeSnapshot({ source: { ...live.source, kbBaseDir: kbLive }, devRoot: dev });
    const ctx = (env: Record<string, string | undefined>, den = join(dev, "den")) => ({ wolfDen: den, wolfName: "dewey-dev", domains: ["wolfpack"], wolfConfig: { sandbox: { root: dev } }, env });
    const good = { KB_BASE: join(dev, "kb-base"), KB_OPS: join(dev, "ops"), WORK_ENDPOINT: "http://127.0.0.1:1" };
    expect(() => createMemoryExtension({ librarian: true }, ctx(good))).not.toThrow();
    // the live KB next to a copy is refused, by the base gate and by the librarian gate
    expect(() => createMemoryExtension({ librarian: true }, ctx({ ...good, KB_BASE: kbLive }))).toThrow(/KB_BASE/);
    expect(() => createMemoryExtension({ librarian: true }, ctx({ ...good, KB_BASE: undefined }))).toThrow(/KB_BASE/);
    // a den-local dir outside the root (the sweep lock and vectors live there) is refused
    expect(() => createMemoryExtension({ librarian: true }, ctx({ ...good, KB_DEN_LOCAL: join(live.root, "elsewhere") }))).toThrow(/outside/);

    const { engine } = stubEngine();
    tw = await startMemoryWolf({ engine, memory: { librarian: true }, yaml: `sandbox:\n  root: ${dev}\nmemory:\n  librarian: true\n` });
    expect(getSweepManager()).not.toBeNull(); // startWolf built the librarian's sweep manager on the KB copy
    expect(hashTree(kbLive)).toEqual(kbBefore);
  });

  it("with a live KB_BASE fixture, a sandboxed turn leaves it byte-identical; a task tool writes only the snapshot ledger", async () => {
    const live = await liveFixture();
    const kbBase = join(live.root, "kbbase");
    mkdirSync(join(kbBase, "domains/wolfpack/entries"), { recursive: true });
    writeFileSync(join(kbBase, "domains/wolfpack/entries/kb-wolfpack-x.md"), "entry\n");
    const before = hashTree(live.root);
    const dev = join(tmp("dev"), "snap");
    takeSnapshot({ source: live.source, devRoot: dev });
    const { engine } = stubEngine();
    let tasks: ReturnType<typeof createTasksExtension> | undefined;
    tw = await startTestWolf({
      script: [fauxAssistantMessage(LONG_REPLY)],
      yaml: `sandbox:\n  root: ${dev}\n`,
      hooks: {
        extensions: ({ config, den, env }) => {
          const senv = { ...env, KB_BASE: kbBase };
          const ctx = { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: { sandbox: config.sandbox }, env: senv };
          tasks = createTasksExtension({}, ctx);
          return [adaptToDurable(createMemoryExtension({ engine }, ctx), { wolfDen: den, wolfName: "testwolf" })];
        },
      },
    });
    await tw.submit("hello");
    await waitFor(() => poolHas(join(dev, "den")));
    const create = tasks!.tools!.find((t) => t.name === "task_create")!;
    // Deliberately NOT process.env: a live endpoint in the ambient env must not be used.
    const res = await create.execute(
      { kind: "task", domain: "wolfpack", title: "tool-made task", successCriteria: "ok", bind: false },
      { cwd: dev, wolfDen: join(dev, "den"), wolfName: "testwolf", conversationId: 1 },
    );
    expect(res.isError ? JSON.stringify(res.content) : "").toBe("");
    expect(readFileSync(join(dev, "ledger/work-events.jsonl"), "utf8")).toContain("tool-made task");
    expect(hashTree(live.root)).toEqual(before);
  });
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
