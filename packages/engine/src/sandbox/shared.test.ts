/**
 * The shared dev sandbox: KB copy, per-wolf dens, the single work-ledger writer, librarian-on-a-copy, and the remote
 * ledger part (argv, filters and hash checks with a fake runner; no network).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLibrarianSandboxed, assertSafeRemoteSpec, crossCheckWork, formatCommand, INSTALL_MARKER, liveWorkWriterPid, TORN_LOCK_MAX_AGE_MS, assertReadOnlyRsyncArgv, assertSandboxed, acquireWorkWriterLock, dryRunRemote, parseSha256sum,
  readWorkServerRunFile, remotePlan, remoteSha256Argv, resolveSandbox, rsyncArgv, sandboxEnv, sandboxPaths, SandboxError, splitRemote,
  seedLibrarianState, takeSnapshot, wolfDenDir, RSYNC_RULES, type Runner, type SnapshotSource,
} from "./index.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `shared-${p}-`));
  dirs.push(d);
  return d;
};
const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function hashTree(dir: string): string {
  const lines: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        lines.push(`${p}/`);
        walk(p);
      } else lines.push(`${p} ${sha(readFileSync(p))} ${statSync(p).size}`);
    }
  };
  walk(dir);
  return sha(lines.join("\n"));
}

/** local fixture: ledger dir, KB base (with work files + litter), a den, ops lanes of two wolves */
function fixture() {
  const root = tmp("src");
  put(join(root, "work/ledger/work-events.jsonl"), '{"id":"a"}\n{"id":"b"}\n');
  put(join(root, "work/base/domains/wolfpack/work/work-wolfpack-a.md"), "# a\n");
  put(join(root, "kb/domains/wolfpack/entries/kb-wolfpack-x.md"), "entry\n");
  put(join(root, "kb/domains/wolfpack/work/work-wolfpack-live.md"), "live work item copy\n");
  put(join(root, "kb/domains.yaml"), "domains: [wolfpack]\n");
  put(join(root, "kb/.DS_Store"), "x");
  put(join(root, "den/memory/t1.md"), "topic\n");
  put(join(root, "ops/inbox/1uk4-dev/c1.md"), "mine\n");
  put(join(root, "ops/inbox/hal/c2.md"), "not mine\n");
  put(join(root, "ops/receipts/1uk4-dev/r1.json"), "{}\n");
  const source: SnapshotSource = { workDir: join(root, "work"), workBaseDir: join(root, "work/base"), denDir: join(root, "den"), kbBaseDir: join(root, "kb"), opsDir: join(root, "ops"), opsLanes: ["1uk4-dev"] };
  return { root, source };
}

afterEach(() => {
  dirs.length = 0;
});

describe("KB copy in the snapshot", () => {
  it("copies the KB base read-only into <root>/kb-base (no work files, no litter), records it, leaves the source byte-identical", () => {
    const { root, source } = fixture();
    const before = hashTree(join(root, "kb"));
    const dev = join(tmp("dev"), "box");
    const m = takeSnapshot({ source, devRoot: dev });
    expect(existsSync(join(dev, "kb-base/domains/wolfpack/entries/kb-wolfpack-x.md"))).toBe(true);
    expect(existsSync(join(dev, "kb-base/domains.yaml"))).toBe(true);
    expect(existsSync(join(dev, "kb-base/domains/wolfpack/work"))).toBe(false);
    expect(existsSync(join(dev, "kb-base/.DS_Store"))).toBe(false);
    expect(m.counts.kbBaseFiles).toBe(2);
    expect(JSON.parse(readFileSync(join(dev, "snapshot.json"), "utf8")).source.kbBaseDir).toBe(join(root, "kb"));
    expect(hashTree(join(root, "kb"))).toBe(before);
  });

  it("never pulls a KB from a host", () => {
    const { source } = fixture();
    expect(() => takeSnapshot({ source: { ...source, kbBaseDir: "root@h:/var/wolfpack/kb/base" }, devRoot: join(tmp("dev"), "box") })).toThrow(/local path/);
  });

  it("copies only the named ops lanes", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev });
    expect(existsSync(join(dev, "ops/inbox/1uk4-dev/c1.md"))).toBe(true);
    expect(existsSync(join(dev, "ops/receipts/1uk4-dev/r1.json"))).toBe(true);
    expect(existsSync(join(dev, "ops/inbox/hal"))).toBe(false);
  });

  it("refuses a dev root that overlaps a protected/synced path (either way), before copying anything", () => {
    const { source } = fixture();
    const synced = tmp("synced");
    expect(() => takeSnapshot({ source, devRoot: join(synced, "inside"), forbiddenRoots: [synced] })).toThrow(/protected\/synced/);
    expect(() => takeSnapshot({ source, devRoot: synced, forbiddenRoots: [join(synced, "sub")] })).toThrow(/protected\/synced/);
    expect(existsSync(join(synced, "inside"))).toBe(false);
    // an empty entry (Syncthing's default folder has path="") must not match everything
    expect(() => takeSnapshot({ source, devRoot: join(tmp("ok"), "box"), forbiddenRoots: [""] })).not.toThrow();
  });
});

