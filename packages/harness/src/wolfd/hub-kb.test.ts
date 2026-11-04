import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WolfConfig } from "@wolfpack/engine";
import { renderContribution } from "@wolfpack/kb/client";
import { contentHash } from "@wolfpack/kb/shared";
import { BACKOFF_CAP_MS, feedInboxToHub, hubKbFromEnv, type FeedState } from "./hub-kb.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "hubkb-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const cfg = { file: "/home/wolf-hal2/wolf.yaml", identity: { name: "hal2", domains: ["x"] } } as unknown as WolfConfig;

describe("hubKbFromEnv", () => {
  it("is off unless WOLFPACK_HUB_KB=1 (Syncthing wolves unchanged)", () => {
    expect(hubKbFromEnv(cfg, {})).toBeUndefined();
    expect(hubKbFromEnv(cfg, { WOLFPACK_HUB_URL: "http://h", WOLFPACK_HUB_TOKEN: "t" })).toBeUndefined();
  });
  it("needs url + token, defaults mirror and ops into the wolf home", () => {
    expect(() => hubKbFromEnv(cfg, { WOLFPACK_HUB_KB: "1" })).toThrow(/WOLFPACK_HUB_URL/);
    expect(hubKbFromEnv(cfg, { WOLFPACK_HUB_KB: "1", WOLFPACK_HUB_URL: "http://h", WOLFPACK_HUB_TOKEN: "t" })).toEqual({ hubUrl: "http://h", token: "t", mirrorDir: "/home/wolf-hal2/kb-mirror", kbOps: "/home/wolf-hal2/ops" });
  });
});

