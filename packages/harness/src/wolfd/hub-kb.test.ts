import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WolfConfig } from "@wolfpack/engine";
import { renderContribution } from "@wolfpack/kb/client";
import { contentHash } from "@wolfpack/kb/shared";
import { feedInboxToHub, hubKbFromEnv } from "./hub-kb.js";

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
    expect(await feedInboxToHub(ops, "hal2", { baseUrl: "http://hub", token: "tok", fetch: ok }, () => {})).toEqual({ sent: 1, failed: 0 });
    expect(posts[0]).toMatchObject({ url: "http://hub/v1/contributions", auth: "Bearer tok" });
    expect(posts[0]!.body.from).toBe("hal2");
    expect(readdirSync(join(lane, "sent"))).toEqual(["caching-aaaaaaaaaa.md"]);
  });
  it("leaves the file in place when the hub refuses (retried next pass)", async () => {
    const ops = tmp();
    const lane = file(ops);
    const bad = (async () => new Response(JSON.stringify({ message: "nope" }), { status: 500 })) as unknown as typeof fetch;
    expect(await feedInboxToHub(ops, "hal2", { baseUrl: "http://hub", token: "tok", fetch: bad }, () => {})).toEqual({ sent: 0, failed: 1 });
    expect(readdirSync(lane)).toContain("caching-aaaaaaaaaa.md");
    expect(existsSync(join(lane, "sent"))).toBe(false);
  });
});
