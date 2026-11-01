import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kbBaseDir, kbWriteBaseDir, type CliConfig } from "./config.js";
import { resolveWolfKbBase } from "./commands/wolf-sync.js";

const cfg = (extra: Partial<CliConfig> = {}): CliConfig => ({ wolvesRoot: "/w", hosts: {}, ...extra });
const def = path.join("/w", "knowledge", "base");
// Hermetic: no hub kb-mirror under this dir, so the legacy fallback applies.
const NOENV: NodeJS.ProcessEnv = { WORKERD_CONFIG_DIR: "/nonexistent-wp-cfg" };

describe("kbBaseDir override", () => {
  it("falls back to the legacy knowledge/base when no hub mirror exists", () => expect(kbBaseDir(cfg(), NOENV)).toBe(def));
  it("config kbBase overrides", () => expect(kbBaseDir(cfg({ kbBase: "/hub/mirror" }), NOENV)).toBe("/hub/mirror"));
  it("WOLFPACK_KB_BASE beats config", () =>
    expect(kbBaseDir(cfg({ kbBase: "/hub/mirror" }), { WOLFPACK_KB_BASE: "/env/m" })).toBe("/env/m"));
});

describe("resolveWolfKbBase (wolf sync)", () => {
  it("fresh .env gets the default, no notice", () => {
    expect(resolveWolfKbBase(cfg(), [], false, NOENV)).toEqual({ value: def });
  });
  it("same value: no notice", () => {
    expect(resolveWolfKbBase(cfg(), [`KB_BASE=${def}`], false, NOENV)).toEqual({ value: def });
  });
  it("preserves a differing existing KB_BASE and prints a notice", () => {
    const r = resolveWolfKbBase(cfg(), ["KB_BASE=/hub/mirror"], false, NOENV);
    expect(r.value).toBe("/hub/mirror");
    expect(r.notice).toContain("kept");
  });
  it("--reset-kb-base rewrites from config", () => {
    const r = resolveWolfKbBase(cfg(), ["KB_BASE=/hub/mirror"], true, NOENV);
    expect(r.value).toBe(def);
    expect(r.notice).toContain("reset");
  });
  it("explicit override wins over the existing value", () => {
    const r = resolveWolfKbBase(cfg({ kbBase: "/new" }), ["KB_BASE=/old"], false, NOENV);
    expect(r.value).toBe("/new");
    expect(r.notice).toContain("changed");
  });
});

describe("kbWriteBaseDir", () => {
  it("ignores WOLFPACK_KB_BASE and config kbBase", () => {
    vi.stubEnv("WOLFPACK_KB_BASE", "/env/m");
    expect(kbWriteBaseDir(cfg({ kbBase: "/hub/mirror" }))).toBe(def);
    expect(kbBaseDir(cfg({ kbBase: "/hub/mirror" }))).toBe("/env/m");
    vi.unstubAllEnvs();
  });
});

describe("resolveWolfKbBase edge cases", () => {
  it("override equal to the existing value: no notice", () => {
    expect(resolveWolfKbBase(cfg({ kbBase: "/hub/mirror" }), ["KB_BASE=/hub/mirror"], false, NOENV)).toEqual({ value: "/hub/mirror" });
  });
  it("trims whitespace and strips quotes before comparing", () => {
    expect(resolveWolfKbBase(cfg(), [`KB_BASE="${def}"`], false, NOENV)).toEqual({ value: def });
    expect(resolveWolfKbBase(cfg(), [`KB_BASE=  '${def}'  `], false, NOENV)).toEqual({ value: def });
    expect(resolveWolfKbBase(cfg(), ['KB_BASE=" /hub/mirror "'], false, NOENV).value).toBe("/hub/mirror");
  });
});

describe("loadConfig", () => {
  it("round-trips kbBase", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-home-"));
    const spy = vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.resetModules();
    try {
      const m = await import("./config.js");
      m.saveConfig({ wolvesRoot: "/w", hosts: {}, kbBase: "/hub/mirror" });
      expect(m.loadConfig().kbBase).toBe("/hub/mirror");
    } finally {
      spy.mockRestore();
      vi.resetModules();
    }
  });
});

describe("kbBaseDir reader default order", () => {
  const cfg = { wolvesRoot: "/tmp/wp-legacy-root" } as never;
  it("KB_BASE wins, then the hub mirror when present, then the legacy path", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { kbBaseDir } = await import("./config.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-kbdef-"));
    const env = { WORKERD_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    expect(kbBaseDir(cfg, env)).toBe("/tmp/wp-legacy-root/knowledge/base");
    fs.mkdirSync(path.join(dir, "kb-mirror"));
    expect(kbBaseDir(cfg, env)).toBe(path.join(dir, "kb-mirror"));
    expect(kbBaseDir(cfg, { ...env, KB_BASE: "/explicit/base" })).toBe("/explicit/base");
  });
});
