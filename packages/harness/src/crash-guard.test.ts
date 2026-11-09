import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { installCrashGuard, postStartRejectionCount, resetPostStartRejectionCount } from "./crash-guard.js";

const setup = () => {
  const proc = new EventEmitter();
  const exit = vi.fn();
  const log = vi.fn();
  const guard = installCrashGuard(proc as never, { exit, log });
  return { proc, exit, log, guard };
};

describe("installCrashGuard", () => {
  beforeEach(() => resetPostStartRejectionCount());
  it("exits 1 on an unhandled rejection before startup completes", () => {
    const { proc, exit } = setup();
    proc.emit("unhandledRejection", new Error("early"));
    expect(exit).toHaveBeenCalledWith(1);
  });
  it("after startup, logs the rejection with its stack and stays alive", () => {
    const { proc, exit, log, guard } = setup();
    guard.markStarted();
    const err = new Error("late");
    proc.emit("unhandledRejection", err);
    expect(exit).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]![1])).toContain(err.stack!.split("\n")[1]!.trim());
  });
  it("counts post-start rejections and numbers them in the log line; startup rejections are not counted", () => {
    const { proc, log, guard } = setup();
    proc.emit("unhandledRejection", new Error("early"));
    expect(postStartRejectionCount()).toBe(0);
    guard.markStarted();
    proc.emit("unhandledRejection", new Error("a"));
    proc.emit("unhandledRejection", new Error("b"));
    expect(postStartRejectionCount()).toBe(2);
    expect(String(log.mock.calls[2]![0])).toContain("#2");
  });
  it("an uncaught exception always exits, started or not", () => {
    const { proc, exit, guard } = setup();
    guard.markStarted();
    proc.emit("uncaughtException", new Error("x"));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
