/** Link-only mode: hub link + KB sync + announce, and NOTHING supervised or spawned. */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseServeArgs } from "./cli-args.js";
import { runWorkerd } from "./run.js";
import { startLinkRig, type LinkRig } from "./testing/link-rig.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

describe("runWorkerd link-only", () => {
  it("opens the link as host, announces the wolf, syncs the KB (base layout), and spawns no wolfd", async () => {
    const r: LinkRig = await startLinkRig({ wolves: ["hal"], noHub: true, kbDomains: ["personal"], grants: { hal: ["personal"] } });
    cleanup.push(() => r.close());
    const tmp = mkdtempSync(join(tmpdir(), "link-only-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    // wolvesDir holds a real hal wolf.yaml (fake wolf) that must be ignored; no `command` is given (placeholder path).
    const lines: string[] = [];
    const mirror = join(tmp, "mirror");
    const w = await runWorkerd({
      wolvesDir: r.wolvesDir,
      port: 0,
      linkOnly: true,
      announce: ["hal"],
      hub: { hubUrl: r.hub.url, token: r.token, hostId: r.hostId },
      linkOptions: { baseMs: 20, capMs: 200, rand: () => 0.5 },
      kbMirrorDir: mirror,
      kbMirrorLayout: "base",
      kbSync: { baseMs: 20, capMs: 200, pollMs: 0 },
      wake: { intervalMs: 3_600_000, netPollMs: 3_600_000 },
      kbOps: join(tmp, "ops"),
      outboxDir: join(tmp, "outbox"),
      log: (l) => void lines.push(l),
    });
    cleanup.push(() => w.close());
    await r.waitPresence("online");
    expect(w.supervisor.wolves()).toEqual([]);
    expect(w.supervisor.configs()).toEqual([]);
    expect((await r.registry("wolves")).map((x) => [x.name, x.host])).toEqual([["hal", "box"]]);
    await r.kbWrite("personal", "INDEX.md", "# Index\n");
    await r.eventually(() => existsSync(join(mirror, "domains", "personal", "INDEX.md")), "mirror filled (base layout)");
    await new Promise((res) => setTimeout(res, 300));
    expect(w.supervisor.wolves()).toEqual([]);
    expect(() => w.supervisor.start()).toThrow(/disabled/);
    expect(() => w.supervisor.addWolf({ identity: { name: "x", domains: [] } } as never)).toThrow(/disabled/);
    expect(new URL(w.url).hostname).toBe("127.0.0.1");
    expect(lines.some((l) => l.includes("contribution feed off: link-only default"))).toBe(true);
    expect(lines.some((l) => l.includes("link-only"))).toBe(true);
  });

  it("refuses link-only with nothing to announce or without a hub", async () => {
    await expect(runWorkerd({ linkOnly: true, announce: [], hub: false, port: 0 })).rejects.toThrow(/announced wolf/);
    await expect(runWorkerd({ linkOnly: true, announce: ["hal"], hub: false, port: 0 })).rejects.toThrow(/hub link/);
  });

  it("rejects only/command in link-only", async () => {
    await expect(runWorkerd({ linkOnly: true, announce: ["hal"], only: ["hal"], port: 0, hub: { hubUrl: "http://127.0.0.1:1", token: "t", hostId: "h" } })).rejects.toThrow(/only/);
    await expect(runWorkerd({ linkOnly: true, announce: ["hal"], command: ["x"], port: 0, hub: { hubUrl: "http://127.0.0.1:1", token: "t", hostId: "h" } })).rejects.toThrow(/command/);
  });
});

describe("workerd CLI args", () => {
  it("activates link-only from the environment alone", () => {
    const r = parseServeArgs([], { WORKERD_LINK_ONLY: "1", WORKERD_PORT: "7142" });
    expect(r).toMatchObject({ opts: { linkOnly: true, port: 7142 } });
  });
  it("default (no link-only) stays unchanged", () => {
    expect(parseServeArgs([], {})).toMatchObject({ opts: { linkOnly: undefined, port: 7141 } });
  });
  it("WOLFPACK_WORKERD_PORT sets the port; WORKERD_PORT alone does not (non-link-only)", () => {
    expect(parseServeArgs([], { WOLFPACK_WORKERD_PORT: "7291" })).toMatchObject({ opts: { port: 7291 } });
    expect(parseServeArgs([], { WORKERD_PORT: "7999" })).toMatchObject({ opts: { port: 7141 } });
  });
  it("a bad WOLFPACK_WORKERD_PORT is an error naming the variable, not a throw", () => {
    expect(parseServeArgs([], { WOLFPACK_WORKERD_PORT: "abc" })).toEqual({ error: expect.stringContaining("WOLFPACK_WORKERD_PORT") });
  });
  it("link-only needs an explicit port (no 7141 fallback)", () => {
    expect(parseServeArgs(["--link-only"], {})).toHaveProperty("error");
    expect(parseServeArgs(["--link-only", "--port", "7142"], {})).toMatchObject({ opts: { port: 7142 } });
    expect(parseServeArgs([], { WORKERD_LINK_ONLY: "1" })).toHaveProperty("error");
  });
  it("link-only refuses a non-loopback host (flag or WORKERD_HOST); loopback forms pass", () => {
    expect(parseServeArgs(["--link-only", "--port", "1", "--host", "0.0.0.0"], {})).toHaveProperty("error");
    expect(parseServeArgs(["--link-only", "--port", "1"], { WORKERD_HOST: "100.120.154.69" })).toHaveProperty("error");
    for (const h of ["127.0.0.1", "::1", "localhost"]) expect(parseServeArgs(["--link-only", "--port", "1", "--host", h], {})).toMatchObject({ opts: { host: h } });
    expect(parseServeArgs(["--port", "1", "--host", "0.0.0.0"], {})).toMatchObject({ opts: { host: "0.0.0.0" } }); // default mode unchanged
  });
  it("runWorkerd link-only throws on a non-loopback host", async () => {
    await expect(runWorkerd({ linkOnly: true, announce: ["hal"], host: "0.0.0.0", port: 0, hub: { hubUrl: "http://127.0.0.1:1", token: "t", hostId: "h" } })).rejects.toThrow(/loopback/);
  });
  it("--announce without link-only is an error", () => {
    expect(parseServeArgs(["--announce", "hal"], {})).toHaveProperty("error");
  });
  it("--wolfd and --only are rejected with link-only (flag or env)", () => {
    expect(parseServeArgs(["--link-only", "--wolfd", "x"], {})).toHaveProperty("error");
    expect(parseServeArgs(["--only", "a"], { WORKERD_LINK_ONLY: "1" })).toHaveProperty("error");
  });
});

describe("--wolfd-transport (supervising workerd)", () => {
  it("is opt-in: absent by default, so the spawn behaviour is unchanged", () => {
    const r = parseServeArgs(["--wolfd", "x"], {});
    expect(r).toMatchObject({ opts: { command: ["x"] } });
    expect(r).not.toHaveProperty("opts.transport");
  });
  it("flag or WORKERD_WOLFD_TRANSPORT selects socket|tcp; anything else is an error", () => {
    expect(parseServeArgs(["--wolfd-transport", "socket"], {})).toMatchObject({ opts: { transport: "socket" } });
    expect(parseServeArgs([], { WORKERD_WOLFD_TRANSPORT: "socket" })).toMatchObject({ opts: { transport: "socket" } });
    expect(parseServeArgs(["--wolfd-transport", "tcp"], { WORKERD_WOLFD_TRANSPORT: "socket" })).toMatchObject({ opts: { transport: "tcp" } });
    expect(parseServeArgs(["--wolfd-transport", "udp"], {})).toHaveProperty("error");
  });
  it("link-only rejects the flag and ignores the env", () => {
    expect(parseServeArgs(["--link-only", "--port", "1", "--wolfd-transport", "socket"], {})).toHaveProperty("error");
    expect(parseServeArgs(["--link-only", "--port", "1"], { WORKERD_WOLFD_TRANSPORT: "socket" })).not.toHaveProperty("opts.transport");
  });
});

describe("link-only defaults from env", () => {
  it("feed is on only when explicitly enabled", async () => {
    const r: LinkRig = await startLinkRig({ wolves: ["hal"], noHub: true });
    cleanup.push(() => r.close());
    const tmp = mkdtempSync(join(tmpdir(), "link-only-feed-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const mk = async (env: string | undefined) => {
      if (env === undefined) vi.stubEnv("WORKERD_FEED", "");
      else vi.stubEnv("WORKERD_FEED", env);
      const lines: string[] = [];
      const w = await runWorkerd({ linkOnly: true, announce: ["hal"], port: 0, hub: { hubUrl: r.hub.url, token: r.token, hostId: r.hostId }, kbMirrorDir: join(tmp, "m" + env), kbOps: join(tmp, "ops"), outboxDir: join(tmp, "o" + env), wake: { intervalMs: 3_600_000, netPollMs: 3_600_000 }, log: (l) => void lines.push(l) });
      cleanup.push(() => w.close());
      return lines;
    };
    cleanup.push(() => void vi.unstubAllEnvs());
    expect((await mk(undefined)).some((l) => l.includes("contribution feed off"))).toBe(true);
    expect((await mk("1")).some((l) => l.includes("contribution feed off"))).toBe(false);
  });
});
