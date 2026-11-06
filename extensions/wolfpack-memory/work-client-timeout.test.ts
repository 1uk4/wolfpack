/** (Test: "a slow hub answer aborts under the default limit and succeeds under a longer one") The listing of every work item takes ~4 s on the real hub; graduation needs a longer limit while binding keeps the 3 s default. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkClient } from "./work-client.js";

afterEach(() => vi.unstubAllGlobals());

/** A hub that answers after `ms`, and gives up like a real fetch when the caller's signal aborts first. */
const slowHub = (ms: number) =>
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({ items: [] }), { status: 200 })), ms);
    init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); });
  }));

describe("WorkClient timeout", () => {
  it("a slow hub answer aborts under the default limit and succeeds under a longer one", async () => {
    slowHub(3500);
    await expect(new WorkClient("http://hub/v1/workapi", "tok").query({})).rejects.toThrow();
    await expect(new WorkClient("http://hub/v1/workapi", "tok").withTimeout(60_000).query({})).resolves.toEqual([]);
  }, 15_000);
});