describe("resolveSandbox with a KB copy and per-wolf dens", () => {
  it("KB_BASE follows the copy; without one it stays out of the env (ambient)", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev });
    const r = resolveSandbox(dev, { workEndpoint: "http://127.0.0.1:1" });
    expect(r.kbBase).toBe(join(dev, "kb-base"));
    expect(sandboxEnv(r).KB_BASE).toBe(join(dev, "kb-base"));
    const bare = tmp("bare");
    expect(sandboxEnv(resolveSandbox(bare)).KB_BASE).toBeUndefined();
  });

  it("assertSandboxed is strict about KB_BASE once a copy exists (unset or live is refused)", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev });
    const ok = { ...resolveSandbox(dev, { workEndpoint: "http://127.0.0.1:1/work" }) };
    expect(() => assertSandboxed(dev, ok)).not.toThrow();
    expect(() => assertSandboxed(dev, { ...ok, kbBase: undefined })).toThrow(/KB_BASE is not set/);
    expect(() => assertSandboxed(dev, { ...ok, kbBase: tmp("live-kb") })).toThrow(/outside the dev root/);
  });

  it("a shared root gives each wolf its own den under dens/<wolf>; a single-wolf root keeps den/", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev, denName: "1uk4-dev" });
    expect(existsSync(join(dev, "dens/1uk4-dev/memory/t1.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dev, "snapshot.json"), "utf8")).den).toBe("dens/1uk4-dev");
    const a = resolveSandbox(dev, { wolf: "1uk4-dev" });
    const b = resolveSandbox(dev, { wolf: "dewey-dev" });
    expect(a.den).toBe(wolfDenDir(dev, "1uk4-dev"));
    expect(b.den).toBe(join(dev, "dens", "dewey-dev"));
    expect(b.kbDenLocal).toBe(join(dev, "dens", "dewey-dev", "kb"));
    expect(a.den).not.toBe(b.den);
    // single-wolf layout: no dens/ -> den/ whatever the name
    const single = tmp("single");
    expect(resolveSandbox(single, { wolf: "x" }).den).toBe(join(single, "den"));
    expect(() => wolfDenDir(dev, "../escape")).toThrow(/invalid wolf name/);
  });
});

describe("librarian on a KB copy only", () => {
  const live = () => tmp("live");
  it("is refused without a kb-base copy and allowed with one when every root is inside", () => {
    const bare = tmp("bare");
    const paths = { kbBase: join(bare, "kb-base"), kbOps: join(bare, "ops"), denLocal: join(bare, "den", "kb") };
    expect(() => assertLibrarianSandboxed(bare, paths)).toThrow(/KB copy/);

    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev });
    const r = resolveSandbox(dev);
    const good = { kbBase: r.kbBase, kbOps: r.kbOps, denLocal: r.kbDenLocal, extra: { sweepLock: join(r.kbDenLocal, "sweep.lock"), vectors: join(r.kbDenLocal, "vectors") } };
    expect(() => assertLibrarianSandboxed(dev, good)).not.toThrow();
    expect(() => assertLibrarianSandboxed(dev, { ...good, kbBase: join(live(), "base") })).toThrow(/outside|not the sandbox KB copy/);
    expect(() => assertLibrarianSandboxed(dev, { ...good, kbOps: join(live(), "ops") })).toThrow(/kbOps .* outside/);
    expect(() => assertLibrarianSandboxed(dev, { ...good, denLocal: join(live(), "kb") })).toThrow(/denLocal .* outside/);
    expect(() => assertLibrarianSandboxed(dev, { ...good, extra: { vectors: join(live(), "vectors") } })).toThrow(/vectors .* outside/);
    expect(() => assertLibrarianSandboxed(dev, { ...good, extra: { sweepLock: "" } })).toThrow(/not set/);
  });
});

