import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLifecycles } from "./lifecycle.js";
import type { LoadedLifecycle } from "./loader.js";
import type { TelegramSharedState } from "./extension-api.js";

function entry(name: string, log: string[], opts: { failStart?: boolean; failStop?: boolean } = {}): LoadedLifecycle {
  return {
    name,
    config: { who: name },
    lifecycle: {
      async start() {
        log.push(`start:${name}`);
        if (opts.failStart) throw new Error("boom");
      },
      stop() {
        log.push(`stop:${name}`);
        if (opts.failStop) throw new Error("boom");
      },
    },
  };
}

describe("startLifecycles", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it("starts in load order and stops in reverse", async () => {
    const log: string[] = [];
    const stop = await startLifecycles([entry("a", log), entry("b", log), entry("c", log)], { wolfDen: "/den", wolfName: "w" });
    expect(log).toEqual(["start:a", "start:b", "start:c"]);
    await stop();
    expect(log.slice(3)).toEqual(["stop:c", "stop:b", "stop:a"]);
  });

  it("a failing stop does not block the others", async () => {
    const log: string[] = [];
    const stop = await startLifecycles([entry("a", log), entry("b", log, { failStop: true }), entry("c", log)], { wolfDen: "/den", wolfName: "w" });
    await expect(stop()).resolves.toBeUndefined();
    expect(log.slice(3)).toEqual(["stop:c", "stop:b", "stop:a"]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("b failed to stop"));
  });

  it("a failing start does not block later starts", async () => {
    const log: string[] = [];
    await startLifecycles([entry("a", log, { failStart: true }), entry("b", log)], { wolfDen: "/den", wolfName: "w" });
    expect(log).toEqual(["start:a", "start:b"]);
  });

  it("hands start the den, its own config and a working send", async () => {
    const sendMessage = vi.fn(async () => 1);
    const telegram = { botApi: { sendMessage, getChatId: () => 42 } } as unknown as TelegramSharedState;
    let seen: Parameters<NonNullable<LoadedLifecycle["lifecycle"]["start"]>>[0] | undefined;
    await startLifecycles(
      [{ name: "x", config: { timezone: "UTC" }, lifecycle: { start: (ctx) => { seen = ctx; } } }],
      { wolfDen: "/den", wolfName: "w", telegram },
    );
    expect(seen?.wolfDen).toBe("/den");
    expect(seen?.config).toEqual({ timezone: "UTC" });
    expect(await seen!.send("hi")).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(42, "hi");
  });

  it("send resolves false without telegram or a chat", async () => {
    let send: ((t: string) => Promise<boolean>) | undefined;
    await startLifecycles([{ name: "x", config: {}, lifecycle: { start: (c) => { send = c.send; } } }], { wolfDen: "/d", wolfName: "w" });
    expect(await send!("hi")).toBe(false);
  });
});
