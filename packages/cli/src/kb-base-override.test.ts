import { describe, expect, it } from "vitest";
import path from "node:path";
import { kbBaseDir, type CliConfig } from "./config.js";
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
