import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kbBaseDir, kbWriteBaseDir, type CliConfig } from "./config.js";
import { resolveWolfKbBase } from "./commands/wolf-sync.js";

const cfg = (extra: Partial<CliConfig> = {}): CliConfig => ({ wolvesRoot: "/w", hosts: {}, ...extra });
const def = path.join("/w", "knowledge", "base");

describe("kbBaseDir override", () => {
  it("defaults to the Syncthing copy", () => expect(kbBaseDir(cfg(), {})).toBe(def));
  it("config kbBase overrides", () => expect(kbBaseDir(cfg({ kbBase: "/hub/mirror" }), {})).toBe("/hub/mirror"));
  it("WOLFPACK_KB_BASE beats config", () =>
    expect(kbBaseDir(cfg({ kbBase: "/hub/mirror" }), { WOLFPACK_KB_BASE: "/env/m" })).toBe("/env/m"));
});

describe("resolveWolfKbBase (wolf sync)", () => {
  it("fresh .env gets the default, no notice", () => {
    expect(resolveWolfKbBase(cfg(), [], false, {})).toEqual({ value: def });
  });
  it("same value: no notice", () => {
    expect(resolveWolfKbBase(cfg(), [`KB_BASE=${def}`], false, {})).toEqual({ value: def });
  });
  it("preserves a differing existing KB_BASE and prints a notice", () => {
    const r = resolveWolfKbBase(cfg(), ["KB_BASE=/hub/mirror"], false, {});
    expect(r.value).toBe("/hub/mirror");
    expect(r.notice).toContain("kept");
  });
  it("--reset-kb-base rewrites from config", () => {
    const r = resolveWolfKbBase(cfg(), ["KB_BASE=/hub/mirror"], true, {});
    expect(r.value).toBe(def);
    expect(r.notice).toContain("reset");
  });
  it("explicit override wins over the existing value", () => {
    const r = resolveWolfKbBase(cfg({ kbBase: "/new" }), ["KB_BASE=/old"], false, {});
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
    expect(resolveWolfKbBase(cfg({ kbBase: "/hub/mirror" }), ["KB_BASE=/hub/mirror"], false, {})).toEqual({ value: "/hub/mirror" });
  });
  it("trims whitespace and strips quotes before comparing", () => {
    expect(resolveWolfKbBase(cfg(), [`KB_BASE="${def}"`], false, {})).toEqual({ value: def });
    expect(resolveWolfKbBase(cfg(), [`KB_BASE=  '${def}'  `], false, {})).toEqual({ value: def });
    expect(resolveWolfKbBase(cfg(), ['KB_BASE=" /hub/mirror "'], false, {}).value).toBe("/hub/mirror");
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
