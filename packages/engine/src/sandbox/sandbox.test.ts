import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSandboxed, realPathLoose, requireSnapshotRoot, resolveSandbox, sandboxEnv, SandboxError } from "./resolve.js";
import { isRemoteSpec, RSYNC_RULES, rsyncArgv, sshCommand, takeSnapshot, type SnapshotSource } from "./snapshot.js";
import { loadWolfConfig, normalizeSandbox } from "../wolfconfig/load.js";

const tmps: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `sandbox-${p}-`));
  tmps.push(d);
  return d;
};
const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

/** A fake "live" host: work ledger + work md, ops lanes (incl. a lane we must NOT copy), a den. */
function liveFixture(): { root: string; source: SnapshotSource } {
  const root = tmp("live");
  put(join(root, "work/ledger/work-events.jsonl"), '{"id":"a"}\n{"id":"b"}\n{"id":"torn');
  put(join(root, "base/domains/wolfpack/work/work-wolfpack-a.md"), "# a\n");
  put(join(root, "base/domains/wolfpack/entries/kb-secret.md"), "not a work item\n");
  put(join(root, "ops/inbox/hal/c1.md"), "contribution\n");
  put(join(root, "ops/receipts/hal/r1.json"), "{}\n");
  put(join(root, "ops/parked/hal/p1.md"), "parked\n");
  put(join(root, "ops/rejected/hal/x.md"), "rejected\n");
  put(join(root, "den/memory/t1.md"), "topic\n");
  put(join(root, "den/session.sqlite"), "SQLITE");
  put(join(root, "den/session.sqlite-wal"), "WAL");
  return { root, source: { workDir: join(root, "work"), workBaseDir: join(root, "base"), opsDir: join(root, "ops"), denDir: join(root, "den") } };
}

afterEach(() => {
  tmps.length = 0;
});

describe("takeSnapshot (local sources)", () => {
  it("copies ledger, work items, inbox/receipts/parked and the den into the dev layout, with a manifest", () => {
    const { source } = liveFixture();
    const dev = join(tmp("dev"), "snap");
    const m = takeSnapshot({ source, devRoot: dev, now: () => new Date("2026-10-25T00:00:00Z") });

    expect(readFileSync(join(dev, "ledger/work-events.jsonl"), "utf8")).toBe('{"id":"a"}\n{"id":"b"}\n'); // torn tail dropped
    expect(existsSync(join(dev, "base/domains/wolfpack/work/work-wolfpack-a.md"))).toBe(true);
    expect(existsSync(join(dev, "base/domains/wolfpack/entries/kb-secret.md"))).toBe(false);
    expect(existsSync(join(dev, "ops/inbox/hal/c1.md"))).toBe(true);
    expect(existsSync(join(dev, "ops/receipts/hal/r1.json"))).toBe(true);
    expect(existsSync(join(dev, "ops/parked/hal/p1.md"))).toBe(true);
    expect(existsSync(join(dev, "ops/rejected"))).toBe(false);
    expect(existsSync(join(dev, "den/memory/t1.md"))).toBe(true);
    expect(existsSync(join(dev, "den/session.sqlite"))).toBe(false);
    expect(existsSync(join(dev, "den/session.sqlite-wal"))).toBe(false);

    const onDisk = JSON.parse(readFileSync(join(dev, "snapshot.json"), "utf8"));
    expect(onDisk).toMatchObject({ version: 1, createdAt: "2026-10-25T00:00:00.000Z", source });
    expect(m.counts).toMatchObject({ ledgerEvents: 2, workItems: 1 });
    expect(() => requireSnapshotRoot(dev)).not.toThrow();
  });

  it("includes session stores only on request", () => {
    const { source } = liveFixture();
    const dev = join(tmp("dev"), "snap");
    takeSnapshot({ source, devRoot: dev, includeSessions: true });
    expect(existsSync(join(dev, "den/session.sqlite"))).toBe(true);
  });

  it("refuses a non-empty non-snapshot dir, and a second snapshot without force", () => {
    const { source } = liveFixture();
    const stranger = tmp("stranger");
    put(join(stranger, "precious.txt"), "x");
    expect(() => takeSnapshot({ source, devRoot: stranger })).toThrow(/not a snapshot/);
    expect(existsSync(join(stranger, "precious.txt"))).toBe(true);

    const dev = join(tmp("dev"), "snap");
    takeSnapshot({ source, devRoot: dev });
    expect(() => takeSnapshot({ source, devRoot: dev })).toThrow(/force/);
    put(join(dev, "den/local-edit.md"), "dev edit");
    takeSnapshot({ source, devRoot: dev, force: true });
    expect(existsSync(join(dev, "den/local-edit.md"))).toBe(false);
  });

  it("refuses a dev root that overlaps a source", () => {
    const { root, source } = liveFixture();
    expect(() => takeSnapshot({ source, devRoot: join(root, "den", "inside") })).toThrow(/overlaps/);
    expect(() => takeSnapshot({ source, devRoot: root })).toThrow(/overlaps/);
  });

  it("does not follow symlinks out of the source", () => {
    const { root, source } = liveFixture();
    const outside = tmp("outside");
    put(join(outside, "leak.md"), "leak");
    symlinkSync(outside, join(root, "den", "escape"));
    const dev = join(tmp("dev"), "snap");
    takeSnapshot({ source, devRoot: dev });
    expect(existsSync(join(dev, "den/escape"))).toBe(false);
  });
});

