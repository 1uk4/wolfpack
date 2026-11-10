/** The curator loads the Claude Agent SDK early (after start, deferred) so the first sweep tick does not block the hub's event loop on it. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCurator, type Curator, type CuratorOptions } from "./curator.js";

const tmp: string[] = [];
const curators: Curator[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  vi.useRealTimers();
  while (curators.length) await curators.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

function make(options: CuratorOptions): Curator {
  const dir = mkdtempSync(join(tmpdir(), "curator-warm-"));
  tmp.push(dir);
  const roots = { opsRoot: dir, kbBase: join(dir, "kb"), kbRoot: join(dir, "kb") } as any;
  const inboxRoot = join(dir, "contributions");
  mkdirSync(inboxRoot, { recursive: true });
  const c = createCurator({
    dataDir: dir, roots, inboxRoot, receiptsRoot: join(dir, "receipts"),
    commit: async () => ({}) as any, exclusive: async (fn) => fn(), emit: () => {},
    options: { pollMs: 600_000, createEngine: undefined, ...options },
  });
  curators.push(c);
  return c;
}

describe("curator SDK warm-up", () => {
  it("calls the warm-up once, after the delay, when the curator starts", async () => {
    const warm = vi.fn(async () => {});
    make({ enabled: true, warmSdk: warm }).start();
    expect(warm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(warm).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("does not warm when the curator is disabled or closed before the delay", async () => {
    const off = vi.fn(async () => {});
    make({ enabled: false, warmSdk: off }).start();
    const on = vi.fn(async () => {});
    const c = make({ enabled: true, warmSdk: on });
    c.start();
    await c.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(off).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });

  it("logs a failed warm-up and keeps the curator running", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = make({ enabled: true, warmSdk: async () => { throw new Error("no sdk here"); } });
    c.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[curator] sdk warm-up failed: no sdk here"));
    expect(c.status().enabled).toBe(true);
    warn.mockRestore();
  });
});
