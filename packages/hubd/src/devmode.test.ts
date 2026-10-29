import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir as homedirForTest, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main, parseArgs } from "./cli.js";

const GOOD_KEY = "0123456789abcdef0123";
import { createHubServer } from "./server.js";
import {
  assertNotLiveMirror, assertSafeDevDataDir, buildPullArgs, defaultDevDataDir, DEV_MARKER, snapshotState, REMOTE_KB_DOMAINS, REMOTE_LEDGER, resolveHost, SNAPSHOT_MANIFEST, takeSnapshot,
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
    for (const bad of ["99999", "0", "-1", "1.5", "abc"]) expect(() => parseArgs(["serve", "--data-dir", "/d", "--port", bad])).toThrow(/port/);
    expect(() => parseArgs(["serve", "--data-dir", "/d", "--api-key", "x"])).toThrow(/unknown/);
    expect(() => parseArgs(["serve", "--data-dir", "/d", "--snapshot", "h"])).toThrow(/unknown/);
  });
  it("requires HUBD_API_KEY of at least 16 characters", async () => {
    await expect(main(["serve", "--data-dir", "/d"], {})).rejects.toThrow(/HUBD_API_KEY is not set/);
    await expect(main(["serve", "--data-dir", "/d"], { HUBD_API_KEY: "short" })).rejects.toThrow(/at least 16/);
  });
  it("dev on a non-loopback host needs --allow-network, and warns loudly", async () => {
    expect(() => parseArgs(["dev", "--snapshot", "h", "--host", "0.0.0.0"])).toThrow(/allow-network/);
    expect(() => parseArgs(["dev", "--data-dir", "/d", "--host", "192.168.1.5"])).toThrow(/allow-network/);
    expect(parseArgs(["dev", "--snapshot", "h", "--host", "0.0.0.0", "--allow-network"]).allowNetwork).toBe(true);
    expect(parseArgs(["dev", "--snapshot", "h", "--host", "localhost"]).allowNetwork).toBe(false);
    expect(() => parseArgs(["serve", "--data-dir", "/d", "--allow-network"])).toThrow(/unknown/);
    const logs: string[] = [];
    // the warning is logged before anything is pulled; the missing marker then stops the run (no network, no server)
    await expect(main(["dev", "--data-dir", mk("hubd-net-"), "--host", "0.0.0.0", "--allow-network"], { HUBD_API_KEY: GOOD_KEY }, (m) => logs.push(m))).rejects.toThrow(/DEV-SNAPSHOT/);
    expect(logs.join("\n")).toMatch(/WARNING.*PRODUCTION DATA/);
  });
  it("is an executable-style bin: shebang in the source, chmod in the build script", () => {
    expect(readFileSync(new URL("./cli.ts", import.meta.url), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { bin: Record<string, string>; scripts: Record<string, string> };
    expect(pkg.bin.hubd).toBe("dist/cli.js");
    expect(pkg.scripts.build).toMatch(/chmodSync\('dist\/cli\.js', ?0o755\)/);
  });
});

