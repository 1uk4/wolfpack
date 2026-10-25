import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupSessionStore, findBackup } from "./backup.js";

let dir: string;
let store: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wolf-backup-"));
  store = join(dir, "session.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fixed = (iso: string) => () => new Date(iso);

describe("backupSessionStore", () => {
  it("does nothing when the store does not exist", () => {
    expect(backupSessionStore(store, { engineVersion: "1.4.0" })).toBeUndefined();
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });

  it("copies the db and its wal/shm sidecars into a timestamped sibling dir", () => {
    writeFileSync(store, "db");
    writeFileSync(store + "-wal", "wal");
    const r = backupSessionStore(store, { engineVersion: "1.4.0", now: fixed("2026-10-25T01:02:03.456Z") })!;
    expect(r.dir).toBe(join(dir, "backups", "session.sqlite-engine-1.4.0-2026-10-25T01-02-03-456Z"));
    expect(r.files.sort()).toEqual(["session.sqlite", "session.sqlite-wal"]);
    expect(readFileSync(join(r.dir, "session.sqlite"), "utf8")).toBe("db");
    expect(readFileSync(join(r.dir, "session.sqlite-wal"), "utf8")).toBe("wal");
    expect(readFileSync(store, "utf8")).toBe("db"); // original untouched
  });

  it("is a no-op once a backup exists for the same engine version", () => {
    writeFileSync(store, "v1");
    expect(backupSessionStore(store, { engineVersion: "1.4.0" })).toBeDefined();
    writeFileSync(store, "v2");
    expect(backupSessionStore(store, { engineVersion: "1.4.0" })).toBeUndefined();
    expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
    expect(findBackup(store, "1.4.0")).toBeDefined();
  });

  it("takes a fresh backup after an engine version bump, preserving the old one", () => {
    writeFileSync(store, "pre-bump");
    backupSessionStore(store, { engineVersion: "1.4.0", now: fixed("2026-10-25T00:00:00.000Z") });
    writeFileSync(store, "post-1.4.0");
    const r = backupSessionStore(store, { engineVersion: "1.5.0", now: fixed("2026-11-01T00:00:00.000Z") })!;
    expect(readFileSync(join(r.dir, "session.sqlite"), "utf8")).toBe("post-1.4.0");
    expect(readdirSync(join(dir, "backups"))).toHaveLength(2);
  });
});