describe("exactly one work-ledger writer", () => {
  it("a second live writer fails loudly; the first can still publish/release; a dead owner's lock is taken over", () => {
    const root = tmp("lock");
    const a = acquireWorkWriterLock(root, process.pid);
    a.publish({ url: "http://127.0.0.1:1234", token: "t" });
    expect(readWorkServerRunFile(root)).toMatchObject({ url: "http://127.0.0.1:1234", token: "t", pid: process.pid });
    // some other live process (the parent) tries to write the same ledger
    expect(() => acquireWorkWriterLock(root, process.ppid)).toThrow(SandboxError);
    expect(() => acquireWorkWriterLock(root, process.ppid)).toThrow(/already has a writer/);
    a.release();
    expect(readWorkServerRunFile(root)).toBeUndefined();
    const b = acquireWorkWriterLock(root, process.ppid); // free again
    b.release();

    // stale: lock + run file of a pid that is gone
    const p = sandboxPaths(root);
    put(p.workServerLock, JSON.stringify({ pid: 2 ** 22 + 12345 }));
    put(p.workServerFile, JSON.stringify({ pid: 2 ** 22 + 12345, url: "http://127.0.0.1:9", token: "x" }));
    expect(readWorkServerRunFile(root)).toBeUndefined();
    const c = acquireWorkWriterLock(root);
    c.release();
  });

  it("the run file is private (0600) and a release only removes what its owner wrote", () => {
    const root = tmp("lock2");
    const a = acquireWorkWriterLock(root);
    a.publish({ url: "http://127.0.0.1:1", token: "secret" });
    expect(statSync(sandboxPaths(root).workServerFile).mode & 0o777).toBe(0o600);
    put(sandboxPaths(root).workServerFile, JSON.stringify({ pid: process.ppid, url: "u", token: "t" })); // someone else's now
    a.release();
    expect(existsSync(sandboxPaths(root).workServerFile)).toBe(true);
  });
});

