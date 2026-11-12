/**
 * Seam: runUpdate (electron/migrate.cjs) driven with real temp dirs and an injected trash that moves to a temp folder.
 * Catches: wrong backup contents, lost data on a failed or interrupted migration, version bookkeeping, backup permissions.
 * Misses: the Electron dialog and quit handling in main.cjs.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const { runUpdate } = createRequire(import.meta.url)("./migrate.cjs");

let root: string;
let stateDir: string;
let wolvesDir: string;
let backupDir: string;
let trashDir: string;
let trashed = 0;

const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
const read = (file: string) => readFileSync(file, "utf8");
const trash = async (p: string) => {
  mkdirSync(trashDir, { recursive: true });
  renameSync(p, join(trashDir, `${trashed++}-${p.split("/").pop()}`));
};
const versionOf = () => JSON.parse(read(join(stateDir, "app-version.json"))).version;
const seed = (version: string) => put(join(stateDir, "app-version.json"), JSON.stringify({ version }));
/** An in-progress.json as the app writes it for the live state folder. */
const marker = (from: string, to: string) => {
  const st = statSync(stateDir);
  return JSON.stringify({ from, to, startedAt: "2026-11-11T00:00:00Z", stateIno: st.ino, stateDev: st.dev });
};
const mode = (p: string) => statSync(p).mode & 0o777;
const run = (version: string, migrations: unknown[] = []) => runUpdate({ stateDir, wolvesDir, version, migrations, backupDir, trash });
/** path -> content for every file under dir. */
const snapshot = (dir: string, rel = ""): Record<string, string> =>
  Object.assign(
    {},
    ...readdirSync(join(dir, rel), { withFileTypes: true }).map((d) =>
      d.isDirectory() ? snapshot(dir, join(rel, d.name)) : { [join(rel, d.name)]: read(join(dir, rel, d.name)) },
    ),
  );

/** An installed pack: KB, setup, a wolf with den/agent/sessions/workspace. */
const populate = () => {
  put(join(stateDir, "hub", "kb", "entry.md"), "kb entry");
  put(join(stateDir, "setup.json"), '{"done":true}');
  put(join(stateDir, "logs", "hubd.log"), "log line");
  put(join(wolvesDir, "luna", "den", "memory", "topic.md"), "den topic");
  put(join(wolvesDir, "luna", "den", "session.sqlite"), "den conversations");
  put(join(wolvesDir, "luna", "den", "session.sqlite-wal"), "den wal");
  put(join(wolvesDir, "luna", "den", "logs", "den.log"), "den log");
  put(join(wolvesDir, "luna", "agent", "auth.json"), "agent file");
  put(join(wolvesDir, "luna", "session.sqlite"), "root conversations");
  put(join(wolvesDir, "luna", "workspace", "code.ts"), "workspace code");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "m72-migrate-"));
  stateDir = join(root, "Wolfpack");
  wolvesDir = join(root, "Wolves");
  backupDir = join(root, "Wolfpack Backup");
  trashDir = join(root, "Trash");
  trashed = 0;
});