describe("isRemoteSpec", () => {
  it.each([
    ["root@100.1.2.3:/var/wolfpack/kb/work", true],
    ["sfo-01:/var/wolfpack/kb/ops", true],
    ["/var/wolfpack/kb/ops", false],
    ["./rel:colon", false],
    ["~/wolves", false],
  ])("%s -> %s", (spec, remote) => expect(isRemoteSpec(spec)).toBe(remote));
});

describe("resolveSandbox / assertSandboxed", () => {
  it("redirects den, KB_OPS, KB_DEN_LOCAL and WORK_ENDPOINT into the dev root", () => {
    const root = tmp("root");
    const r = resolveSandbox(root, { workEndpoint: "http://127.0.0.1:4000/work" });
    expect(r).toMatchObject({ den: join(root, "den"), kbOps: join(root, "ops"), kbDenLocal: join(root, "den", "kb"), workLedgerDir: root });
    expect(sandboxEnv(r, "tok")).toEqual({
      WOLF_DEN: join(root, "den"),
      KB_OPS: join(root, "ops"),
      KB_DEN_LOCAL: join(root, "den", "kb"),
      WORK_ENDPOINT: "http://127.0.0.1:4000/work",
      WORK_TOKEN: "tok",
    });
    expect(() => assertSandboxed(root, r)).not.toThrow();
  });

  it("fails closed on anything outside the root, unset roots, symlink escapes and remote endpoints", () => {
    const root = tmp("root");
    const live = tmp("live");
    const ok = resolveSandbox(root, { workEndpoint: "http://127.0.0.1:1/work" });
    expect(() => assertSandboxed(root, { ...ok, kbOps: join(live, "ops") })).toThrow(SandboxError);
    expect(() => assertSandboxed(root, { ...ok, den: undefined })).toThrow(/not set/);
    expect(() => assertSandboxed(root, { ...ok, workEndpoint: "http://100.120.154.69:3141/work" })).toThrow(/loopback/);
    mkdirSync(root, { recursive: true });
    symlinkSync(live, join(root, "den"));
    expect(() => assertSandboxed(root, ok)).toThrow(/outside the dev root/);
  });

  it("requireSnapshotRoot rejects a dir that was never snapshotted", () => {
    expect(() => requireSnapshotRoot(tmp("blank"))).toThrow(/not a snapshot/);
  });
});

describe("wolf.yaml sandbox / memory.live", () => {
  const load = (yaml: string) => {
    const dir = tmp("wolf");
    writeFileSync(join(dir, "wolf.yaml"), `name: w\n${yaml}`);
    return loadWolfConfig(join(dir, "wolf.yaml"), { home: dir });
  };
  it("defaults: no sandbox, memory.live false", () => {
    const { config, warnings } = load("");
    expect(config.sandbox).toBeUndefined();
    expect(config.memory.live).toBe(false);
    expect(warnings).toEqual([]);
  });
  it("sandbox: true -> <dir>/sandbox; sandbox.root explicit; memory.live", () => {
    const a = load("sandbox: true\n");
    expect(a.config.sandbox).toEqual({ root: join(a.config.dir, "sandbox") });
    const b = load("sandbox:\n  root: /tmp/snap\nmemory:\n  live: true\n  consolidation: { threshold: 1 }\n");
    expect(b.config.sandbox).toEqual({ root: "/tmp/snap" });
    expect(b.config.memory.live).toBe(true);
    expect(load("sandbox: false\n").config.sandbox).toBeUndefined();
  });
});