describe("remote ledger: read-only by construction", () => {
  const HOST = "root@100.1.2.3";
  const remoteSource = (src: SnapshotSource): SnapshotSource => ({ ...src, workDir: `${HOST}:/var/wolfpack/kb/work`, workBaseDir: `${HOST}:/var/wolfpack/kb/base` });

  it("builds the exact rsync argv: source remote, -- before paths, filters, no --delete; -n for a dry run", () => {
    const argv = rsyncArgv(`${HOST}:/var/wolfpack/kb/work`, "/dev/x", [...RSYNC_RULES.ledger], "/k/id", { dryRun: true });
    expect(argv).toEqual([
      "-a", "--no-links", "-n", "--itemize-changes",
      "-e", "ssh -o BatchMode=yes -o ConnectTimeout=5 -i '/k/id' -o IdentitiesOnly=yes -o IdentityAgent=none",
      "--include=/ledger/", "--include=/ledger/work-events.jsonl", "--exclude=*",
      "--", `${HOST}:/var/wolfpack/kb/work/`, "/dev/x/",
    ]);
    expect(argv.some((a) => a.startsWith("--delete"))).toBe(false);
    expect(() => assertReadOnlyRsyncArgv(argv)).not.toThrow();
  });

  it("refuses any rsync argv that could delete, move or write the remote", () => {
    const base = rsyncArgv(`${HOST}:/p`, "/d", [...RSYNC_RULES.ledger], "/k");
    for (const bad of ["--delete", "--delete-after", "--remove-source-files", "--move-files", "--rsync-path=sudo rsync", "--files-from=/etc/x", "--daemon"]) {
      expect(() => assertReadOnlyRsyncArgv([...base.slice(0, -3), bad, ...base.slice(-3)]), bad).toThrow(/refusing/);
    }
    expect(() => assertReadOnlyRsyncArgv(["-a", "--", "/local/a", `${HOST}:/remote/`])).toThrow(/must be local/);
    expect(() => assertReadOnlyRsyncArgv(["-a", "-e", "ssh x", "--", "/local/a", "/b/"])).toThrow(/remote spec/);
    expect(() => assertReadOnlyRsyncArgv(["-a", "--delete"])).toThrow(/end with/);
  });

  it("the hash command is one read-only sha256sum over ssh, path quoted", () => {
    expect(remoteSha256Argv(`${HOST}:/var/wolfpack/kb/work/ledger/work-events.jsonl`, "/k/id")).toEqual([
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-i", "/k/id", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
      HOST, "sha256sum -- '/var/wolfpack/kb/work/ledger/work-events.jsonl'",
    ]);
    expect(splitRemote(`${HOST}:/a/b`)).toEqual({ host: HOST, path: "/a/b" });
    expect(parseSha256sum(`${"a".repeat(64)}  /x\n`)).toBe("a".repeat(64));
    expect(() => parseSha256sum("nope")).toThrow(/unexpected/);
  });

  it("remotePlan lists exactly: hash, rsync ledger, hash, rsync items; and only remote parts", () => {
    const { source } = fixture();
    const plan = remotePlan(remoteSource(source), "/k/id");
    expect(plan.map((p) => p.label)).toEqual(["ledger hash (before)", "ledger", "work items", "ledger hash (after)"]);
    expect(plan[0].command).toContain("sha256sum -- ");
    expect(plan[1].command).toContain("--include=/ledger/work-events.jsonl");
    expect(plan[2].command).toContain("--include=/domains/*/work/*.md");
    expect(remotePlan(source)).toEqual([]);
    for (const p of plan) expect(p.command).not.toMatch(/--delete|\/den|\/ops|kb-base/);
  });

  /** A fake host: serves `ledger` for rsync (copies into the dest named in argv) and `hashes` for ssh, in order. */
  function fakeRunner(opts: { ledger: string; hashes: string[]; rsyncStatus?: number }): { runner: Runner; calls: { rsync: string[][]; ssh: string[][] } } {
    const calls = { rsync: [] as string[][], ssh: [] as string[][] };
    let i = 0;
    const runner: Runner = {
      rsync(argv) {
        calls.rsync.push(argv);
        const dest = argv[argv.length - 1];
        if (argv.includes("--include=/ledger/work-events.jsonl")) put(join(dest, "ledger/work-events.jsonl"), opts.ledger);
        if (argv.includes("--include=/domains/*/work/*.md")) put(join(dest, "domains/wolfpack/work/work-wolfpack-r.md"), "# remote item\n");
        return { status: opts.rsyncStatus ?? 0, stdout: argv.includes("-n") ? ">f+++++++++ ledger/work-events.jsonl\n" : "", stderr: "" };
      },
      ssh(argv) {
        calls.ssh.push(argv);
        return { status: 0, stdout: `${opts.hashes[Math.min(i++, opts.hashes.length - 1)]}  /x\n`, stderr: "" };
      },
    };
    return { runner, calls };
  }
  const LEDGER = '{"id":"r1"}\n{"id":"r2"}\n';

  it("installs a remote ledger only when the copy equals the remote hash taken before AND the remote did not move", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    const { runner, calls } = fakeRunner({ ledger: LEDGER, hashes: [sha(LEDGER), sha(LEDGER)] });
    const m = takeSnapshot({ source: remoteSource(source), devRoot: dev, runner, sshIdentity: "/k/id" });
    expect(readFileSync(join(dev, "ledger/work-events.jsonl"), "utf8")).toBe(LEDGER);
    expect(existsSync(join(dev, "base/domains/wolfpack/work/work-wolfpack-r.md"))).toBe(true);
    expect(m.ledgerSha256).toBe(sha(LEDGER));
    expect(calls.ssh).toHaveLength(2); // before + after, nothing else over ssh
    for (const a of calls.ssh) expect(a[a.length - 1]).toMatch(/^sha256sum -- '/);
    expect(calls.rsync).toHaveLength(2); // ledger + items; den/ops/KB are local
    expect(existsSync(join(dev, "kb-base"))).toBe(true);
  });

  it("fails loudly, installing nothing, when the copy does not match the hash taken before", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    const { runner } = fakeRunner({ ledger: LEDGER, hashes: [sha("something else"), sha("something else")] });
    expect(() => takeSnapshot({ source: remoteSource(source), devRoot: dev, runner })).toThrow(/copied ledger sha256 .* != remote/);
    expect(existsSync(join(dev, "snapshot.json"))).toBe(false);
    expect(existsSync(join(dev, "ledger"))).toBe(false);
  });

  it("fails loudly when the remote ledger changed between before and after", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    const { runner } = fakeRunner({ ledger: LEDGER, hashes: [sha(LEDGER), sha(LEDGER + '{"id":"r3"}\n')] });
    expect(() => takeSnapshot({ source: remoteSource(source), devRoot: dev, runner })).toThrow(/changed during the snapshot/);
    expect(existsSync(join(dev, "snapshot.json"))).toBe(false);
    expect(existsSync(join(dev, "ledger"))).toBe(false);
  });

  it("a failed refresh leaves the existing snapshot's ledger untouched", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev, denName: "w" });
    const before = readFileSync(join(dev, "ledger/work-events.jsonl"), "utf8");
    const { runner } = fakeRunner({ ledger: LEDGER, hashes: [sha("x"), sha("x")] });
    expect(() => takeSnapshot({ source: remoteSource(source), devRoot: dev, runner, workOnly: true })).toThrow(/sha256/);
    expect(readFileSync(join(dev, "ledger/work-events.jsonl"), "utf8")).toBe(before);
  });

  it("dry run runs rsync -n only: lists files, copies nothing, no ssh hash, no dev root", () => {
    const { source } = fixture();
    const { runner, calls } = fakeRunner({ ledger: LEDGER, hashes: [] });
    const out = dryRunRemote(remoteSource(source), "/k/id", runner);
    expect(out).toEqual([
      { label: "ledger", lines: [">f+++++++++ ledger/work-events.jsonl"] },
      { label: "work items", lines: [">f+++++++++ ledger/work-events.jsonl"] },
    ]);
    expect(calls.ssh).toHaveLength(0);
    for (const a of calls.rsync) expect(a).toEqual(expect.arrayContaining(["-n", "--itemize-changes"]));
  });

  it("rsync failure is reported with the host spec and installs nothing", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    const { runner } = fakeRunner({ ledger: LEDGER, hashes: [sha(LEDGER)], rsyncStatus: 23 });
    expect(() => takeSnapshot({ source: remoteSource(source), devRoot: dev, runner })).toThrow(/rsync from .* failed/);
    expect(existsSync(join(dev, "snapshot.json"))).toBe(false);
  });
});

