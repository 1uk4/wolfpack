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

  it("status reports the restart count", async () => {
    expect(await manager.status("abc123")).toMatchObject({ serviceState: "active", active: true, restarts: 3 });
  });
});
