import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main, parseArgs } from "./cli.js";
import { createHubServer } from "./server.js";
import {
  assertSafeDataDir, buildPullArgs, DEV_MARKER, REMOTE_KB_DOMAINS, REMOTE_LEDGER, resolveHost, SNAPSHOT_MANIFEST, takeSnapshot,
  type PullRunner, type RemoteHost,
} from "./snapshot.js";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";

const tmp: string[] = [];
const mk = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmp.push(d);
  return d;
};
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

const HOST: RemoteHost = { name: "sfo-01", address: "100.64.0.9", user: "root", port: 22, identityFile: "/k/wolfpack" };

/** A fake rsync: validates the pull shape, then copies from a local "remote" dir keyed by the remote path. */
function fakeRemote(remoteRoot: string, calls: string[][]): PullRunner {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    const src = args[args.length - 2]!;
    const dest = args[args.length - 1]!;
    const m = /^root@100\.64\.0\.9:(\/.*)$/.exec(src);
    if (cmd !== "rsync" || !m) return { code: 2, stderr: "not a pull" };
    cpSync(join(remoteRoot, m[1]!), dest, { recursive: true });
    return { code: 0, stderr: "" };
  };
}

function makeRemote(): string {
  const seed = mk("hubd-seed-");
  seedFixture(seed);
  const remote = mk("hubd-remote-");
  mkdirSync(join(remote, "var/wolfpack/kb/work/ledger"), { recursive: true });
  mkdirSync(join(remote, "var/wolfpack/kb/base"), { recursive: true });
  cpSync(join(seed, "ledger/work-events.jsonl"), join(remote, REMOTE_LEDGER));
  cpSync(join(seed, "kb/base/domains"), join(remote, REMOTE_KB_DOMAINS), { recursive: true });
  return remote;
}

describe("hubd cli args", () => {
  it("parses serve and dev", () => {
    expect(parseArgs(["serve", "--data-dir", "/d"])).toMatchObject({ command: "serve", dataDir: "/d", host: "127.0.0.1" });
    expect(parseArgs(["dev", "--snapshot", "sfo-01", "--port", "4000"])).toMatchObject({ command: "dev", snapshot: "sfo-01", port: 4000 });
    expect(parseArgs(["dev", "--data-dir", "/x"]).snapshot).toBeUndefined();
  });
  it("rejects bad input, and has no key flag", () => {
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(["serve"])).toThrow(/data-dir/);
    expect(() => parseArgs(["dev"])).toThrow();
    expect(() => parseArgs(["serve", "--data-dir", "/d", "--port", "99999"])).toThrow(/port/);
    expect(() => parseArgs(["serve", "--data-dir", "/d", "--api-key", "x"])).toThrow(/unknown/);
    expect(() => parseArgs(["serve", "--data-dir", "/d", "--snapshot", "h"])).toThrow(/unknown/);
  });
  it("requires HUBD_API_KEY", async () => {
    await expect(main(["serve", "--data-dir", "/d"], {})).rejects.toThrow(/HUBD_API_KEY/);
  });
});

describe("data-dir guards", () => {
  const home = mk("hubd-home-");
  mkdirSync(join(home, "wolves/knowledge/base"), { recursive: true });
  mkdirSync(join(home, "wolves/sfo-01/hal/den"), { recursive: true });
  mkdirSync(join(home, "wolves/local/1uk4/den"), { recursive: true });
  it("refuses live knowledge, wolf dens and /var/wolfpack", () => {
    expect(() => assertSafeDataDir(join(home, "wolves/knowledge"), home)).toThrow(/knowledge/);
    expect(() => assertSafeDataDir(join(home, "wolves/knowledge/base/x"), home)).toThrow(/knowledge/);
    expect(() => assertSafeDataDir(join(home, "wolves/sfo-01/hal/den/kb"), home)).toThrow(/den/);
    expect(() => assertSafeDataDir(join(home, "wolves/local/1uk4/den"), home)).toThrow(/den/);
    expect(() => assertSafeDataDir("/var/wolfpack/kb/work", home)).toThrow(/wolfpack/);
  });
  it("refuses a symlink into a den", () => {
    const link = join(home, "link");
    symlinkSync(join(home, "wolves/knowledge"), link);
    expect(() => assertSafeDataDir(join(link, "new"), home)).toThrow(/knowledge/);
  });
  it("allows a fresh dir elsewhere", () => {
    expect(assertSafeDataDir(join(home, ".wolfpack/hubd-dev/t1"), home)).toContain("hubd-dev");
  });
  it("takeSnapshot refuses an unsafe or foreign non-empty dir", async () => {
    await expect(takeSnapshot({ host: "x", dataDir: join(home, "wolves/knowledge/b"), home, hostInfo: HOST, run: async () => ({ code: 0, stderr: "" }) })).rejects.toThrow(/knowledge/);
    const d = mk("hubd-nonempty-");
    writeFileSync(join(d, "f"), "x");
    await expect(takeSnapshot({ host: "x", dataDir: d, hostInfo: HOST, run: async () => ({ code: 0, stderr: "" }) })).rejects.toThrow(/non-empty/);
  });
});

