import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WolfConfig } from "@wolfpack/engine";
import { HubHttpError } from "@wolfpack/memory";
import { renderContribution } from "@wolfpack/kb/client";
import { contentHash } from "@wolfpack/kb/shared";
import { BACKOFF_CAP_MS, feedInboxToHub, hubKbFromEnv, newFeedState, classify } from "./hub-kb.js";

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
  const hubOf = (f: typeof fetch, token = "tok") => ({ baseUrl: "http://hub", token, fetch: f });
  const NAME = "caching-aaaaaaaaaa.md";
  const more = (lane: string, n: number) => {
    for (let i = 0; i < n; i++) writeFileSync(join(lane, `extra-${i}.md`), readFileSync(join(lane, NAME)));
  };

  it("classify: status table", () => {
    const k = (s: number) => classify(new HubHttpError("x", s));
    for (const s of [400, 409, 413, 418, 422]) expect(k(s)).toBe("terminal");
    for (const s of [401, 403, 404, 405, 410]) expect(k(s)).toBe("config");
    for (const s of [408, 429, 500, 502, 503]) expect(k(s)).toBe("retry");
    expect(classify(new Error("could not reach the hub"))).toBe("retry");
  });

  it.each([400, 409, 413, 418, 422])("%i is terminal: moved to rejected/ with a reason file, logged once, never retried", async (status) => {
    const ops = tmp();
    const lane = file(ops);
    const logs: string[] = [];
    const state = newFeedState();
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

  it("reason.json caps reason at 64 chars and holds neither the token nor the body", async () => {
    const ops = tmp();
    const lane = file(ops);
    const token = "sekrit-token-value";
    const f = reply(400, { message: `bad bearer ${token} at http://user:pw@hub/x`, details: { reason: "r".repeat(500) }, echo: body });
    await feedInboxToHub(ops, "hal2", hubOf(f, token), () => {}, { now: () => 0 });
    const raw = readFileSync(join(lane, "rejected", `${NAME}.reason.json`), "utf-8");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(body);
    expect(raw).not.toContain("user:pw");
    expect(JSON.parse(raw).reason).toHaveLength(64);
    expect(readdirSync(join(lane, "rejected")).some((n) => n.includes(".tmp-"))).toBe(false);
  });

  it("a name clash in rejected/ gets name.md.1 and a matching reason file", async () => {
    const ops = tmp();
    const lane = file(ops);
    mkdirSync(join(lane, "rejected"));
    writeFileSync(join(lane, "rejected", NAME), "old");
    writeFileSync(join(lane, "rejected", `${NAME}.reason.json`), "{}");
    await feedInboxToHub(ops, "hal2", hubOf(reply(400)), () => {}, { now: () => 0 });
    expect(readdirSync(join(lane, "rejected")).sort()).toEqual([NAME, `${NAME}.1`, `${NAME}.1.reason.json`, `${NAME}.reason.json`].sort());
    expect(readFileSync(join(lane, "rejected", NAME), "utf-8")).toBe("old");
  });

  it("a failing move to rejected/ does not throw: the file stays and backs off", async () => {
    const ops = tmp();
    const lane = file(ops);
    writeFileSync(join(lane, "rejected"), "i am a file, so mkdir fails");
    const logs: string[] = [];
    const state = newFeedState();
    const p = await feedInboxToHub(ops, "hal2", hubOf(reply(400)), (l) => logs.push(l), { state, now: () => 0 });
    expect(p).toMatchObject({ rejected: 0, failed: 1 });
    expect(readdirSync(lane)).toContain(NAME);
    expect(state.files.get(NAME)).toEqual({ fails: 1, nextAt: 5000 });
    expect(logs.join("\n")).toMatch(/could not move .* to rejected/);
  });

  it("an unparseable file is rejected with reason 'unparseable', logged once", async () => {
    const ops = tmp();
    const lane = file(ops);
    writeFileSync(join(lane, "bad.md"), "no frontmatter at all");
    const logs: string[] = [];
    let calls = 0;
    const f = (async () => (calls++, new Response(JSON.stringify({ id: "c1" }), { status: 201 }))) as unknown as typeof fetch;
    const p = await feedInboxToHub(ops, "hal2", hubOf(f), (l) => logs.push(l), { now: () => 0 });
    expect(p).toMatchObject({ sent: 1, rejected: 1 });
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(join(lane, "rejected", "bad.md.reason.json"), "utf-8"))).toMatchObject({ reason: "unparseable" });
    expect(logs.filter((l) => l.includes("bad.md"))).toHaveLength(1);
  });

  it.each([401, 403, 404, 405, 410])("%i keeps the files, logs one loud ERROR per pass and backs the feeder off", async (status) => {
    const ops = tmp();
    const lane = file(ops);
    more(lane, 4);
    const logs: string[] = [];
    const state = newFeedState();
    let calls = 0;
    const f = (async () => (calls++, new Response("{}", { status }))) as unknown as typeof fetch;
    const p = await feedInboxToHub(ops, "hal2", hubOf(f), (l) => logs.push(l), { state, now: () => 0 });
    expect(p).toEqual({ sent: 0, failed: 1, rejected: 0, deferred: 4 });
    expect(calls).toBe(1);
    expect(readdirSync(lane).filter((n) => n.endsWith(".md"))).toHaveLength(5);
    expect(existsSync(join(lane, "rejected"))).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/ERROR.*WOLFPACK_HUB_TOKEN.*not granted this domain/);
    // backing off: the next pass at +1 s does not call the hub at all and logs nothing
    expect(await feedInboxToHub(ops, "hal2", hubOf(f), (l) => logs.push(l), { state, now: () => 1000 })).toMatchObject({ failed: 0, deferred: 5 });
    expect(calls).toBe(1);
    expect(logs).toHaveLength(1);
    // after the wait it tries again, with a doubled wait
    await feedInboxToHub(ops, "hal2", hubOf(f), (l) => logs.push(l), { state, now: () => 5000 });
    expect(calls).toBe(2);
    expect(state.auth).toEqual({ fails: 2, nextAt: 5000 + 10000 });
  });

  it("once the config is fixed the kept files go through", async () => {
    const ops = tmp();
    const lane = file(ops);
    more(lane, 2);
    const state = newFeedState();
    await feedInboxToHub(ops, "hal2", hubOf(reply(401)), () => {}, { state, now: () => 0 });
    expect(await feedInboxToHub(ops, "hal2", hubOf(reply(201, { id: "c1" })), () => {}, { state, now: () => BACKOFF_CAP_MS })).toMatchObject({ sent: 3 });
    expect(readdirSync(join(lane, "sent"))).toHaveLength(3);
    expect(state.auth).toEqual({ fails: 0, nextAt: 0 });
  });

  it.each([500, 502, 408, 429])("%i is retried with exponential backoff, capped", async (status) => {
    const ops = tmp();
    const lane = file(ops);
    const state = newFeedState();
    let t = 0;
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      const p = await feedInboxToHub(ops, "hal2", hubOf(reply(status)), () => {}, { state, now: () => t });
      expect(p.failed).toBe(1);
      const w = state.files.get(NAME)!.nextAt - t;
      waits.push(w);
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
    const state = newFeedState();
    expect(await feedInboxToHub(ops, "hal2", hubOf(down), () => {}, { state, now: () => 0 })).toMatchObject({ failed: 1, rejected: 0 });
    expect(state.files.get(NAME)).toEqual({ fails: 1, nextAt: 5000 });
    expect(readdirSync(lane)).toContain(NAME);
  });

  it("the token never reaches the log", async () => {
    const ops = tmp();
    file(ops);
    const logs: string[] = [];
    const down = (async () => {
      throw new Error("boom with Bearer sekrit-token-value");
    }) as unknown as typeof fetch;
    await feedInboxToHub(ops, "hal2", hubOf(down, "sekrit-token-value"), (l) => logs.push(l), { now: () => 0 });
    expect(logs.join("")).not.toContain("sekrit-token-value");
  });

  it("prunes backoff entries of files no longer in the inbox", async () => {
    const ops = tmp();
    const lane = file(ops);
    const state = newFeedState();
    await feedInboxToHub(ops, "hal2", hubOf(reply(500)), () => {}, { state, now: () => 0 });
    expect([...state.files.keys()]).toEqual([NAME]);
    rmSync(join(lane, NAME));
    await feedInboxToHub(ops, "hal2", hubOf(reply(500)), () => {}, { state, now: () => 1 });
    expect(state.files.size).toBe(0);
  });
});
