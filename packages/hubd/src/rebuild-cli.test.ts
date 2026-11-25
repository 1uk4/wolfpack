import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRebuildArgs, runRebuildCli } from "./rebuild-cli.js";

describe("hubd rebuild host", () => {
  let dir: string;
  let urls: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rebuild-cli-"));
    urls = [];
    vi.stubGlobal("fetch", async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ plans: [], jobs: [], backups: [] }), { status: 200 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = async (rest: string[], env: Record<string, string>) => {
    await runRebuildCli(parseRebuildArgs(["list", "--data-dir", dir, ...rest], env), () => {});
    return urls[0];
  };

  it("sends requests to the --host and --port given", async () => {
    expect(await run(["--host", "100.64.0.7", "--port", "3150"], {})).toBe("http://100.64.0.7:3150/v1/admin/kb/rebuild/plans");
  });

  it("takes HUBD_HOST from the environment when no --host is given", async () => {
    expect(await run(["--port", "3150"], { HUBD_HOST: "10.0.0.5" })).toBe("http://10.0.0.5:3150/v1/admin/kb/rebuild/plans");
  });

  it("falls back to 127.0.0.1 with neither", async () => {
    expect(await run(["--port", "3150"], {})).toBe("http://127.0.0.1:3150/v1/admin/kb/rebuild/plans");
  });

  it("brackets an IPv6 host", async () => {
    expect(await run(["--host", "fd7a:115c::1", "--port", "3150"], {})).toBe("http://[fd7a:115c::1]:3150/v1/admin/kb/rebuild/plans");
  });

  it("lets --host win over HUBD_HOST, and keeps a hostname as is", async () => {
    expect(await run(["--host", "sfo-01.tail.ts.net", "--port", "3150"], { HUBD_HOST: "10.0.0.5" })).toBe("http://sfo-01.tail.ts.net:3150/v1/admin/kb/rebuild/plans");
  });
});