describe("refresh and re-snapshot never delete", () => {
  it("--force moves the previous parts aside instead of deleting them", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev, denName: "w" });
    put(join(dev, "dens/w/local-edit.md"), "dev edit");
    put(join(dev, "kb-base/domains/wolfpack/entries/kb-dewey-made.md"), "made by the sandbox librarian");
    takeSnapshot({ source, devRoot: dev, denName: "w", force: true, now: () => new Date("2026-10-26T00:00:00Z") });
    expect(existsSync(join(dev, "dens/w/local-edit.md"))).toBe(false);
    const aside = readdirSync(dev).find((n) => n.startsWith(".replaced-"))!;
    expect(readFileSync(join(dev, aside, "dens/w/local-edit.md"), "utf8")).toBe("dev edit");
    expect(readFileSync(join(dev, aside, "kb-base/domains/wolfpack/entries/kb-dewey-made.md"), "utf8")).toBe("made by the sandbox librarian");
    expect(existsSync(join(dev, aside, "ledger/work-events.jsonl"))).toBe(true);
  });

  it("a shared-root re-snapshot of one wolf leaves the other wolves' dens alone", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev, denName: "a" });
    put(join(dev, "dens/b/memory/b.md"), "b's den");
    takeSnapshot({ source, devRoot: dev, denName: "a", force: true });
    expect(readFileSync(join(dev, "dens/b/memory/b.md"), "utf8")).toBe("b's den");
  });

  it("workOnly swaps ledger + items, keeps den/ops/kb-base, and keeps the old ledger", () => {
    const { root, source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev, denName: "w" });
    put(join(dev, "dens/w/memory/new.md"), "wolf made");
    put(join(dev, "ops/inbox/1uk4-dev/c-new.md"), "queued");
    put(join(root, "work/ledger/work-events.jsonl"), '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
    const m = takeSnapshot({ source: { ...source, kbBaseDir: undefined }, devRoot: dev, workOnly: true, now: () => new Date("2026-10-26T01:00:00Z") });
    expect(m.counts.ledgerEvents).toBe(3);
    expect(m.den).toBe("dens/w");
    expect(existsSync(join(dev, "dens/w/memory/new.md"))).toBe(true);
    expect(existsSync(join(dev, "ops/inbox/1uk4-dev/c-new.md"))).toBe(true);
    expect(existsSync(join(dev, "kb-base/domains.yaml"))).toBe(true);
    const aside = readdirSync(dev).find((n) => n.startsWith(".replaced-"))!;
    expect(readFileSync(join(dev, aside, "ledger/work-events.jsonl"), "utf8")).toBe('{"id":"a"}\n{"id":"b"}\n');
  });

  it("refuses to swap a ledger while the sandbox work server is running", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev });
    const lock = acquireWorkWriterLock(dev);
    lock.publish({ url: "http://127.0.0.1:1", token: "t" });
    expect(() => takeSnapshot({ source, devRoot: dev, force: true })).toThrow(/work server is running/);
    expect(() => takeSnapshot({ source, devRoot: dev, workOnly: true })).toThrow(/work server is running/);
    lock.release();
    expect(() => takeSnapshot({ source, devRoot: dev, workOnly: true })).not.toThrow();
  });

  it("workOnly needs an existing snapshot", () => {
    const { source } = fixture();
    expect(() => takeSnapshot({ source, devRoot: join(tmp("dev"), "none"), workOnly: true })).toThrow(/not a snapshot/);
  });
});

describe("seedLibrarianState", () => {
  it("copies the KB ledger/vectors/sections/bookkeeping (no backups) from a librarian den, read-only, never overwriting", () => {
    const src = tmp("dewey-den");
    put(join(src, "kb/ledger/events.jsonl"), '{"e":1}\n');
    put(join(src, "kb/ledger/events.jsonl.bak-2026"), "backup");
    put(join(src, "kb/vectors/cache.jsonl"), "v\n");
    put(join(src, "kb/sections/s.json"), "{}");
    put(join(src, "kb/emitted.json"), "{}");
    put(join(src, "kb/pass1-backup-x/old.md"), "old");
    put(join(src, "session.sqlite"), "SQLITE");
    const before = hashTree(src);
    const dest = join(tmp("dest"), "dens/dewey-dev");
    expect(seedLibrarianState(src, dest)).toBe(4);
    expect(readFileSync(join(dest, "kb/ledger/events.jsonl"), "utf8")).toBe('{"e":1}\n');
    expect(existsSync(join(dest, "kb/vectors/cache.jsonl"))).toBe(true);
    expect(existsSync(join(dest, "kb/ledger/events.jsonl.bak-2026"))).toBe(false);
    expect(existsSync(join(dest, "kb/pass1-backup-x"))).toBe(false);
    expect(existsSync(join(dest, "session.sqlite"))).toBe(false);
    expect(hashTree(src)).toBe(before);
    expect(() => seedLibrarianState(src, dest)).toThrow(/already has a KB ledger/);
    expect(() => seedLibrarianState(tmp("empty"), join(tmp("d2"), "x"))).toThrow(/no ledger/);
  });
});