describe("remote rsync (argv + filters)", () => {
  it("builds the exact argv: ssh -e with a quoted identity, rules, -- before the paths", () => {
    expect(sshCommand("/k/my key")).toBe("ssh -o BatchMode=yes -o ConnectTimeout=5 -i '/k/my key' -o IdentitiesOnly=yes -o IdentityAgent=none");
    expect(rsyncArgv("root@h:/var/wolfpack/kb/work", "/dev/snap", [...RSYNC_RULES.ledger], "/k/id")).toEqual([
      "-a", "--no-links", "-e", "ssh -o BatchMode=yes -o ConnectTimeout=5 -i '/k/id' -o IdentitiesOnly=yes -o IdentityAgent=none",
      "--include=/ledger/", "--include=/ledger/work-events.jsonl", "--exclude=*",
      "--", "root@h:/var/wolfpack/kb/work/", "/dev/snap/",
    ]);
  });

  it("the filters copy exactly the right files (rsync local mode, no ssh)", () => {
    const { source } = liveFixture();
    const run = (src: string, dest: string, rules: readonly string[]) => {
      const r = spawnSync("rsync", rsyncArgv(src, dest, [...rules], undefined, { local: true }), { encoding: "utf8" });
      expect(r.status).toBe(0);
    };
    const dev = tmp("rsync-dev");
    run(source.workDir, dev, RSYNC_RULES.ledger);
    expect(readFileSync(join(dev, "ledger/work-events.jsonl"), "utf8")).toContain('"id":"a"');
    const base = join(dev, "base");
    run(source.workBaseDir!, base, RSYNC_RULES.workMd);
    expect(existsSync(join(base, "domains/wolfpack/work/work-wolfpack-a.md"))).toBe(true);
    expect(existsSync(join(base, "domains/wolfpack/entries"))).toBe(false);
    const ops = join(dev, "ops");
    run(source.opsDir, ops, RSYNC_RULES.ops);
    expect(existsSync(join(ops, "inbox/hal/c1.md"))).toBe(true);
    expect(existsSync(join(ops, "parked/hal/p1.md"))).toBe(true);
    expect(existsSync(join(ops, "rejected"))).toBe(false);
  });
});

describe("hardening", () => {
  it("normalizeSandbox throws on malformed values instead of running live", () => {
    for (const bad of ["yes", {}, { root: 5 }, { root: "" }, 1, []]) expect(() => normalizeSandbox(bad, "/w")).toThrow(/invalid sandbox/);
    expect(normalizeSandbox(undefined, "/w")).toBeUndefined();
    expect(normalizeSandbox(false, "/w")).toBeUndefined();
    expect(normalizeSandbox(true, "/w")).toEqual({ root: "/w/sandbox" });
  });

  it("assertSandboxed requires a loopback WORK_ENDPOINT", () => {
    const root = tmp("root");
    const r = resolveSandbox(root);
    expect(() => assertSandboxed(root, r)).toThrow(/WORK_ENDPOINT is not set/);
  });

  it("realPathLoose resolves dangling symlinks and rejects ones that point outside", () => {
    const root = tmp("root");
    const live = tmp("live");
    symlinkSync(join(live, "not-yet"), join(root, "den"));
    expect(realPathLoose(join(root, "den", "x"))).toBe(join(realPathLoose(live), "not-yet", "x"));
    const ok = resolveSandbox(root, { workEndpoint: "http://127.0.0.1:1/work" });
    expect(() => assertSandboxed(root, ok)).toThrow(/outside the dev root/);
  });

  it("realPathLoose at the filesystem root and a '..x' directory name inside the root", () => {
    expect(realPathLoose("/")).toBe("/");
    expect(realPathLoose("/definitely-missing-dir-xyz/a")).toBe("/definitely-missing-dir-xyz/a");
    const root = tmp("root");
    mkdirSync(join(root, "..odd"), { recursive: true });
    const ep = "http://127.0.0.1:1/work";
    expect(() => assertSandboxed(root, { den: join(root, "..odd"), kbOps: join(root, "ops"), kbDenLocal: join(root, "kb"), workEndpoint: ep })).not.toThrow();
  });
});
