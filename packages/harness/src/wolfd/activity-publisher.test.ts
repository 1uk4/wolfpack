import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityPublisher, kbEntryOfPath } from "./activity-publisher.js";

const target = { url: "http://hub/", token: "tok" };
const draft = { verb: "kb-read" as const, actor: { kind: "thread" as const, threadId: "t1" } };
type Fetch = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<Response>;
const mk = (status = 202) => vi.fn<Fetch>(async () => new Response(null, { status }));

function make(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new ActivityPublisher({ target, wolf: "w", fetchImpl, random: () => 1, ...extra });
}
const sent = (f: ReturnType<typeof mk>, i = 0) => JSON.parse(f.mock.calls[i]![1].body) as { v: number; events: { verb: string; ttlMs: number; actor: { wolf: string }; target?: { title?: string } }[] };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ActivityPublisher", () => {
  it("posts a stamped batch with the bearer token after the flush interval", async () => {
    const f = mk();
    const p = make(f as unknown as typeof fetch);
    p.emit({ ...draft, target: { kind: "kb-entry", id: "e1", title: `  ${"x".repeat(200)}  ` } });
    expect(f).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe("http://hub/v1/activity");
    expect(f.mock.calls[0]![1].headers.Authorization).toBe("Bearer tok");
    const b = sent(f);
    expect(b.v).toBe(1);
    expect(b.events[0]).toMatchObject({ verb: "kb-read", ttlMs: 300_000, actor: { wolf: "w" } });
    expect(b.events[0]!.target!.title).toHaveLength(120);
  });

  it("drops the oldest when the queue is full and counts them", () => {
    const p = make(vi.fn() as unknown as typeof fetch, { queueMax: 3 });
    for (let i = 0; i < 5; i++) p.emit(draft);
    expect(p.queued).toBe(3);
    expect(p.droppedCount).toBe(2);
  });

  it("emit never throws and flush never rejects when fetch throws or hangs", async () => {
    const boom = make((async () => { throw new Error("down"); }) as unknown as typeof fetch);
    expect(() => boom.emit(draft)).not.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    const hang = make(((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch);
    hang.emit(draft);
    await vi.advanceTimersByTimeAsync(1000 + 3000);
    await expect(hang.flush()).resolves.toBeUndefined();
  });

  it("flushes at 50 events at once and caps a request at 100 events", async () => {
    const f = mk();
    const p = make(f as unknown as typeof fetch, { queueMax: 500 });
    for (let i = 0; i < 250; i++) p.emit(draft);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent(f).events).toHaveLength(100);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.mock.calls.map((_c, i) => sent(f, i).events.length)).toEqual([100, 100, 50]);
  });

  it("backs off after a failure and opens the breaker after repeated ones", async () => {
    const f = mk(500);
    const p = make(f as unknown as typeof fetch, { breakerAfter: 2, breakerCooldownMs: 60_000 });
    p.emit(draft);
    await vi.advanceTimersByTimeAsync(1000); // fail 1: backoff 2 s
    p.emit(draft);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1100); // fail 2: breaker, 60 s
    expect(f).toHaveBeenCalledTimes(2);
    p.emit(draft);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000); // probe
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("treats 404 as unsupported: one log line, silent for 10 minutes, then probes again", async () => {
    const f = mk(404);
    const log = vi.fn();
    const p = make(f as unknown as typeof fetch, { log });
    p.emit(draft);
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 20; i++) { p.emit(draft); await vi.advanceTimersByTimeAsync(20_000); }
    expect(f).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(f.mock.calls.length).toBe(2);
  });

  it("treats 401 like 404: one log line, then ten minutes of quiet", async () => {
    const f = mk(401);
    const log = vi.fn();
    const p = make(f as unknown as typeof fetch, { log });
    p.emit(draft);
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 20; i++) { p.emit(draft); await vi.advanceTimersByTimeAsync(20_000); }
    expect(f).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(f.mock.calls.length).toBe(2);
  });

  it("stop() gives the final flush 500 ms, not longer", async () => {
    // AbortSignal.timeout runs on the real clock, so observe the budget it is given.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const p = make(mk() as unknown as typeof fetch);
    p.emit(draft);
    await p.stop();
    expect(timeout).toHaveBeenCalledWith(500);
    timeout.mockRestore();
  });

  it("is a no-op without a hub target", async () => {
    const f = vi.fn();
    const p = new ActivityPublisher({ target: undefined, wolf: "w", fetchImpl: f as unknown as typeof fetch });
    p.emit(draft);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f).not.toHaveBeenCalled();
    expect(p.queued).toBe(0);
  });
});

describe("kbEntryOfPath", () => {
  it("matches mirror entries only", () => {
    expect(kbEntryOfPath("/h/.wolfpack/workerd/kb-mirror/domains/wolfpack/entries/Ab12.md")).toEqual({ domain: "wolfpack", id: "Ab12" });
    expect(kbEntryOfPath("/h/kb-mirror/domains/wolfpack/INDEX.md")).toBeUndefined();
    expect(kbEntryOfPath("/h/kb-mirror/domains/wolfpack/_digest.json")).toBeUndefined();
    expect(kbEntryOfPath("/h/code/entries/x.md")).toBeUndefined();
  });
});