describe("remote ledger + local work-md mirror", () => {
  const HOST = "root@100.1.2.3";
  const LEDGER = '{"type":"work.created","id":"work-wolfpack-a"}\n{"type":"work.created","id":"work-wolfpack-ghost"}\n';
  const runnerFor = (ledger: string) => {
    const rsyncs: string[][] = [];
    const h = sha(ledger);
    const runner: Runner = {
      rsync(argv) {
        rsyncs.push(argv);
        put(join(argv[argv.length - 1], "ledger/work-events.jsonl"), ledger);
        return { status: 0, stdout: "", stderr: "" };
      },
      ssh: () => ({ status: 0, stdout: `${h}  /x\n`, stderr: "" }),
    };
    return { runner, rsyncs };
  };

  it("only the ledger is rsynced; item files come from the local mirror (read-only) and the plan shows no .md rsync", () => {
    const { root } = fixture();
    const mirror = join(root, "mirror");
    put(join(mirror, "domains/wolfpack/work/work-wolfpack-a.md"), "# a\n");
    put(join(mirror, "domains/wolfpack/work/work-wolfpack-extra.md"), "# x\n");
    put(join(mirror, "domains/wolfpack/entries/kb.md"), "not work\n");
    const before = hashTree(mirror);
    const source: SnapshotSource = { workDir: `${HOST}:/var/wolfpack/kb/work`, workBaseDir: mirror, denDir: join(root, "den") };
    const plan = remotePlan(source, "/k");
    expect(plan.map((p) => p.label)).toEqual(["ledger hash (before)", "ledger", "ledger hash (after)"]);
    const dev = join(tmp("dev"), "box");
    const { runner, rsyncs } = runnerFor(LEDGER);
    takeSnapshot({ source, devRoot: dev, runner, requireWorkItems: true });
    expect(rsyncs).toHaveLength(1);
    expect(rsyncs[0].join(" ")).not.toContain("/domains/");
    expect(existsSync(join(dev, "base/domains/wolfpack/work/work-wolfpack-a.md"))).toBe(true);
    expect(existsSync(join(dev, "base/domains/wolfpack/entries"))).toBe(false);
    expect(hashTree(mirror)).toBe(before);
    expect(dryRunRemote(source, "/k", runner).map((p) => p.label)).toEqual(["ledger"]);
    const x = crossCheckWork(join(dev, "ledger/work-events.jsonl"), join(dev, "base"));
    expect(x).toEqual({ ledgerIds: 2, mdFiles: 2, missingMd: ["work-wolfpack-ghost"], missingLedger: ["work-wolfpack-extra"] });
  });

  it("fails loudly, installing nothing, when the ledger has events but the mirror has 0 .md files", () => {
    const { root } = fixture();
    const mirror = join(root, "empty-mirror");
    mkdirSync(mirror, { recursive: true });
    const dev = join(tmp("dev"), "box");
    expect(() => takeSnapshot({ source: { workDir: `${HOST}:/var/wolfpack/kb/work`, workBaseDir: mirror, denDir: join(root, "den") }, devRoot: dev, runner: runnerFor(LEDGER).runner, requireWorkItems: true })).toThrow(/0 work item \.md files/);
    expect(existsSync(join(dev, "snapshot.json"))).toBe(false);
    expect(existsSync(join(dev, "ledger"))).toBe(false);
  });
});

