import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkUpdates, compareVersions, createManifestFetcher } from "./updates.js";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

/** A local manifest server; `hits` counts the requests it got (the network boundary, not our code). */
async function serve(handler: (n: number, res: import("node:http").ServerResponse) => void): Promise<{ url: string; hits: () => number }> {
  let n = 0;
  const s = createServer((_req, res) => handler(++n, res));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/stable.json`, hits: () => n };
}
const body = (version: string) => JSON.stringify({ schema: 1, generatedAt: "2026-11-09T00:00:00Z", components: { console: { version, tag: `console/v${version}`, sha: "x", publishedAt: "2026-11-09T00:00:00Z", notesUrl: `https://n/${version}` } } });

describe("compareVersions", () => {
  it("orders release versions numerically, not as strings", () => {
    expect(compareVersions("0.1.9", "0.1.14")).toBe(-1);
    expect(compareVersions("0.1.14", "0.1.14")).toBe(0);
    expect(compareVersions("1.0.0", "0.9.99")).toBe(1);
  });

  it("ignores build metadata (a release bundle's VERSION is X.Y.Z+<sha>) and a leading v", () => {
    expect(compareVersions("0.1.18+bfb4b5c", "0.1.18")).toBe(0);
    expect(compareVersions("v0.1.18", "0.1.19")).toBe(-1);
  });

  it("ranks a prerelease below its release and orders prerelease identifiers by semver rules", () => {
    expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0-rc.2", "0.2.0-rc.10")).toBe(-1);
    expect(compareVersions("0.2.0-rc.1", "0.2.0-1")).toBe(1); // alphanumeric outranks numeric
    expect(compareVersions("0.2.0-alpha", "0.2.0-alpha.1")).toBe(-1);
    expect(compareVersions("0.2.0-rc.1", "0.1.18")).toBe(1);
  });

  it("returns null when either side is not a version", () => {
    expect(compareVersions("unknown", "0.1.18")).toBeNull();
    expect(compareVersions("bfb4b5c", "0.1.18")).toBeNull();
    expect(compareVersions("0.1", "0.1.18")).toBeNull();
    expect(compareVersions("0.1.18", "")).toBeNull();
    expect(compareVersions("01.1.1", "1.1.1")).toBeNull();
  });
});

describe("checkUpdates", () => {
  const manifest = {
    schema: 1,
    generatedAt: "2026-11-09T00:00:00.000Z",
    components: {
      console: { version: "0.1.18", tag: "console/v0.1.18", sha: "bfb4b5c3", publishedAt: "2026-11-09T00:00:00Z", notesUrl: "https://github.com/1uk4/wolfpack/releases/tag/console/v0.1.18" },
      hubd: { version: "0.1.14", tag: "hubd/v0.1.14", sha: "bfb4b5c3", publishedAt: "2026-11-09T00:00:00Z", notesUrl: "https://github.com/1uk4/wolfpack/releases/tag/hubd/v0.1.14" },
      wolfd: { version: "0.1.14", tag: "wolfd/v0.1.14", sha: "bfb4b5c3", publishedAt: "2026-11-09T00:00:00Z", notesUrl: "https://github.com/1uk4/wolfpack/releases/tag/wolfd/v0.1.14" },
    },
  };

  it("marks an older running version outdated, a newer one not, and an unreadable, unknown or unpublished one null", () => {
    const rows = checkUpdates(manifest, { console: "0.1.17+abc1234", hubd: "0.1.15", workerd: "0.1.5", wolfd: "bfb4b5c", spare: undefined });
    // an unstamped build (<package.json>-dev, or -dev+<sha> from an untagged bundle) is unknown: it never prompts, however old it looks
    expect(checkUpdates(manifest, { console: "0.1.0-dev", hubd: "0.1.0-dev+90091017" }).map((r) => [r.component, r.outdated])).toEqual([
      ["console", null],
      ["hubd", null],
    ]);
    expect(rows).toEqual([
      { component: "console", running: "0.1.17+abc1234", latest: "0.1.18", outdated: true, notesUrl: "https://github.com/1uk4/wolfpack/releases/tag/console/v0.1.18" },
      { component: "hubd", running: "0.1.15", latest: "0.1.14", outdated: false, notesUrl: "https://github.com/1uk4/wolfpack/releases/tag/hubd/v0.1.14" },
      { component: "workerd", running: "0.1.5", latest: null, outdated: null, notesUrl: null },
      { component: "wolfd", running: "bfb4b5c", latest: "0.1.14", outdated: null, notesUrl: "https://github.com/1uk4/wolfpack/releases/tag/wolfd/v0.1.14" },
      { component: "spare", running: null, latest: null, outdated: null, notesUrl: null },
    ]);
  });
});

describe("createManifestFetcher", () => {
  it("reuses a fetched manifest within the TTL, shares one request between concurrent calls, and refetches after it", async () => {
    const srv = await serve((n, res) => res.end(body(n === 1 ? "0.1.18" : "0.1.19")));
    let t = 1_000;
    const get = createManifestFetcher({ url: srv.url, ttlMs: 60_000, now: () => t });
    const [a, b] = await Promise.all([get(), get()]);
    expect(a.manifest?.components.console?.version).toBe("0.1.18");
    expect(b.manifest?.components.console?.version).toBe("0.1.18");
    t += 59_000;
    expect((await get()).manifest?.components.console?.version).toBe("0.1.18");
    expect(srv.hits()).toBe(1);
    t += 2_000;
    expect((await get()).manifest?.components.console?.version).toBe("0.1.19");
    expect(srv.hits()).toBe(2);
  });

  it("gives up on a manifest host that never answers at the timeout and reports why", async () => {
    const srv = await serve(() => {}); // accepts, never responds
    const started = Date.now();
    const r = await createManifestFetcher({ url: srv.url, timeoutMs: 100 })();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r).toEqual({ manifest: null, error: "no answer within 100ms" });
  });

  it("keeps the last good manifest when a refetch fails, and retries a failure only after the retry delay", async () => {
    const srv = await serve((n, res) => {
      if (n === 1) return res.end(body("0.1.18"));
      if (n === 2) return res.writeHead(502).end("bad gateway");
      res.end(body("0.1.20"));
    });
    let t = 0;
    const get = createManifestFetcher({ url: srv.url, ttlMs: 1_000, retryMs: 5_000, now: () => t });
    await get();
    t = 2_000;
    const stale = await get();
    expect(stale.manifest?.components.console?.version).toBe("0.1.18");
    expect(stale.error).toBe("HTTP 502");
    t = 4_000;
    expect((await get()).error).toBe("HTTP 502"); // within retryMs: no new request
    expect(srv.hits()).toBe(2);
    t = 7_500;
    const fresh = await get();
    expect(fresh.manifest?.components.console?.version).toBe("0.1.20");
    expect(fresh.error).toBeUndefined();
  });

  it("rejects a body that is not a stable manifest", async () => {
    const srv = await serve((_n, res) => res.end(JSON.stringify({ hello: "world" })));
    expect(await createManifestFetcher({ url: srv.url })()).toEqual({ manifest: null, error: "not a stable manifest" });
  });
});
