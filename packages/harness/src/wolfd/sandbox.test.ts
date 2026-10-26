/** startSandbox in a shared dev root: the one work server (own / attach / refuse a second writer), librarian on a KB copy. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxPaths, takeSnapshot, type SnapshotSource } from "@wolfpack/engine";
import { startSandbox, startSharedWorkServer, type StartWorkServer } from "./sandbox.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `hsbx-${p}-`));
  dirs.push(d);
  return d;
};
const put = (f: string, t: string) => {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, t);
};
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c().catch(() => {});
});

function snapshot(opts: { kb?: boolean } = {}): string {
  const src = tmp("src");
  put(join(src, "work/ledger/work-events.jsonl"), "");
  put(join(src, "den/memory/t.md"), "t\n");
  put(join(src, "kb/domains.yaml"), "domains: [wolfpack]\n");
  const source: SnapshotSource = { workDir: join(src, "work"), denDir: join(src, "den"), ...(opts.kb ? { kbBaseDir: join(src, "kb") } : {}) };
  const dev = join(tmp("dev"), "box");
  takeSnapshot({ source, devRoot: dev, denName: "1uk4-dev" });
  mkdirSync(join(dev, "dens/dewey-dev"), { recursive: true });
  return dev;
}

/** counts starts; each "server" is a stub that answers nothing (these tests never call it) */
function countingStarter(): { start: StartWorkServer; started: number[] } {
  const started: number[] = [];
  return {
    started,
    start: async () => {
      started.push(1);
      return { url: `http://127.0.0.1:${40000 + started.length}`, close: async () => {} };
    },
  };
}

describe("startSandbox: one writer, many wolves", () => {
  it("each wolf gets its own den and the shared KB copy as KB_BASE", async () => {
    const dev = snapshot({ kb: true });
    const { start } = countingStarter();
    const a = await startSandbox(dev, { startWorkServer: start, wolf: "dewey-dev" });
    closers.push(() => a.close());
    expect(a.env.WOLF_DEN).toBe(join(dev, "dens/dewey-dev"));
    expect(a.env.KB_BASE).toBe(join(dev, "kb-base"));
    expect(a.env.KB_OPS).toBe(join(dev, "ops"));
    expect(a.env.KB_DEN_LOCAL).toBe(join(dev, "dens/dewey-dev/kb"));
  });

  it("the first starter owns the server and publishes it; closing releases the lock and the run file", async () => {
    const dev = snapshot();
    const c = countingStarter();
    const a = await startSandbox(dev, { startWorkServer: c.start, wolf: "1uk4-dev" });
    expect(c.started).toHaveLength(1);
    expect(existsSync(sandboxPaths(dev).workServerLock)).toBe(true);
    expect(JSON.parse(readFileSync(sandboxPaths(dev).workServerFile, "utf8")).url).toBe(a.resolved.workEndpoint);
    await a.close();
    expect(existsSync(sandboxPaths(dev).workServerLock)).toBe(false);
    expect(existsSync(sandboxPaths(dev).workServerFile)).toBe(false);
  });

  it("a wolf attaches to the shared server workerd owns (no second server), and does not close it", async () => {
    const dev = snapshot();
    const shared = await startSharedWorkServer(dev); // real local work server, as workerd does
    closers.push(() => shared.close());
    const c = countingStarter();
    const wolf = await startSandbox(dev, { startWorkServer: c.start, wolf: "1uk4-dev" });
    expect(c.started).toHaveLength(0);
    expect(wolf.resolved.workEndpoint).toBe(shared.url);
    expect(wolf.env.WORK_ENDPOINT).toBe(shared.url);
    expect(wolf.env.WORK_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    await wolf.close();
    expect((await fetch(`${shared.url}/ping`)).ok).toBe(true); // still up
  });

  it("a second owner is refused loudly", async () => {
    const dev = snapshot();
    const shared = await startSharedWorkServer(dev);
    closers.push(() => shared.close());
    await expect(startSharedWorkServer(dev)).rejects.toThrow(/already has a (running work server|writer)/);
  });

  it("a live writer that cannot be attached to is never raced: the wolf fails instead of starting a second server", async () => {
    const dev = snapshot();
    const p = sandboxPaths(dev);
    put(p.workServerLock, JSON.stringify({ pid: process.ppid })); // another live process holds the ledger, no run file
    const c = countingStarter();
    await expect(startSandbox(dev, { startWorkServer: c.start, wolf: "1uk4-dev" })).rejects.toThrow(/already has a writer/);
    expect(c.started).toHaveLength(0);
  });

  it("a stale lock (dead owner) is taken over", async () => {
    const dev = snapshot();
    const p = sandboxPaths(dev);
    put(p.workServerLock, JSON.stringify({ pid: 2 ** 22 + 777 }));
    put(p.workServerFile, JSON.stringify({ pid: 2 ** 22 + 777, url: "http://127.0.0.1:9", token: "x" }));
    const c = countingStarter();
    const a = await startSandbox(dev, { startWorkServer: c.start, wolf: "1uk4-dev" });
    closers.push(() => a.close());
    expect(c.started).toHaveLength(1);
  });
});

describe("startSandbox: librarian only on a KB copy", () => {
  it("is refused when the snapshot has no kb-base, before any server starts", async () => {
    const dev = snapshot();
    const c = countingStarter();
    await expect(startSandbox(dev, { startWorkServer: c.start, wolf: "dewey-dev", librarian: true })).rejects.toThrow(/librarian.*KB copy/);
    expect(c.started).toHaveLength(0);
    expect(existsSync(sandboxPaths(dev).workServerLock)).toBe(false);
  });

  it("is allowed with a kb-base copy: KB_BASE, KB_OPS and the den-local state are all inside the root", async () => {
    const dev = snapshot({ kb: true });
    const a = await startSandbox(dev, { startWorkServer: countingStarter().start, wolf: "dewey-dev", librarian: true });
    closers.push(() => a.close());
    for (const k of ["KB_BASE", "KB_OPS", "KB_DEN_LOCAL", "WOLF_DEN"]) expect(a.env[k].startsWith(dev)).toBe(true);
  });
});

describe("startSandbox: publish failure", () => {
  it("closes the started work server BEFORE releasing the lock, and leaves no lock behind", async () => {
    const dev = snapshot();
    const events: string[] = [];
    const start: StartWorkServer = async (o) => {
      // publish() writes <root>/run/work-server.json: make that path a directory so it throws
      mkdirSync(sandboxPaths(dev).workServerFile, { recursive: true });
      events.push(`started(lock held: ${existsSync(sandboxPaths(dev).workServerLock)})`);
      return {
        url: "http://127.0.0.1:45999",
        close: async () => {
          events.push(`closed(lock still held: ${existsSync(sandboxPaths(dev).workServerLock)})`);
        },
      };
    };
    await expect(startSandbox(dev, { startWorkServer: start, wolf: "1uk4-dev" })).rejects.toThrow();
    expect(events).toEqual(["started(lock held: true)", "closed(lock still held: true)"]);
    expect(existsSync(sandboxPaths(dev).workServerLock)).toBe(false);
  });
});
