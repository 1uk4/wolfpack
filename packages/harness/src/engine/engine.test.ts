/** Engine interface smoke test: real pi-durable, real sqlite, no model calls. */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWolfEngine, engineVersion } from "./index.js";

let dir: string;
let store: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wolf-engine-"));
  store = join(dir, "session.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const model = { provider: "anthropic", modelId: "claude-haiku-5-5" };

describe("openWolfEngine", () => {
  it("reports the installed engine version", () => {
    expect(engineVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("opens a store, creates the root conversation idempotently, configures and watches (no turn)", async () => {
    const engine = await openWolfEngine(store, { cwd: dir });
    try {
      expect(engine.backup).toBeUndefined(); // fresh store: nothing to back up
      const a = await engine.conversations.root({ model });
      const b = await engine.conversations.root({ model });
      expect(b.id).toBe(a.id);
      await a.configure({ model, thinkingLevel: null, cwd: dir });
      const w = await a.watch();
      expect(w.snapshot.type).toBe("snapshot");
      expect(w.snapshot.run).toBeUndefined();
      expect(w.snapshot.agent.cwd).toBe(dir);
      await w.stop();
      const again = await engine.conversations.get(a.id);
      expect(again?.id).toBe(a.id);
      expect(await engine.conversations.get("99999")).toBeUndefined();
      const other = await engine.conversations.create({ model });
      expect(other.id).not.toBe(a.id);
      await a.abort(); // idle abort is a no-op
      engine.resume();
    } finally {
      await engine.close();
    }
  });

  it("rejects unknown tool names", async () => {
    const engine = await openWolfEngine(store, { cwd: dir });
    try {
      const c = await engine.conversations.root({ model });
      await expect(c.configure({ tools: ["nope"] })).rejects.toThrow(/unknown tool/);
    } finally {
      await engine.close();
    }
  });

  it("backs up an existing store on first open, once per engine version", async () => {
    await (await openWolfEngine(store, { cwd: dir })).close();
    const e1 = await openWolfEngine(store, { cwd: dir });
    expect(e1.backup).toBeDefined();
    expect(existsSync(e1.backup!.dir)).toBe(true);
    await e1.close();
    const e2 = await openWolfEngine(store, { cwd: dir });
    expect(e2.backup).toBeUndefined();
    await e2.close();
  });
});
