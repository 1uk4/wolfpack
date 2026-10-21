import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensions } from "./loader.js";

describe("loadExtensions from the den", () => {
  let den: string;
  beforeEach(() => { den = fs.mkdtempSync(path.join(os.tmpdir(), "loader-den-")); });
  afterEach(() => fs.rmSync(den, { recursive: true, force: true }));

  const base = () => ({ wolfDen: den, wolfName: "w", domains: [], runtime: "pi-durable" as const });

  function install(name: string, source: string) {
    fs.mkdirSync(path.join(den, "extensions", name), { recursive: true });
    fs.writeFileSync(path.join(den, "extensions", name, "index.js"), source);
  }

  it("loads <den>/extensions/<name>/index.js and collects lifecycle from the original", async () => {
    install("pinger", `module.exports = { default: (cfg) => ({ name: "pinger", lifecycle: { start() { return cfg; } } }) };`);
    const r = await loadExtensions(["pinger"], { ...base(), wolfConfig: { pinger: { every: 5 } } });
    expect(r.failed).toEqual([]);
    expect(r.extensions.map((e) => e.name)).toEqual(["pinger"]);
    expect(r.lifecycles).toHaveLength(1);
    expect(r.lifecycles[0]!.name).toBe("pinger");
    expect(r.lifecycles[0]!.config).toEqual({ every: 5 });
  });

  it("an extension without lifecycle contributes none; a missing one is reported", async () => {
    install("plain", `module.exports = { default: { name: "plain" } };`);
    const r = await loadExtensions(["plain", "ghost"], { ...base(), wolfConfig: {} });
    expect(r.lifecycles).toEqual([]);
    expect(r.failed.map((f) => f.name)).toEqual(["ghost"]);
  });
});