describe("writer lock hardening", () => {
  it("a torn (unparseable) lock counts as HELD while fresh, and is taken over only once old", () => {
    const root = tmp("torn");
    const p = sandboxPaths(root);
    put(p.workServerLock, '{"pid": 12'); // torn write
    expect(() => acquireWorkWriterLock(root)).toThrow(/already has a writer/);
    expect(liveWorkWriterPid(root)).toBeUndefined();
    const old = new Date(Date.now() - TORN_LOCK_MAX_AGE_MS - 5000);
    utimesSync(p.workServerLock, old, old);
    const l = acquireWorkWriterLock(root);
    expect(JSON.parse(readFileSync(p.workServerLock, "utf8")).pid).toBe(process.pid);
    l.release();
  });

  it("the lock appears complete (no temp litter, never empty) and is never visible half-written", () => {
    const root = tmp("atomic");
    const l = acquireWorkWriterLock(root);
    expect(JSON.parse(readFileSync(sandboxPaths(root).workServerLock, "utf8")).pid).toBe(process.pid);
    expect(readdirSync(sandboxPaths(root).runDir).filter((n) => n !== "work-server.lock")).toEqual([]);
    l.release();
  });

  it("two contenders racing for a stale lock: exactly one wins, and neither ever removes the winner's live lock", () => {
    const root = tmp("race");
    const p = sandboxPaths(root);
    put(p.workServerLock, JSON.stringify({ pid: 2 ** 22 + 4242 })); // dead owner
    const a = acquireWorkWriterLock(root, process.pid);
    // the second contender (a live pid) arrives after A holds the lock
    expect(() => acquireWorkWriterLock(root, process.ppid)).toThrow(/already has a writer \(pid \d+/);
    expect(JSON.parse(readFileSync(p.workServerLock, "utf8")).pid).toBe(process.pid);
    a.release();
    // sequential stale takeovers by both: the second finds a live lock, not a stale one
    put(p.workServerLock, JSON.stringify({ pid: 2 ** 22 + 4243 }));
    const results: string[] = [];
    for (const pid of [process.pid, process.ppid]) {
      try {
        acquireWorkWriterLock(root, pid);
        results.push("won");
      } catch {
        results.push("refused");
      }
    }
    expect(results).toEqual(["won", "refused"]);
    expect(JSON.parse(readFileSync(p.workServerLock, "utf8")).pid).toBe(process.pid);
    expect(readdirSync(p.runDir).sort()).toEqual(["work-server.lock"]);
  });
});

describe("install safety", () => {
  it("re-checks for a live writer (lock pid too) right before the install; nothing is moved", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev, denName: "w" });
    const before = readFileSync(join(dev, "ledger/work-events.jsonl"), "utf8");
    const lockPath = sandboxPaths(dev).workServerLock;
    // a writer that only has the LOCK (no run file yet) appears after the first check passed
    expect(() => takeSnapshot({ source, devRoot: dev, denName: "w", force: true, hooks: { beforeInstall: () => put(lockPath, JSON.stringify({ pid: process.ppid })) } })).toThrow(/started during the snapshot/);
    expect(readFileSync(join(dev, "ledger/work-events.jsonl"), "utf8")).toBe(before);
    expect(existsSync(join(dev, INSTALL_MARKER))).toBe(false);
    expect(readdirSync(dev).some((n) => n.startsWith(".replaced-"))).toBe(false);
  });

  it("the first check also sees a lock-only writer", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev });
    put(sandboxPaths(dev).workServerLock, JSON.stringify({ pid: process.ppid }));
    expect(() => takeSnapshot({ source, devRoot: dev, force: true })).toThrow(/work server is running/);
  });

  it("a mid-install failure leaves an .install-in-progress marker, names the recovery, refuses new snapshots until --recover", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev, denName: "w" });
    let err = "";
    try {
      takeSnapshot({ source, devRoot: dev, denName: "w", force: true, now: () => new Date("2026-10-27T00:00:00Z"), hooks: { afterStep: (rel) => { if (rel === "base") throw new Error("disk went away"); } } });
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).toMatch(/install failed midway \(disk went away\)/);
    expect(err).toMatch(/\.replaced-2026-10-27T00-00-00-000Z/);
    expect(err).toMatch(/mv '.*\.replaced-.*ledger' '.*\/ledger'/);
    expect(err).toMatch(/Nothing was deleted/);
    const marker = JSON.parse(readFileSync(join(dev, INSTALL_MARKER), "utf8"));
    expect(marker.plan.map((x: { rel: string }) => x.rel)).toContain("ledger");
    // the old ledger is safe in .replaced-*
    expect(readFileSync(join(dev, ".replaced-2026-10-27T00-00-00-000Z/ledger/work-events.jsonl"), "utf8")).toContain('"id":"a"');
    // new snapshots are refused while the marker exists ...
    expect(() => takeSnapshot({ source, devRoot: dev, denName: "w", force: true })).toThrow(/did not finish/);
    expect(() => takeSnapshot({ source, devRoot: dev, workOnly: true })).toThrow(/did not finish/);
    // ... unless --recover
    expect(() => takeSnapshot({ source, devRoot: dev, denName: "w", force: true, recover: true })).not.toThrow();
    expect(existsSync(join(dev, INSTALL_MARKER))).toBe(false);
  });

  it("workOnly moves snapshot.json aside instead of overwriting it", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev, denName: "w", now: () => new Date("2026-10-26T00:00:00Z") });
    takeSnapshot({ source: { ...source, kbBaseDir: undefined }, devRoot: dev, workOnly: true, now: () => new Date("2026-10-26T05:00:00Z") });
    const aside = readdirSync(dev).find((n) => n.startsWith(".replaced-"))!;
    expect(JSON.parse(readFileSync(join(dev, aside, "snapshot.json"), "utf8")).createdAt).toBe("2026-10-26T00:00:00.000Z");
    expect(JSON.parse(readFileSync(join(dev, "snapshot.json"), "utf8")).createdAt).toBe("2026-10-26T05:00:00.000Z");
  });
});

