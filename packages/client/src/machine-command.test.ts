import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpConsoleClient } from "./index.js";

const hub = { baseUrl: "http://hub.test", token: "tok" };
const answer = (status: number, body: unknown): typeof fetch => async () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const make = (fetch: typeof globalThis.fetch) => new HttpConsoleClient({ baseUrl: "http://wolf.test", hub, fetch, retryDelayMs: 5 });

afterEach(() => {
  vi.useRealTimers();
});

describe("machineCommand (work-wolfpack-4qae7Hg)", () => {
  it("returns the hub's CommandResponse body for 409 and 504 as a result, not an error", async () => {
    const c409 = make(answer(409, { id: "c-1", ok: false, code: "not_sent_unsupported", message: "no" }));
    expect(await c409.machineCommand("sfo-01", { kind: "workerd.restart", args: {} })).toEqual({ id: "c-1", ok: false, code: "not_sent_unsupported", message: "no" });
    const c504 = make(answer(504, { id: "c-2", ok: false, code: "timeout" }));
    expect(await c504.machineCommand("sfo-01", { kind: "logs.fetch", args: { service: "hubd", lines: 5 } })).toMatchObject({ ok: false, code: "timeout" });
  });

  it("waits 30 s for the hub, past the usual 20 s request timeout, so the hub's own 504 can arrive", async () => {
    vi.useFakeTimers();
    const slowHub: typeof fetch = (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        setTimeout(() => resolve(new Response(JSON.stringify({ id: "c-9", ok: false, code: "timeout" }), { status: 504, headers: { "Content-Type": "application/json" } })), 25_000);
      });
    const pending = make(slowHub).machineCommand("sfo-01", { kind: "key.set", args: {} });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toMatchObject({ ok: false, code: "timeout" });
    const never = make((_url, init) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const stuck = never.machineCommand("sfo-01", { kind: "key.set", args: {} }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await stuck).toMatchObject({ timedOut: true });
  });

  it("sends sealed in the body when given and leaves it out when absent", async () => {
    const bodies: unknown[] = [];
    const c = make(async (_url, init) => (bodies.push(JSON.parse(String(init?.body))), new Response(JSON.stringify({ id: "c-1", ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await c.machineCommand("sfo-01", { kind: "key.set", args: {}, sealed: "SEALED-X" });
    await c.machineCommand("sfo-01", { kind: "wolves.restart" });
    expect(bodies).toEqual([{ kind: "key.set", args: {}, sealed: "SEALED-X" }, { kind: "wolves.restart", args: {} }]);
  });

  it("still throws the hub's error envelope for a refused request", async () => {
    const c = make(answer(400, { code: "invalid_request", message: "bad body", retryable: false }));
    await expect(c.machineCommand("sfo-01", { kind: "workerd.restart", args: {} })).rejects.toMatchObject({ code: "invalid_request" });
  });
});
