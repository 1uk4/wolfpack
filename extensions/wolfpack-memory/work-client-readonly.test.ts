/** (Tests: "create and note throw...", "a permission fault is its own typed error...") A hub that answers {code:"work_store_read_only"} reaches the model as plain words, from a write; reads are untouched. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkClient, WorkStorePermissionError, WorkStoreReadOnlyError } from "./work-client.js";

afterEach(() => vi.unstubAllGlobals());
const hub = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })));

describe("WorkClient on a read-only work store", () => {
  it("create and note throw a plain, typed read-only error (not a raw HTTP/EROFS message)", async () => {
    hub(503, { error: "work store is read-only: this hub cannot write work items (nothing was changed)", code: "work_store_read_only" });
    const c = new WorkClient("http://hub/v1/workapi", "tok");
    const e = await c.create({ kind: "task", domain: "personal", title: "t", assignee: "hal2" } as never).catch((x) => x);
    expect(e).toBeInstanceOf(WorkStoreReadOnlyError);
    expect(e.message).toMatch(/work store is read-only on this host/);
    expect(e.message).toMatch(/Do not retry/);
    expect(e.message).not.toMatch(/EROFS|HTTP 5/);
    await expect(c.note("work-personal-abcd123", "x")).rejects.toBeInstanceOf(WorkStoreReadOnlyError);
  });
  it("a permission fault is its own typed error and never says writes are turned off", async () => {
    hub(500, { error: "work store write was refused with a permission error", code: "work_store_permission_denied" });
    const e = await new WorkClient("http://hub/v1/workapi", "tok").create({ kind: "task", domain: "personal", title: "t", assignee: "hal2" } as never).catch((x) => x);
    expect(e).toBeInstanceOf(WorkStorePermissionError);
    expect(e.message).toMatch(/permission fault/);
    expect(e.message).toMatch(/owner to check/);
    expect(e.message).not.toMatch(/turned off|read-only/);
  });
  it("other errors keep their message", async () => {
    hub(404, { error: "Work item not found: x" });
    await expect(new WorkClient("http://hub/v1/workapi", "tok").get("work-personal-abcd123")).rejects.toThrow("Work item not found: x");
  });
});
