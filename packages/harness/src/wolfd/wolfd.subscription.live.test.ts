/**
 * LIVE smoke test, this Mac only: one real turn through the Claude Code login (pi-claude-bridge, subscription), with
 * ANTHROPIC_API_KEY removed from the wolf's env so a turn that succeeds cannot have used the metered key.
 * Gate: WOLFPACK_LIVE=1, set by `pnpm run test:live` (never collected by the default suite). With the gate set and no
 * login the test fails with a message saying so; it does not skip.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpConsoleClient, type ThreadEvent } from "@wolfpack/client";
import { startWolf, type RunningWolf } from "./run.js";

const live = process.env.WOLFPACK_LIVE === "1";

describe.skipIf(!live)("wolfd subscription smoke (one real turn, no API key)", () => {
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

  it("one chat turn completes through the Claude Code login", async () => {
    const ack = await client.submit(HOME, "Reply with exactly one word: pong", { whenBusy: "reject" });
    expect(ack.disposition).toBe("started");
    const events = await collect(client.watch(HOME));
    const end = events.at(-1);
    if (end?.type !== "turn-end" || end.reason !== "complete") {
      throw new Error(`the live turn did not complete (${JSON.stringify(end)}). This test needs a working Claude Code login on this machine: run \`claude\`, log in, and retry \`pnpm run test:live\`.`);
    }
    const detail = await client.getThread(HOME);
    expect(detail.messages.at(-1)?.text.toLowerCase()).toContain("pong");
  }, 90_000);
});
