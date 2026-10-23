import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { smokeCheckBundle, watchAfterRestart, type WolfWatchClient } from "./sync-safety.js";

describe("smokeCheckBundle (a): a bundle that crashes at load is caught before upload", () => {
  let dir: string;
  const write = (name: string, src: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, src);
    return f;
  };
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-")); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("passes a bundle that loads and says ok", async () => {
    const f = write("good.cjs", 'console.log("[harness] Loading modules...");\nif (process.argv.includes("--smoke")) { console.log("ok"); process.exit(0); }\nsetInterval(() => {}, 1000);');
    expect(await smokeCheckBundle(f)).toMatchObject({ ok: true });
  });

  it("fails a bundle with a top-level throw, with its error in the output", async () => {
    const f = write("broken.cjs", 'console.log("loading");\nthrow new TypeError("boom at load");');
    const r = await smokeCheckBundle(f);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("boom at load");
  });

  it("fails a bundle that exits 0 without saying ok, and one that hangs (timeout)", async () => {
    expect((await smokeCheckBundle(write("silent.cjs", "process.exit(0);"))).ok).toBe(false);
    const r = await smokeCheckBundle(write("hang.cjs", "setInterval(() => {}, 1000);"), { timeoutMs: 400 });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("timed out");
  });

  it("the child gets no wolf secrets", async () => {
    process.env.WOLF_SECRET_TEST = "leak";
    const f = write("env.cjs", 'if (process.env.WOLF_SECRET_TEST) throw new Error("leaked"); console.log("ok");');
    try { expect((await smokeCheckBundle(f)).ok).toBe(true); } finally { delete process.env.WOLF_SECRET_TEST; }
  });

  it("the real harness bundle loads in smoke mode", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const out = path.join(dir, "harness.cjs");
    await esbuild.build({
      entryPoints: [path.join(repoRoot, "packages/harness/src/bin/harness.ts")],
      outfile: out, bundle: true, platform: "node", format: "cjs", target: "node20",
      external: ["@anthropic-ai/claude-agent-sdk", "grammy"], logLevel: "silent",
    });
    const r = await smokeCheckBundle(out);
    expect(r.output).toContain("ok");
    expect(r.ok).toBe(true);
  }, 60_000);
});

describe("watchAfterRestart (b): a crash-looping wolf is rolled back", () => {
  /** A fake clock: sleep advances it; statuses are served one per poll, the last repeating. */
  function harness(statuses: Array<Record<string, unknown> | Error>, rollback: () => Promise<unknown> = async () => ({ success: true })) {
    let t = 0;
    let i = 0;
    const client: WolfWatchClient = {
      wolfStatus: vi.fn(async () => {
        const s = statuses[Math.min(i++, statuses.length - 1)];
        if (s instanceof Error) throw s;
        return s;
      }),
      rollbackWolf: vi.fn(rollback),
    };
    return { client, opts: { sleep: async (ms: number) => { t += ms; }, now: () => t } };
  }

  it("a wolf that stays active is healthy: no rollback", async () => {
    const h = harness([{ serviceState: "active", restarts: 0 }]);
    expect(await watchAfterRestart(h.client, "w", { ...h.opts, baseline: 0 })).toEqual({ ok: true });
    expect(h.client.rollbackWolf).not.toHaveBeenCalled();
  });

  it("restarts climbing past the baseline roll back at once", async () => {
    const h = harness([{ serviceState: "active", restarts: 3 }, { serviceState: "activating", restarts: 4 }]);
    const v = await watchAfterRestart(h.client, "w", { ...h.opts, baseline: 3 });
    expect(v).toMatchObject({ ok: false, rolledBack: true });
    expect((v as { reason: string }).reason).toContain("crash-looping: restarts 3 → 4");
    expect(h.client.rollbackWolf).toHaveBeenCalledWith("w");
  });

  it("a failed service rolls back", async () => {
    const h = harness([{ serviceState: "failed" }]);
    expect(await watchAfterRestart(h.client, "w", h.opts)).toMatchObject({ ok: false, rolledBack: true });
  });

  it("never active within 30s (auto-restart, no counter reported) rolls back", async () => {
    const h = harness([{ serviceState: "activating" }]);
    const v = await watchAfterRestart(h.client, "w", h.opts);
    expect(v).toMatchObject({ ok: false, rolledBack: true });
    expect((v as { reason: string }).reason).toContain("not active 30s after the restart (activating)");
  });

  it("active, dropping out, then active again for the stable time is healthy", async () => {
    const h = harness([{ serviceState: "active" }, { serviceState: "activating" }, { serviceState: "active" }]);
    expect(await watchAfterRestart(h.client, "w", h.opts)).toEqual({ ok: true });
  });

  it("a status endpoint that errors for the whole window rolls back; one blip does not", async () => {
    const down = harness([new Error("ECONNREFUSED")]);
    expect(await watchAfterRestart(down.client, "w", down.opts)).toMatchObject({ ok: false });
    const blip = harness([new Error("ECONNRESET"), { serviceState: "active", restarts: 0 }]);
    expect(await watchAfterRestart(blip.client, "w", { ...blip.opts, baseline: 0 })).toEqual({ ok: true });
  });

  it("reports when the rollback itself is impossible (an agent without the endpoint)", async () => {
    const h = harness([{ serviceState: "failed" }], async () => { throw new Error("404 Not Found"); });
    expect(await watchAfterRestart(h.client, "w", h.opts)).toEqual({
      ok: false, reason: "the service failed", rolledBack: false, rollbackError: "404 Not Found",
    });
  });
});
