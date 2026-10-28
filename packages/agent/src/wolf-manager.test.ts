import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const calls: string[][] = [];
vi.mock("node:child_process", () => ({
  execFile: (cmd: string, args: string[], ...rest: unknown[]) => {
    calls.push([cmd, ...args]);
    const cb = rest[rest.length - 1] as (e: Error | null, r: { stdout: string; stderr: string }) => void;
    cb(null, { stdout: args.includes("--property=NRestarts") ? "3\n" : args[0] === "is-active" ? "active\n" : "", stderr: "" });
  },
}));

const { WolfManager } = await import("./wolf-manager.js");

describe("harness bundle rollback", () => {
  let root: string;
  let manager: InstanceType<typeof WolfManager>;
  const agentDir = () => path.join(root, "home", "wolf-abc123", "agent");
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wolf-mgr-"));
    process.env.WOLFPACK_HOME_ROOT = path.join(root, "home");
    fs.mkdirSync(agentDir(), { recursive: true });
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "data", "wolves.json"),
      JSON.stringify([{ id: "abc123", name: "hal", runtime: "pi-durable", role: "r", domains: [], extensions: [] }]),
    );
    manager = new WolfManager(path.join(root, "data"));
    await manager.init();
    calls.length = 0;
  });
  afterEach(() => {
    delete process.env.WOLFPACK_HOME_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("an update keeps the bundle it replaces as harness.prev.cjs; rollback puts it back and restarts", async () => {
    fs.writeFileSync(path.join(agentDir(), "harness.cjs"), "OLD");
    await manager.updatePiDurableBundle("abc123", b64("NEW"), b64("id: abc123\nname: hal\n"), b64("# persona"));
    expect(fs.readFileSync(path.join(agentDir(), "harness.cjs"), "utf8")).toBe("NEW");
    expect(fs.readFileSync(path.join(agentDir(), "harness.prev.cjs"), "utf8")).toBe("OLD");

    calls.length = 0;
    await manager.rollbackHarness("abc123");
    expect(fs.readFileSync(path.join(agentDir(), "harness.cjs"), "utf8")).toBe("OLD");
    expect(calls).toContainEqual(["systemctl", "restart", "wolf-abc123.service"]);
  });

  it("the first update has nothing to keep; rollback with no previous bundle throws and restarts nothing", async () => {
    await manager.updatePiDurableBundle("abc123", b64("NEW"), b64("id: abc123\nname: hal\n"), b64("# persona"));
    expect(fs.existsSync(path.join(agentDir(), "harness.prev.cjs"))).toBe(false);
    calls.length = 0;
    await expect(manager.rollbackHarness("abc123")).rejects.toThrow(/No previous harness bundle/);
    expect(calls.some((c) => c[1] === "restart")).toBe(false);
    await expect(manager.rollbackHarness("nope")).rejects.toThrow(/Wolf not found/);
  });

  it("rollback restores the den extensions the bad sync replaced, and leaves owner extensions alone", async () => {
    const ext = (n: string) => path.join(root, "home", "wolf-abc123", "den", "extensions", n, "index.js");
    const yaml = b64("id: abc123\nname: hal\n");
    fs.writeFileSync(path.join(agentDir(), "harness.cjs"), "H0");
    await manager.updatePiDurableBundle("abc123", b64("H1"), yaml, b64("#"), { memory: b64("M1"), old: b64("O1") });
    await manager.confirmSync("abc123");
    fs.mkdirSync(path.dirname(ext("owner")), { recursive: true });
    fs.writeFileSync(ext("owner"), "OWN");
    // The bad sync: new harness, memory changed, "old" dropped, "fresh" added.
    await manager.updatePiDurableBundle("abc123", b64("H2"), yaml, b64("#"), { memory: b64("M2"), fresh: b64("F2") });
    expect(fs.existsSync(ext("old"))).toBe(false);
    await manager.rollbackHarness("abc123");
    expect(fs.readFileSync(path.join(agentDir(), "harness.cjs"), "utf8")).toBe("H1");
    expect(fs.readFileSync(ext("memory"), "utf8")).toBe("M1");
    expect(fs.readFileSync(ext("old"), "utf8")).toBe("O1");
    expect(fs.existsSync(ext("fresh"))).toBe(false);
    expect(fs.readFileSync(ext("owner"), "utf8")).toBe("OWN");
  });

  it("rollback also restores wolf.yaml and models.json", async () => {
    const home = path.join(root, "home", "wolf-abc123");
    fs.writeFileSync(path.join(agentDir(), "harness.cjs"), "H0");
    fs.writeFileSync(path.join(home, "models.json"), "MODELS0");
    fs.writeFileSync(path.join(home, "wolf.yaml"), "id: abc123\nname: hal\nrole: old\n");
    await manager.updatePiDurableBundle("abc123", b64("H1"), b64("id: abc123\nname: hal\nrole: new\n"), b64("#"), {}, b64("MODELS1"));
    expect(fs.readFileSync(path.join(home, "models.json"), "utf8")).toBe("MODELS1");
    await manager.rollbackHarness("abc123");
    expect(fs.readFileSync(path.join(home, "models.json"), "utf8")).toBe("MODELS0");
    expect(fs.readFileSync(path.join(home, "wolf.yaml"), "utf8")).toContain("role: old");
  });

  it("a rollback without extensions.prev warns instead of reporting a clean rollback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fs.writeFileSync(path.join(agentDir(), "harness.cjs"), "H0");
      await manager.updatePiDurableBundle("abc123", b64("H1"), b64("id: abc123\nname: hal\n"), b64("#"));
      await manager.rollbackHarness("abc123");
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/no extensions\.prev/);
    } finally {
      warn.mockRestore();
    }
  });

  it("two bad syncs in a row do not overwrite the good pair; a confirmed sync rotates", async () => {
    const yaml = b64("id: abc123\nname: hal\n");
    fs.writeFileSync(path.join(agentDir(), "harness.cjs"), "GOOD");
    await manager.updatePiDurableBundle("abc123", b64("BAD1"), yaml, b64("#"), { m: b64("M-BAD1") });
    await manager.updatePiDurableBundle("abc123", b64("BAD2"), yaml, b64("#"), { m: b64("M-BAD2") });
    expect(fs.readFileSync(path.join(agentDir(), "harness.prev.cjs"), "utf8")).toBe("GOOD");
    await manager.rollbackHarness("abc123");
    expect(fs.readFileSync(path.join(agentDir(), "harness.cjs"), "utf8")).toBe("GOOD");
    // rolled back = known good: the next sync rotates again
    await manager.updatePiDurableBundle("abc123", b64("N1"), yaml, b64("#"));
    await manager.confirmSync("abc123");
    await manager.updatePiDurableBundle("abc123", b64("N2"), yaml, b64("#"));
    expect(fs.readFileSync(path.join(agentDir(), "harness.prev.cjs"), "utf8")).toBe("N1");
  });

  it("status reports the restart count", async () => {
    expect(await manager.status("abc123")).toMatchObject({ serviceState: "active", active: true, restarts: 3 });
  });
});
