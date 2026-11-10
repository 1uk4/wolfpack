import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withPoolLock } from "./pool-lock.js";

const den = () => mkdtempSync(join(tmpdir(), "poollock-"));
const lockFile = (d: string) => join(d, ".memory", "pool", "pool.lock");

describe("withPoolLock", () => {
  it("serializes concurrent read-modify-write sections so no line is lost", async () => {
    const d = den();
    const file = join(d, "counter.txt");
    writeFileSync(file, "");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withPoolLock(d, async () => {
          const before = readFileSync(file, "utf-8");
          await new Promise((r) => setTimeout(r, 2));
          writeFileSync(file, before + `{"n":${i}}\n{"m":${i}}\n`);
        }),
      ),
    );
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(40);
    expect(lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } })).toBe(true);
  });

  it("steals a lock older than the stale timeout", async () => {
    const d = den();
    mkdirSync(join(d, ".memory", "pool"), { recursive: true });
    writeFileSync(lockFile(d), "999999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(d), old, old);
    expect(await withPoolLock(d, async () => "ran", { staleMs: 30_000 })).toBe("ran");
  });

  it("waits on a fresh lock until it is released", async () => {
    const d = den();
    mkdirSync(join(d, ".memory", "pool"), { recursive: true });
    writeFileSync(lockFile(d), "999999");
    setTimeout(() => { try { unlinkSync(lockFile(d)); } catch { /* gone */ } }, 150);
    const t0 = Date.now();
    await withPoolLock(d, async () => {}, { staleMs: 30_000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });

  it("times out on a fresh lock that is never released", async () => {
    const d = den();
    mkdirSync(join(d, ".memory", "pool"), { recursive: true });
    writeFileSync(lockFile(d), "999999");
    await expect(withPoolLock(d, async () => {}, { staleMs: 30_000, timeoutMs: 100 })).rejects.toThrow(/pool lock/);
  });

  it("releases the lock when the section throws", async () => {
    const d = den();
    await expect(withPoolLock(d, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(lockFile(d))).toBe(false);
    expect(await withPoolLock(d, async () => 1)).toBe(1);
  });
});
