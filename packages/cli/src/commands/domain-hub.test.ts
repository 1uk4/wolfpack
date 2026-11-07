import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real config and registry under a temp HOME (os.homedir() is read at import time, so set it before the imports).
const h = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "dom-"));
  process.env.HOME = root;
  process.env.WOLFPACK_REGISTRY_DIR = join(root, ".wolfpack");
  return { root };
});

import { domainCmd } from "./domain.js";
import { kbBaseDir, loadConfig } from "../config.js";
import { loadRegistry, saveRegistry } from "../domains.js";
import { commitWorkItem } from "@wolfpack/kb/client";

const hubEnv = () => { vi.stubEnv("WOLFPACK_HUB_URL", "http://hub.test:9"); vi.stubEnv("WOLFPACK_HUB_TOKEN", "tok"); };
const respond = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("domain add/rm with a hub configured", () => {
  beforeEach(() => saveRegistry({ domains: {} }));
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const olddom = () => saveRegistry({ domains: { olddom: { label: "o", description: "", created: "2026-01-01" } } });

  it("add registers on the hub, saves only the CLI registry, creates no local folders", async () => {
    hubEnv();
    const f = respond(201); vi.stubGlobal("fetch", f);
    await domainCmd(["add", "newdom"], { yes: true } as any);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("http://hub.test:9/v1/registry/domains");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body).name).toBe("newdom");
    expect(Object.keys(loadRegistry().domains)).toEqual(["newdom"]);
    expect(existsSync(join(kbBaseDir(loadConfig()), "domains"))).toBe(false);
    expect(existsSync(join(kbBaseDir(loadConfig()), "domains.yaml"))).toBe(false);
  });

  it("add: a hub 409 means already registered and continues", async () => {
    hubEnv(); vi.stubGlobal("fetch", respond(409, { error: "domain newdom exists" }));
    await domainCmd(["add", "newdom"], { yes: true } as any);
    expect(Object.keys(loadRegistry().domains)).toEqual(["newdom"]);
  });

  it("add: a hub failure leaves no local registry change and no folders", async () => {
    hubEnv(); vi.stubGlobal("fetch", respond(500, { error: "down" }));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as any);
    await expect(domainCmd(["add", "newdom"], { yes: true } as any)).rejects.toThrow("exit");
    exit.mockRestore();
    expect(loadRegistry().domains).toEqual({});
    expect(existsSync(join(kbBaseDir(loadConfig()), "domains"))).toBe(false);
  });

  it("rm in hub mode DELETEs on the hub and never writes domains.yaml under KB_BASE", async () => {
    hubEnv(); olddom();
    const f = respond(200); vi.stubGlobal("fetch", f);
    await domainCmd(["rm", "olddom"], { yes: true } as any);
    expect((f.mock.calls[0] as any)[0]).toBe("http://hub.test:9/v1/registry/domains/olddom");
    expect((f.mock.calls[0] as any)[1].method).toBe("DELETE");
    expect(loadRegistry().domains).toEqual({});
    expect(existsSync(join(kbBaseDir(loadConfig()), "domains.yaml"))).toBe(false);
  });

  it("rm in hub mode treats a hub 404 as success", async () => {
    hubEnv(); olddom();
    vi.stubGlobal("fetch", respond(404, { code: "not_found", message: "domain olddom not found" }));
    await domainCmd(["rm", "olddom"], { yes: true } as any);
    expect(loadRegistry().domains).toEqual({});
  });
});

describe("commitWorkItem under the hub mirror", () => {
  it("throws and writes nothing", () => {
    const cfg = mkdtempSync(join(tmpdir(), "mir-"));
    vi.stubEnv("WORKERD_CONFIG_DIR", cfg);
    const kbBase = join(cfg, "kb-mirror");
    expect(() => commitWorkItem({ kbBase, opsRoot: kbBase, denLocal: kbBase }, { id: "work-d-1", domain: "d", kind: "task", title: "t", log: [] } as any, "b")).toThrow(/hub KB mirror/);
    expect(existsSync(join(kbBase, "domains"))).toBe(false);
    vi.unstubAllEnvs(); rmSync(cfg, { recursive: true, force: true });
  });
});