describe("runUpdate", () => {
  it("records the version on a fresh install without a backup or migrations", async () => {
    let ran = false;
    const r = await run("0.3.7", [{ version: "0.3.7", name: "x", run: () => (ran = true) }]);
    expect(r.ok).toBe(true);
    expect(versionOf()).toBe("0.3.7");
    expect(existsSync(backupDir)).toBe(false);
    expect(ran).toBe(false);
  });

  it("backs up den, agent, KB and conversations without workspaces or logs, then runs the due migrations in order", async () => {
    populate();
    seed("0.3.6");
    const order: string[] = [];
    const r = await run("0.3.7", [
      { version: "0.3.8", name: "later", run: () => order.push("0.3.8") },
      { version: "0.3.7", name: "m", run: () => order.push("0.3.7") },
    ]);
    expect(r).toMatchObject({ ok: true, ran: ["0.3.7"] });
    expect(order).toEqual(["0.3.7"]);
    expect(versionOf()).toBe("0.3.7");
    const last = join(backupDir, "last");
    expect(read(join(last, "state", "hub", "kb", "entry.md"))).toBe("kb entry");
    expect(read(join(last, "state", "setup.json"))).toBe('{"done":true}');
    expect(read(join(last, "wolves", "luna", "den", "memory", "topic.md"))).toBe("den topic");
    expect(read(join(last, "wolves", "luna", "agent", "auth.json"))).toBe("agent file");
    expect(read(join(last, "wolves", "luna", "session.sqlite"))).toBe("root conversations");
    expect(read(join(last, "wolves", "luna", "den", "session.sqlite"))).toBe("den conversations");
    expect(read(join(last, "wolves", "luna", "den", "session.sqlite-wal"))).toBe("den wal");
    expect(existsSync(join(last, "wolves", "luna", "workspace"))).toBe(false);
    expect(existsSync(join(last, "wolves", "luna", "den", "logs"))).toBe(false);
    expect(existsSync(join(last, "state", "logs"))).toBe(false);
    expect(JSON.parse(read(join(last, "manifest.json")))).toMatchObject({ from: "0.3.6", to: "0.3.7" });
    expect(mode(backupDir)).toBe(0o700);
    expect(mode(last)).toBe(0o700);
    expect(existsSync(join(backupDir, "in-progress.json"))).toBe(false);
  });

  it("keeps only the last backup", async () => {
    populate();
    seed("0.3.6");
    await run("0.3.7");
    await run("0.3.9");
    expect(readdirSync(backupDir)).toEqual(["last"]);
    expect(JSON.parse(read(join(backupDir, "last", "manifest.json"))).from).toBe("0.3.7");
  });

  it("puts the data back when a migration fails, including conversations, and keeps the half-migrated copy aside", async () => {
    populate();
    seed("0.3.6");
    const r = await run("0.3.7", [
      {
        version: "0.3.7",
        name: "boom",
        run: ({ wolvesDir: w }: { wolvesDir: string }) => {
          writeFileSync(join(w, "luna", "den", "memory", "topic.md"), "half migrated");
          writeFileSync(join(w, "luna", "den", "session.sqlite"), "corrupted");
          writeFileSync(join(w, "luna", "den", "marker.txt"), "created by migration");
          writeFileSync(join(w, "luna", "workspace", "code.ts"), "edited in workspace");
          throw new Error("test migration failed on purpose");
        },
      },
    ]);
    expect(r).toMatchObject({ ok: false, restored: true });
    expect(r.error).toContain("on purpose");
    expect(read(join(wolvesDir, "luna", "den", "memory", "topic.md"))).toBe("den topic");
    expect(read(join(wolvesDir, "luna", "den", "session.sqlite"))).toBe("den conversations");
    expect(existsSync(join(wolvesDir, "luna", "den", "marker.txt"))).toBe(false);
    expect(read(join(r.failedDir, "wolves", "luna", "den", "marker.txt"))).toBe("created by migration");
    expect(read(join(wolvesDir, "luna", "den", "logs", "den.log"))).toBe("den log");
    expect(read(join(wolvesDir, "luna", "workspace", "code.ts"))).toBe("edited in workspace");
    expect(versionOf()).toBe("0.3.6");
    expect(existsSync(join(backupDir, "in-progress.json"))).toBe(false);
  });

  it("restores from the untouched backup after an interrupted update instead of backing up the half-migrated data", async () => {
    populate();
    seed("0.3.6");
    await run("0.3.7", [{ version: "0.3.7", name: "boom", run: () => { throw new Error("x"); } }]); // leaves a good last/ from 0.3.6
    const before = snapshot(join(backupDir, "last"));
    // The app died mid-migration: marker present, live data altered, version still old.
    put(join(backupDir, "in-progress.json"), marker("0.3.6", "0.3.7"));
    writeFileSync(join(wolvesDir, "luna", "den", "memory", "topic.md"), "half migrated");
    let ran = false;
    const r = await run("0.3.7", [{ version: "0.3.7", name: "m", run: () => (ran = true) }]);
    expect(r).toMatchObject({ ok: false, restored: true, error: "the last update was interrupted" });
    expect(ran).toBe(false);
    expect(read(join(wolvesDir, "luna", "den", "memory", "topic.md"))).toBe("den topic");
    expect(versionOf()).toBe("0.3.6");
    expect(snapshot(join(backupDir, "last"))).toEqual(before);
    expect(existsSync(join(backupDir, "in-progress.json"))).toBe(false);
  });

  it("refuses to restore a backup taken from a different version and leaves the data alone", async () => {
    populate();
    seed("0.3.6");
    await run("0.3.7", [{ version: "0.3.7", name: "boom", run: () => { throw new Error("x"); } }]);
    seed("0.3.5"); // data is at 0.3.5 but last/ was taken from 0.3.6
    put(join(backupDir, "in-progress.json"), marker("0.3.5", "0.3.7"));
    writeFileSync(join(wolvesDir, "luna", "den", "memory", "topic.md"), "live edit");
    const r = await run("0.3.7");
    expect(r).toMatchObject({ ok: false, restored: false });
    expect(r.error).toContain("refusing to restore");
    expect(read(join(wolvesDir, "luna", "den", "memory", "topic.md"))).toBe("live edit");
    expect(existsSync(join(backupDir, "in-progress.json"))).toBe(true);
  });

  it("treats existing data without a version file as 0.0.0: backs up and runs the migrations", async () => {
    populate(); // no app-version.json
    const ran: string[] = [];
    const r = await run("0.3.7", [{ version: "0.0.1", name: "legacy", run: () => ran.push("0.0.1") }]);
    expect(r).toMatchObject({ ok: true, ran: ["0.0.1"], backedUp: true });
    expect(ran).toEqual(["0.0.1"]);
    expect(read(join(backupDir, "last", "state", "hub", "kb", "entry.md"))).toBe("kb entry");
    expect(JSON.parse(read(join(backupDir, "last", "manifest.json"))).from).toBe("0.0.0");
    expect(versionOf()).toBe("0.3.7");
  });

  it("finishes a restore that crashed part way: version file still there, den partly missing", async () => {
    populate();
    seed("0.3.4");
    await run("0.3.5", [{ version: "0.3.5", name: "boom", run: () => { throw new Error("x"); } }]); // good last/ from 0.3.4
    rmSync(join(wolvesDir, "luna", "den", "memory"), { recursive: true });
    rmSync(join(stateDir, "hub"), { recursive: true });
    put(join(backupDir, "in-progress.json"), marker("0.3.4", "0.3.5"));
    const r = await run("0.3.5");
    expect(r).toMatchObject({ ok: false, restored: true, error: "the last update was interrupted" });
    expect(read(join(wolvesDir, "luna", "den", "memory", "topic.md"))).toBe("den topic");
    expect(read(join(stateDir, "hub", "kb", "entry.md"))).toBe("kb entry");
    expect(versionOf()).toBe("0.3.4");
    expect(existsSync(join(backupDir, "in-progress.json"))).toBe(false);
  });

  it("still honours an interrupted-update marker whose device number changed (reboot)", async () => {
    populate();
    seed("0.3.4");
    await run("0.3.5", [{ version: "0.3.5", name: "boom", run: () => { throw new Error("x"); } }]);
    writeFileSync(join(wolvesDir, "luna", "den", "memory", "topic.md"), "half migrated");
    const m = JSON.parse(marker("0.3.4", "0.3.5"));
    put(join(backupDir, "in-progress.json"), JSON.stringify({ ...m, stateDev: m.stateDev + 1 }));
    const r = await run("0.3.5");
    expect(r).toMatchObject({ ok: false, restored: true, error: "the last update was interrupted" });
    expect(read(join(wolvesDir, "luna", "den", "memory", "topic.md"))).toBe("den topic");
  });

  describe("after a Settings Reset (state folder gone, wolves still there, old backup present)", () => {
    let before: Record<string, string>;
    beforeEach(async () => {
      populate();
      seed("0.3.6");
      await run("0.3.7"); // leaves last/ from 0.3.6
      before = snapshot(join(backupDir, "last"));
      put(join(backupDir, "in-progress.json"), marker("0.3.7", "0.3.8")); // stale marker of the old state folder
      rmSync(stateDir, { recursive: true });
    });

    it("is a fresh install: version recorded, stale marker set aside, backup untouched, nothing runs", async () => {
      let ran = false;
      const r = await run("0.3.8", [{ version: "0.3.8", name: "x", run: () => (ran = true) }]);
      expect(r).toMatchObject({ ok: true, ran: [], backedUp: false });
      expect(ran).toBe(false);
      expect(versionOf()).toBe("0.3.8");
      expect(snapshot(join(backupDir, "last"))).toEqual(before);
      expect(existsSync(join(backupDir, "in-progress.json"))).toBe(false);
      expect(readdirSync(backupDir).filter((n: string) => n.startsWith("in-progress.stale-")).length).toBe(1);
    });

    it("does not restore the old backup on a later upgrade; it backs up and migrates normally", async () => {
      await run("0.3.7"); // fresh install at 0.3.7 on the new state folder
      put(join(stateDir, "setup.json"), '{"done":true}');
      const ran: string[] = [];
      const r = await run("0.3.9", [{ version: "0.3.9", name: "m", run: () => ran.push("0.3.9") }]);
      expect(r).toMatchObject({ ok: true, ran: ["0.3.9"], backedUp: true });
      expect(JSON.parse(read(join(backupDir, "last", "manifest.json")))).toMatchObject({ from: "0.3.7", to: "0.3.9" });
    });
  });

  it("sets a stale next/ aside when the Trash refuses it and still updates", async () => {
    populate();
    seed("0.3.6");
    put(join(backupDir, "next", "junk.txt"), "crashed earlier");
    const r = await runUpdate({ stateDir, wolvesDir, version: "0.3.7", migrations: [], backupDir, trash: async (p: string) => { if (p.endsWith("next")) throw new Error("no trash"); await trash(p); } });
    expect(r).toMatchObject({ ok: true, backedUp: true });
    expect(readdirSync(backupDir).filter((n: string) => n.startsWith("next-stale-")).length).toBe(1);
    expect(existsSync(join(backupDir, "next"))).toBe(false);
  });

  it("leaves Electron's own profile files out of the backup and the restore", async () => {
    populate();
    seed("0.3.6");
    put(join(stateDir, "Cookies"), "cookie jar");
    put(join(stateDir, "Local Storage", "leveldb", "000003.log"), "ls");
    put(join(stateDir, "SingletonLock"), "lock");
    const r = await run("0.3.7", [{ version: "0.3.7", name: "boom", run: () => { throw new Error("x"); } }]);
    expect(r).toMatchObject({ ok: false, restored: true });
    for (const n of ["Cookies", "Local Storage", "SingletonLock"]) expect(existsSync(join(backupDir, "last", "state", n))).toBe(false);
    expect(read(join(stateDir, "Cookies"))).toBe("cookie jar");
    expect(read(join(stateDir, "SingletonLock"))).toBe("lock");
  });

  it("reports a damaged version file without touching anything", async () => {
    populate();
    put(join(stateDir, "app-version.json"), "{not json");
    const r = await run("0.3.7");
    expect(r).toMatchObject({ ok: false, stage: "version", restored: false });
    expect(existsSync(backupDir)).toBe(false);
    expect(read(join(stateDir, "app-version.json"))).toBe("{not json");
  });

  it("runs nothing when the stored version is newer than the app", async () => {
    populate();
    seed("0.4.0");
    let ran = false;
    const r = await run("0.3.7", [{ version: "0.3.7", name: "x", run: () => (ran = true) }]);
    expect(r.ok).toBe(true);
    expect(ran).toBe(false);
    expect(versionOf()).toBe("0.4.0");
    expect(existsSync(backupDir)).toBe(false);
  });
});