describe("data-dir guards", () => {
  const home = mk("hubd-home-");
  mkdirSync(join(home, "wolves/knowledge/base"), { recursive: true });
  mkdirSync(join(home, "wolves/sfo-01/hal/den"), { recursive: true });
  mkdirSync(join(home, "wolves/local/1uk4/den"), { recursive: true });
  it("refuses live knowledge, wolf dens and /var/wolfpack", () => {
    expect(() => assertSafeDevDataDir(join(home, "wolves/knowledge"), home)).toThrow(/knowledge/);
    expect(() => assertSafeDevDataDir(join(home, "wolves/knowledge/base/x"), home)).toThrow(/knowledge/);
    expect(() => assertSafeDevDataDir(join(home, "wolves/sfo-01/hal/den/kb"), home)).toThrow(/den/);
    expect(() => assertSafeDevDataDir(join(home, "wolves/local/1uk4/den"), home)).toThrow(/den/);
    expect(() => assertSafeDevDataDir("/var/wolfpack/kb/work", home)).toThrow(/wolfpack/);
  });
  it("refuses a den at any depth (e.g. a stateless wolf's den)", () => {
    mkdirSync(join(home, "wolves/local/1uk4/claude-stateless/den/sessions"), { recursive: true });
    expect(() => assertSafeDevDataDir(join(home, "wolves/local/1uk4/claude-stateless/den"), home)).toThrow(/den/);
    expect(() => assertSafeDevDataDir(join(home, "wolves/local/1uk4/claude-stateless/den/sessions/x"), home)).toThrow(/den/);
    expect(() => assertSafeDevDataDir(join(home, "wolves/a/b/c/d/den/e"), home)).toThrow(/den/);
    // a name that merely contains "den" is fine
    expect(assertSafeDevDataDir(join(home, "wolves/hidden/garden/x"), home)).toContain("garden");
  });
  it("refuses /private/var/wolfpack", () => {
    expect(() => assertSafeDevDataDir("/private/var/wolfpack/kb", home)).toThrow(/wolfpack/);
  });
  it.runIf(process.platform === "darwin")("compares case-insensitively on darwin", () => {
    expect(() => assertSafeDevDataDir(join(home, "wolves/KNOWLEDGE/x"), home)).toThrow(/knowledge/);
    expect(() => assertSafeDevDataDir(join(home, "wolves/local/1uk4/claude-stateless/DEN/x"), home)).toThrow(/den/);
  });
  it("returns the realpath", () => {
    const base = mk("hubd-real-");
    const link = join(base, "ln");
    symlinkSync(realpathSync(base), link);
    expect(assertSafeDevDataDir(join(link, "sub"), home)).toBe(join(realpathSync.native(base), "sub"));
  });
  it("refuses a symlink pointing out of a safe dir into a live tree", () => {
    const safe = join(home, ".wolfpack/hubd-dev/safe");
    mkdirSync(safe, { recursive: true });
    symlinkSync(join(home, "wolves/local/1uk4/den"), join(safe, "to-den"));
    symlinkSync(join(home, "wolves/knowledge/base"), join(safe, "to-kb"));
    expect(() => assertSafeDevDataDir(join(safe, "to-den", "x"), home)).toThrow(/den/);
    expect(() => assertSafeDevDataDir(join(safe, "to-kb"), home)).toThrow(/knowledge/);
  });
  it("refuses a symlink into a den", () => {
    const link = join(home, "link");
    symlinkSync(join(home, "wolves/knowledge"), link);
    expect(() => assertSafeDevDataDir(join(link, "new"), home)).toThrow(/knowledge/);
  });
  it("allows a fresh dir elsewhere", () => {
    expect(assertSafeDevDataDir(join(home, ".wolfpack/hubd-dev/t1"), home)).toContain("hubd-dev");
  });
  it("takeSnapshot refuses an unsafe or foreign non-empty dir", async () => {
    await expect(takeSnapshot({ host: "x", dataDir: join(home, "wolves/knowledge/b"), home, hostInfo: HOST, run: async () => ({ code: 0, stderr: "" }) })).rejects.toThrow(/knowledge/);
    const d = mk("hubd-nonempty-");
    writeFileSync(join(d, "f"), "x");
    await expect(takeSnapshot({ host: "x", dataDir: d, hostInfo: HOST, run: async () => ({ code: 0, stderr: "" }) })).rejects.toThrow(/non-empty/);
  });
  it("the default dev data dir is outside ~/wolves and passes the guard", () => {
    const d = defaultDevDataDir(new Date("2026-10-29T12:00:00Z"), home);
    expect(d.startsWith(join(home, ".wolfpack", "hubd-dev"))).toBe(true);
    expect(d.startsWith(join(home, "wolves"))).toBe(false);
    expect(() => assertSafeDevDataDir(d, home)).not.toThrow();
  });
});

describe("serve guard (assertNotLiveMirror) vs dev guard (assertSafeDevDataDir)", () => {
  const home = mk("hubd-home2-");
  mkdirSync(join(home, "wolves/knowledge/base"), { recursive: true });
  mkdirSync(join(home, "wolves/local/1uk4/claude-stateless/den"), { recursive: true });
  it("both refuse live knowledge and dens at any depth", () => {
    for (const guard of [assertNotLiveMirror, assertSafeDevDataDir]) {
      expect(() => guard(join(home, "wolves/knowledge/base/x"), home)).toThrow(/knowledge/);
      expect(() => guard(join(home, "wolves/local/1uk4/claude-stateless/den/s"), home)).toThrow(/den/);
      expect(() => guard(join(home, ".wolfpack/hub"), home)).not.toThrow();
    }
  });
  it("only the dev guard refuses /var/wolfpack and /private/var/wolfpack", () => {
    expect(() => assertSafeDevDataDir("/var/wolfpack/hub", home)).toThrow(/wolfpack/);
    expect(() => assertSafeDevDataDir("/private/var/wolfpack/hub", home)).toThrow(/wolfpack/);
    expect(() => assertNotLiveMirror("/var/wolfpack/hub", home)).not.toThrow();
  });
  it("hubd serve applies the live-mirror guard before binding", async () => {
    const real = join(homedirForTest(), "wolves");
    // main() uses the real home; a path under it is refused without touching anything (no server starts, nothing is created)
    await expect(main(["serve", "--data-dir", join(real, "knowledge", "hubd-test-never-created")], { HUBD_API_KEY: GOOD_KEY }, () => {})).rejects.toThrow(/knowledge/);
    await expect(main(["serve", "--data-dir", join(real, "local", "x", "den", "hubd-test-never-created")], { HUBD_API_KEY: GOOD_KEY }, () => {})).rejects.toThrow(/den/);
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
    expect(a).toContain("--timeout=60");
    for (const o of ["IdentitiesOnly=yes", "IdentityAgent=none", "BatchMode=yes", "ConnectTimeout=5", "ServerAliveInterval=15", "ServerAliveCountMax=3", "-i /k/wolfpack"]) expect(e).toContain(o);
  });
  it("refuses remote destinations, relative sources and mutating flags", () => {
    expect(() => buildPullArgs(HOST, REMOTE_LEDGER, "root@h:/var/wolfpack/x")).toThrow(/LOCAL/);
    expect(() => buildPullArgs(HOST, REMOTE_LEDGER, "h:/x")).toThrow(/LOCAL/);
    expect(() => buildPullArgs(HOST, REMOTE_LEDGER, "rel/dir")).toThrow(/LOCAL/);
    expect(() => buildPullArgs(HOST, "var/x", "/tmp/x")).toThrow(/absolute/);
    expect(() => buildPullArgs(HOST, "/x; rm -rf /", "/tmp/x")).toThrow(/unsafe/);
    expect(buildPullArgs.length).toBe(3); // no caller-supplied flags
  });
  it("takeSnapshot only ever issues rsync pulls", async () => {
    const dataDir = join(mk("hubd-p-"), "snap");
    const calls: string[][] = [];
    await takeSnapshot({ host: "sfo-01", dataDir, hostInfo: HOST, run: fakeRemote(makeRemote(), calls) });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c[0]).toBe("rsync");
      expect(c.at(-2)).toMatch(/^root@100\.64\.0\.9:\/var\/wolfpack\//);
      expect(c.at(-1)!.startsWith(realpathSync.native(dirname(dataDir)))).toBe(true);
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
    const bad = join(mk("hubd-badcfg-"), "config.yaml");
    writeFileSync(bad, "hosts: [\n  apiKey: SECRET-VALUE: : {{\n");
    let msg = "";
    try { resolveHost("sfo-01", bad); } catch (e) { msg = String((e as Error).message); }
    expect(msg).toMatch(/cannot read or parse/);
    expect(msg).not.toContain("SECRET-VALUE");
  });
});

