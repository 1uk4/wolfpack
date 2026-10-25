/**
 * LIVE: one real wolf process, real haiku turn over HTTP via HttpConsoleClient. Costs a few cents; skipped unless
 * WOLFD_LIVE=1 and ANTHROPIC_API_KEY are both set (never in CI).
 *   WOLFD_LIVE=1 ANTHROPIC_API_KEY=... npm test -w @wolfpack/harness -- wolfd.live
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpConsoleClient, type ThreadEvent } from "@wolfpack/client";
import { startWolf, type RunningWolf } from "./run.js";

const live = Boolean(process.env.WOLFD_LIVE && process.env.ANTHROPIC_API_KEY);

describe.skipIf(!live)("wolfd live (haiku)", () => {
  let root: string;
  let wolf: RunningWolf;
  let client: HttpConsoleClient;
  const HOME = "livewolf/home";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "wolfd-live-"));
    const tier = { model: "claude-haiku-5-5", modelSource: "default", provider: "anthropic", piModel: "anthropic/claude-haiku-5-5" };
    writeFileSync(
      join(root, "models.json"),
      JSON.stringify({ location: "local", transport: "api", transportSource: "default", tiers: { main: tier, smart: tier, fast: tier }, steps: {}, warnings: [] }),
    );
    mkdirSync(join(root, "work"));
    writeFileSync(join(root, "wolf.yaml"), `name: livewolf\nworkspace: ${join(root, "work")}\n`);
    wolf = await startWolf({ configPath: join(root, "wolf.yaml"), env: { ...process.env, WOLFPACK_MODELS_FILE: join(root, "models.json") }, home: root });
    client = new HttpConsoleClient({ baseUrl: wolf.url });
  }, 30_000);

  afterAll(async () => {
    await wolf?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const collect = async (it: AsyncIterable<ThreadEvent>) => {
    const out: ThreadEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  };

  it("submit -> stream -> complete, history reconstructed", async () => {
    const ack = await client.submit(HOME, "Reply with exactly one word: pong", { whenBusy: "reject" });
    expect(ack.disposition).toBe("started");
    const events = await collect(client.watch(HOME));
    expect(events[0].type).toBe("turn-start");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
    const detail = await client.getThread(HOME);
    expect(detail.busy).toBe(false);
    expect(detail.messages.at(-1)?.role).toBe("assistant");
    expect(detail.messages.at(-1)?.text.toLowerCase()).toContain("pong");
  }, 60_000);

  it("abort ends the turn as aborted", async () => {
    await client.submit(HOME, "Count from 1 to 300, one number per line.", { whenBusy: "reject" });
    const stream = client.watch(HOME)[Symbol.asyncIterator]();
    await stream.next(); // turn-start
    await client.abort(HOME);
    const rest: ThreadEvent[] = [];
    for (let r = await stream.next(); !r.done; r = await stream.next()) rest.push(r.value);
    expect(rest.at(-1)).toMatchObject({ type: "turn-end", reason: "aborted" });
  }, 60_000);

  it("reconnect mid-turn: replay after a cursor is gap-free", async () => {
    await client.submit(HOME, "Say the alphabet, letters separated by spaces.", { whenBusy: "reject" });
    const first: ThreadEvent[] = [];
    for await (const e of client.watch(HOME)) {
      first.push(e);
      if (first.length >= 2) break; // drop the connection mid-turn
    }
    const rest = await collect(client.watch(HOME, { from: first.at(-1)!.id }));
    expect(rest.at(-1)?.type).toBe("turn-end");
    const all = [...first, ...rest];
    all.forEach((e, i) => {
      if (i > 0) expect(e.id).toBe(all[i - 1].id + 1);
    });
  }, 60_000);
});