describe("rsync args are pull-only", () => {
  it("remote SOURCE then local DEST, never --delete, ssh opts per ops.md", () => {
    const a = buildPullArgs(HOST, REMOTE_LEDGER, "/tmp/x/ledger/work-events.jsonl");
    expect(a.at(-2)).toBe(`root@100.64.0.9:${REMOTE_LEDGER}`);
    expect(a.at(-1)).toBe("/tmp/x/ledger/work-events.jsonl");
    expect(a.filter((x) => /^[^ ]+@[^ ]+:/.test(x))).toHaveLength(1); // exactly one remote operand: the source
    expect(a.some((x) => x.startsWith("--delete") || x.startsWith("--remove"))).toBe(false);
    const e = a[a.indexOf("-e") + 1]!;
    for (const o of ["IdentitiesOnly=yes", "IdentityAgent=none", "BatchMode=yes", "ConnectTimeout=5", "-i /k/wolfpack"]) expect(e).toContain(o);
  });
  it("refuses remote destinations, relative sources and mutating flags", () => {
    expect(() => buildPullArgs(HOST, REMOTE_LEDGER, "root@h:/var/wolfpack/x")).toThrow(/LOCAL/);
    expect(() => buildPullArgs(HOST, REMOTE_LEDGER, "h:/x")).toThrow(/LOCAL/);
    expect(() => buildPullArgs(HOST, REMOTE_LEDGER, "rel/dir")).toThrow(/LOCAL/);
    expect(() => buildPullArgs(HOST, "var/x", "/tmp/x")).toThrow(/absolute/);
    expect(() => buildPullArgs(HOST, "/x; rm -rf /", "/tmp/x")).toThrow(/unsafe/);
    expect(() => buildPullArgs(HOST, REMOTE_LEDGER, "/tmp/x", ["--delete"])).toThrow(/forbidden/);
    expect(() => buildPullArgs(HOST, REMOTE_LEDGER, "/tmp/x", ["--remove-source-files"])).toThrow(/forbidden/);
  });
  it("takeSnapshot only ever issues rsync pulls", async () => {
    const dataDir = join(mk("hubd-p-"), "snap");
    const calls: string[][] = [];
    await takeSnapshot({ host: "sfo-01", dataDir, hostInfo: HOST, run: fakeRemote(makeRemote(), calls) });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c[0]).toBe("rsync");
      expect(c.at(-2)).toMatch(/^root@100\.64\.0\.9:\/var\/wolfpack\//);
      expect(c.at(-1)!.startsWith(dataDir)).toBe(true);
      expect(c.join(" ")).not.toMatch(/--delete|--remove/);
    }
  });
});

describe("host resolution", () => {
  it("reads only address and ssh user/port, never secrets", () => {
    const cfg = join(mk("hubd-cfg-"), "config.yaml");
    writeFileSync(cfg, "hosts:\n  sfo-01:\n    address: 10.1.2.3\n    apiKey: SECRET\n    ssh:\n      user: root\n      port: 22\n");
    const h = resolveHost("sfo-01", cfg);
    expect(h).toMatchObject({ address: "10.1.2.3", user: "root", port: 22 });
    expect(JSON.stringify(h)).not.toContain("SECRET");
    expect(() => resolveHost("nope", cfg)).toThrow(/unknown host/);
  });
});

describe("snapshot, manifest, and serving over HTTP", () => {
  it("pulls a fixture, writes manifest + marker, serves GET /v1/work", async () => {
    const dataDir = join(mk("hubd-s-"), "snap");
    const m = await takeSnapshot({ host: "sfo-01", dataDir, hostInfo: HOST, run: fakeRemote(makeRemote(), []), now: () => new Date("2026-10-29T12:00:00Z") });
    expect(m).toMatchObject({ sourceHost: "sfo-01", takenAt: "2026-10-29T12:00:00.000Z", remotePaths: { ledger: REMOTE_LEDGER, kbDomains: REMOTE_KB_DOMAINS } });
    expect(m.fileCount).toBeGreaterThan(1);
    expect(m.ledgerSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(join(dataDir, SNAPSHOT_MANIFEST), "utf8")).ledgerSha256).toBe(m.ledgerSha256);
    expect(existsSync(join(dataDir, DEV_MARKER))).toBe(true);
    expect(existsSync(join(dataDir, "ledger/work-events.jsonl"))).toBe(true);

    const hub = await createHubServer({ dataDir, apiKey: "k" });
    try {
      const r = await fetch(`${hub.url}/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: { "X-API-Key": "k" } });
      const body = (await r.json()) as { items: { title: string }[] };
      expect(body.items.map((i) => i.title)).toEqual(expect.arrayContaining(["Hub fixture feature", "First task"]));
    } finally {
      await hub.close();
    }
  });
  it("re-serving requires the marker", async () => {
    await expect(main(["dev", "--data-dir", mk("hubd-nomark-")], { HUBD_API_KEY: "k" }, () => {})).rejects.toThrow(/DEV-SNAPSHOT/);
  });
  it("a failed pull surfaces the error", async () => {
    const dataDir = join(mk("hubd-f-"), "snap");
    await expect(takeSnapshot({ host: "x", dataDir, hostInfo: HOST, run: async () => ({ code: 255, stderr: "ssh: unreachable" }) })).rejects.toThrow(/unreachable/);
  });
  it("homedir default is not under wolves", () => {
    expect(join(homedir(), ".wolfpack/hubd-dev")).not.toContain("/wolves/");
  });
});