describe("snapshot, manifest, and serving over HTTP", () => {
  it("pulls a fixture, writes manifest + marker, serves GET /v1/work", async () => {
    const dataDir = join(mk("hubd-s-"), "snap");
    const m = await takeSnapshot({ host: "sfo-01", dataDir, hostInfo: HOST, run: fakeRemote(makeRemote(), []), now: () => new Date("2026-10-29T12:00:00Z") });
    expect(m).toMatchObject({ complete: true, sourceHost: "sfo-01", takenAt: "2026-10-29T12:00:00.000Z", remotePaths: { ledger: REMOTE_LEDGER, kbDomains: REMOTE_KB_DOMAINS } });
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
    await expect(main(["dev", "--data-dir", mk("hubd-nomark-")], { HUBD_API_KEY: GOOD_KEY }, () => {})).rejects.toThrow(/DEV-SNAPSHOT/);
  });
  it("a failed pull leaves an incomplete snapshot: marker first, complete:false, re-serve refused, retry allowed", async () => {
    const dataDir = join(mk("hubd-f-"), "snap");
    const remote = makeRemote();
    let n = 0;
    const flaky: PullRunner = async (cmd, args) => {
      if (++n === 2) return { code: 255, stderr: "ssh: connection lost" };
      return fakeRemote(remote, [])(cmd, args);
    };
    await expect(takeSnapshot({ host: "sfo-01", dataDir, hostInfo: HOST, run: flaky })).rejects.toThrow(/connection lost/);
    expect(existsSync(join(dataDir, DEV_MARKER))).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, SNAPSHOT_MANIFEST), "utf8")).complete).toBe(false);
    expect(snapshotState(dataDir)).toBe("incomplete");
    await expect(main(["dev", "--data-dir", dataDir], { HUBD_API_KEY: GOOD_KEY }, () => {})).rejects.toThrow(/INCOMPLETE/);
    // retry into the same dir is allowed because it is incomplete
    const m = await takeSnapshot({ host: "sfo-01", dataDir, hostInfo: HOST, run: fakeRemote(remote, []) });
    expect(m.complete).toBe(true);
    expect(snapshotState(dataDir)).toBe("complete");
  });
  it("the marker exists before the first pull starts", async () => {
    const dataDir = join(mk("hubd-m-"), "snap");
    let seen: boolean | undefined;
    await expect(
      takeSnapshot({ host: "x", dataDir, hostInfo: HOST, run: async () => { seen = existsSync(join(dataDir, DEV_MARKER)); return { code: 1, stderr: "x" }; } }),
    ).rejects.toThrow();
    expect(seen).toBe(true);
  });
  it("refuses to re-pull into a complete snapshot (local writes are never overwritten)", async () => {
    const dataDir = join(mk("hubd-c-"), "snap");
    const remote = makeRemote();
    await takeSnapshot({ host: "sfo-01", dataDir, hostInfo: HOST, run: fakeRemote(remote, []) });
    const calls: string[][] = [];
    await expect(takeSnapshot({ host: "sfo-01", dataDir, hostInfo: HOST, run: fakeRemote(remote, calls) })).rejects.toThrow(/complete snapshot.*fresh/);
    expect(calls).toHaveLength(0);
    await expect(main(["dev", "--snapshot", "sfo-01", "--data-dir", dataDir], { HUBD_API_KEY: GOOD_KEY }, () => {})).rejects.toThrow(/complete snapshot/);
  });
});