describe("remote path safety", () => {
  it("validates host and path; rejects leading '-' and odd characters", () => {
    expect(() => assertSafeRemoteSpec("root@100.1.2.3:/var/wolfpack/kb/work")).not.toThrow();
    for (const bad of ["-oProxyCommand=x:/a", "root@-h:/a", "root@h:/a b", "root@h:/a;rm", "root@h:/a/../b", "root@h:/$(x)", "root@h:/a'b", "h@@x:/a"]) {
      expect(() => assertSafeRemoteSpec(bad), bad).toThrow(/unsafe/);
    }
    expect(() => rsyncArgv("-evil:/a", "/d", [], "/k")).toThrow(/unsafe/);
    expect(() => remoteSha256Argv("root@h:/a b", "/k")).toThrow(/unsafe/);
    expect(() => takeSnapshot({ source: { workDir: "-evil:/x", denDir: "/nonexistent" }, devRoot: join(tmp("d"), "b") })).toThrow(/unsafe/);
  });

  it("the argv check is an ALLOW-list: unknown short/long flags are refused, the built argvs pass", () => {
    const ok = rsyncArgv("root@h:/p", "/d", [...RSYNC_RULES.ledger, ...RSYNC_RULES.denState], "/k", { dryRun: true });
    expect(() => assertReadOnlyRsyncArgv(ok)).not.toThrow();
    for (const flag of ["-z", "--inplace", "--partial", "--chmod=777", "-aP", "-e2", "--out-format=x", "--include", "--link-dest=/x", "--compare-dest=/y"]) {
      expect(() => assertReadOnlyRsyncArgv([...ok.slice(0, -3), flag, ...ok.slice(-3)]), flag).toThrow(/refusing rsync flag/);
    }
    expect(() => assertReadOnlyRsyncArgv(["-a", "-e", "sh -c evil", "--", "root@h:/p/", "/d/"])).toThrow(/ssh/);
  });
});

describe("--print-plan is what takeSnapshot runs", () => {
  it("every rsync/ssh argv the snapshot executes, in order, equals the plan byte-for-byte", () => {
    const { source } = fixture();
    const mirror = tmp("mirror");
    put(join(mirror, "domains/wolfpack/work/work-wolfpack-a.md"), "# a\n");
    const LEDGER = '{"type":"work.created","id":"work-wolfpack-a"}\n';
    const ran: { cmd: string; argv: string[] }[] = [];
    const runner: Runner = {
      rsync(argv) {
        ran.push({ cmd: "rsync", argv });
        put(join(argv[argv.length - 1], "ledger/work-events.jsonl"), LEDGER);
        return { status: 0, stdout: "", stderr: "" };
      },
      ssh(argv) {
        ran.push({ cmd: "ssh", argv });
        return { status: 0, stdout: `${sha(LEDGER)}  /x\n`, stderr: "" };
      },
    };
    const src: SnapshotSource = { ...source, workDir: "root@100.1.2.3:/var/wolfpack/kb/work/", workBaseDir: mirror };
    takeSnapshot({ source: src, devRoot: join(tmp("dev"), "box"), runner, sshIdentity: "/k/my key", requireWorkItems: true });
    const stage = ran.find((r) => r.cmd === "rsync")!.argv.at(-1)!.replace(/\/$/, "");
    const plan = remotePlan(src, "/k/my key", stage);
    expect(plan.map((p) => p.command)).toEqual(ran.map((r) => formatCommand(r.cmd, r.argv)));
    // and the default placeholder dest is shown quoted, with no doubled slash
    const shown = remotePlan(src, "/k/my key")[1].command;
    expect(shown).toMatch(/'<dev-root>\/\.staging-<timestamp>\/'$/);
    expect(shown).toContain("root@100.1.2.3:/var/wolfpack/kb/work/ ");
    expect(shown).not.toContain("//");
  });
});

describe("librarian gate walks the KB copy for symlinks", () => {
  it("refuses a kb-base containing a symlink", () => {
    const { source } = fixture();
    const dev = join(tmp("dev"), "box");
    takeSnapshot({ source, devRoot: dev });
    const r = resolveSandbox(dev);
    const good = { kbBase: r.kbBase, kbOps: r.kbOps, denLocal: r.kbDenLocal, extra: {} };
    expect(() => assertLibrarianSandboxed(dev, good)).not.toThrow();
    symlinkSync(tmp("elsewhere"), join(dev, "kb-base/domains/wolfpack/entries/escape"));
    expect(() => assertLibrarianSandboxed(dev, good)).toThrow(/contains a symlink/);
  });
});