describe("feedInboxToHub", () => {
  const body = "Session lookups are cached for five minutes.";
  const file = (ops: string) => {
    const lane = join(ops, "inbox", "hal2");
    mkdirSync(lane, { recursive: true });
    const c = { from: "hal2", denTopicId: "caching", change: "create" as const, contentHash: contentHash(body), prevHash: null, domainHint: "x", session: "durable", submitted: "2026-11-02 02:24", title: "Caching", summary: "Cached.", body };
    writeFileSync(join(lane, "caching-aaaaaaaaaa.md"), renderContribution(c as never));
    return lane;
  };
  it("posts the file and moves it to sent/ only on success", async () => {
    const ops = tmp();
    const lane = file(ops);
    const posts: { url: string; auth: string | null; body: any }[] = [];
    const ok = (async (u: string, init: RequestInit) => (posts.push({ url: u, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) }), new Response(JSON.stringify({ id: "c1" }), { status: 201 }))) as unknown as typeof fetch;
    expect(await feedInboxToHub(ops, "hal2", { baseUrl: "http://hub", token: "tok", fetch: ok }, () => {})).toEqual({ sent: 1, failed: 0, rejected: 0, deferred: 0 });
    expect(posts[0]).toMatchObject({ url: "http://hub/v1/contributions", auth: "Bearer tok" });
    expect(posts[0]!.body.from).toBe("hal2");
    expect(readdirSync(join(lane, "sent"))).toEqual(["caching-aaaaaaaaaa.md"]);
  });
  const reply = (status: number, json: object = { message: "nope" }) => (async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch;
  const hubOf = (f: typeof fetch) => ({ baseUrl: "http://hub", token: "tok", fetch: f });
  const NAME = "caching-aaaaaaaaaa.md";

  it.each([400, 404, 409, 413, 422])("%i is terminal: moved to rejected/ with a reason file, logged once, never retried", async (status) => {
    const ops = tmp();
    const lane = file(ops);
    const logs: string[] = [];
    const state: FeedState = new Map();
    let calls = 0;
    const f = (async () => (calls++, new Response(JSON.stringify({ message: "malformed contribution: domain_hint", details: { reason: "bad_domain" } }), { status }))) as unknown as typeof fetch;
    expect(await feedInboxToHub(ops, "hal2", hubOf(f), (l) => logs.push(l), { state, now: () => 0 })).toEqual({ sent: 0, failed: 0, rejected: 1, deferred: 0 });
    expect(readdirSync(lane)).not.toContain(NAME);
    expect(readdirSync(join(lane, "rejected")).sort()).toEqual([NAME, `${NAME}.reason.json`]);
    const r = JSON.parse(readFileSync(join(lane, "rejected", `${NAME}.reason.json`), "utf-8"));
    expect(r).toMatchObject({ status, reason: "bad_domain" });
    expect(r.message).toContain(String(status));
    await feedInboxToHub(ops, "hal2", hubOf(f), (l) => logs.push(l), { state, now: () => 10 * BACKOFF_CAP_MS });
    expect(calls).toBe(1);
    expect(logs).toHaveLength(1);
  });

  it.each([401, 403])("%i keeps the file, logs loudly, backs off", async (status) => {
    const ops = tmp();
    const lane = file(ops);
    const logs: string[] = [];
    const state: FeedState = new Map();
    expect(await feedInboxToHub(ops, "hal2", hubOf(reply(status)), (l) => logs.push(l), { state, now: () => 0 })).toMatchObject({ failed: 1, rejected: 0 });
    expect(readdirSync(lane)).toContain(NAME);
    expect(existsSync(join(lane, "rejected"))).toBe(false);
    expect(logs[0]).toMatch(/ERROR.*WOLFPACK_HUB_TOKEN/);
    // backing off: the next pass at +1 s does not call the hub
    let calls = 0;
    const f = (async () => (calls++, new Response("{}", { status }))) as unknown as typeof fetch;
    expect(await feedInboxToHub(ops, "hal2", hubOf(f), () => {}, { state, now: () => 1000 })).toMatchObject({ failed: 0, deferred: 1 });
    expect(calls).toBe(0);
  });

  it("once the token is fixed the kept file goes through", async () => {
    const ops = tmp();
    const lane = file(ops);
    const state: FeedState = new Map();
    await feedInboxToHub(ops, "hal2", hubOf(reply(401)), () => {}, { state, now: () => 0 });
    const ok = reply(201, { id: "c1" });
    expect(await feedInboxToHub(ops, "hal2", hubOf(ok), () => {}, { state, now: () => BACKOFF_CAP_MS })).toMatchObject({ sent: 1 });
    expect(readdirSync(join(lane, "sent"))).toEqual([NAME]);
  });

  it.each([500, 502, 408, 429])("%i is retried with exponential backoff, capped", async (status) => {
    const ops = tmp();
    const lane = file(ops);
    const state: FeedState = new Map();
    let t = 0;
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      const p = await feedInboxToHub(ops, "hal2", hubOf(reply(status)), () => {}, { state, now: () => t });
      expect(p.failed).toBe(1);
      const w = state.get(NAME)!.nextAt - t;
      waits.push(w);
      // still backing off just before nextAt
      expect(await feedInboxToHub(ops, "hal2", hubOf(reply(status)), () => {}, { state, now: () => t + w - 1 })).toMatchObject({ deferred: 1, failed: 0 });
      t += w;
    }
    expect(waits.slice(0, 4)).toEqual([5000, 10000, 20000, 40000]);
    expect(Math.max(...waits)).toBe(BACKOFF_CAP_MS);
    expect(readdirSync(lane)).toContain(NAME);
    expect(existsSync(join(lane, "rejected"))).toBe(false);
  });

  it("a network error is retried with backoff", async () => {
    const ops = tmp();
    const lane = file(ops);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const state: FeedState = new Map();
    expect(await feedInboxToHub(ops, "hal2", hubOf(down), () => {}, { state, now: () => 0 })).toMatchObject({ failed: 1, rejected: 0 });
    expect(state.get(NAME)).toEqual({ fails: 1, nextAt: 5000 });
    expect(readdirSync(lane)).toContain(NAME);
  });
});
