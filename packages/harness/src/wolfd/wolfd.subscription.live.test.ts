/**
 * LIVE (subscription): one real wolf process on the pi-claude-bridge provider, billed to the Claude subscription via
 * the operator's Claude Code login. ANTHROPIC_API_KEY is removed from the wolf's env (and from this process for the
 * duration), so a turn that succeeds cannot have used the metered key. Skipped unless WOLFD_LIVE=1 (never in CI);
 * a key in the caller's env is tolerated, not required.
 *   WOLFD_LIVE=1 npm test -w @wolfpack/harness -- wolfd.subscription.live
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpConsoleClient, type ThreadEvent } from "@wolfpack/client";
import { startWolf, type RunningWolf } from "./run.js";

const live = Boolean(process.env.WOLFD_LIVE);

describe.skipIf(!live)("wolfd live (subscription via claude-bridge, no API key)", () => {
  let root: string;
  let wolf: RunningWolf;
  let client: HttpConsoleClient;
  let savedKey: string | undefined;
  const HOME = "subwolf/home";

  beforeAll(async () => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    root = mkdtempSync(join(tmpdir(), "wolfd-sublive-"));
    const tier = { model: "claude-haiku-5-5", modelSource: "default", provider: "claude-agent-sdk", piModel: "claude-bridge/claude-haiku-5-5" };
    writeFileSync(
      join(root, "models.json"),
      JSON.stringify({ location: "local", transport: "subscription", transportSource: "default", tiers: { main: tier, smart: tier, fast: tier }, steps: {}, warnings: [] }),
    );
    const work = join(root, "work");
    mkdirSync(work);
    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "zebra-quartz-fixture", version: "1.0.0" }));
    writeFileSync(join(root, "wolf.yaml"), `name: subwolf\nworkspace: ${work}\n`);
    const { ANTHROPIC_API_KEY: _absent, ...env } = process.env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    wolf = await startWolf({ configPath: join(root, "wolf.yaml"), env: { ...env, WOLFPACK_MODELS_FILE: join(root, "models.json") }, home: root });
    client = new HttpConsoleClient({ baseUrl: wolf.url });
  }, 30_000);

  afterAll(async () => {
    await wolf?.close();
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    rmSync(root, { recursive: true, force: true });
  });

  const collect = async (it: AsyncIterable<ThreadEvent>) => {
    const out: ThreadEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  };

  it("chat turn completes", async () => {
    const ack = await client.submit(HOME, "Reply with exactly one word: pong", { whenBusy: "reject" });
    expect(ack.disposition).toBe("started");
    const events = await collect(client.watch(HOME));
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
    const detail = await client.getThread(HOME);
    expect(detail.messages.at(-1)?.text.toLowerCase()).toContain("pong");
  }, 90_000);

  it("tool-call turn: read tool executes, turn completes", async () => {
    await client.submit(HOME, "Use the read tool to read package.json, then tell me the package name.", { whenBusy: "reject" });
    const all = await collect(client.watch(HOME));
    const events = all.slice(all.map((e) => e.type).lastIndexOf("turn-start"));
    const start = events.find((e) => e.type === "tool-start");
    const end = events.find((e) => e.type === "tool-end");
    expect(start).toMatchObject({ name: "read" });
    expect(end).toMatchObject({ isError: false });
    expect(JSON.stringify((end as any).result)).toContain("zebra-quartz-fixture");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });
    const detail = await client.getThread(HOME);
    expect(detail.messages.at(-1)?.text).toContain("zebra-quartz-fixture");
  }, 120_000);
});
