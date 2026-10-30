import { describe, it, expect, vi } from "vitest";
import { hubFromEnv, registerDomainOnHub, removeDomainOnHub } from "./hub-registry.js";

describe("hub registry", () => {
  it("is unset without WOLFPACK_HUB_URL", () => expect(hubFromEnv({})).toBeUndefined());
  it("POSTs the domain with the bearer token", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 201 }));
    const hub = hubFromEnv({ WOLFPACK_HUB_URL: "http://h:1/", WOLFPACK_HUB_TOKEN: "tok" })!;
    expect(await registerDomainOnHub({ ...hub, fetch: f as any }, { name: "a", label: "A" })).toBe("created");
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("http://h:1/v1/registry/domains");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ name: "a", label: "A" });
  });
  it("throws on a non-2xx and DELETEs on remove", async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: "no" }), { status: 403 }));
    await expect(removeDomainOnHub({ baseUrl: "http://h", fetch: bad as any }, "a")).rejects.toThrow(/403: no/);
    expect((bad.mock.calls[0] as any)[1].method).toBe("DELETE");
    const nf = vi.fn(async () => new Response(JSON.stringify({ code: "not_found" }), { status: 404 }));
    expect(await removeDomainOnHub({ baseUrl: "http://h", fetch: nf as any }, "a")).toBe("absent");
    const dup = vi.fn(async () => new Response("{}", { status: 409 }));
    expect(await registerDomainOnHub({ baseUrl: "http://h", fetch: dup as any }, { name: "a" })).toBe("exists");
  });
  it("scrubs URL credentials and the token from errors (HTTP and transport)", async () => {
    const hub = { baseUrl: "http://user:pass@h:1", token: "SECRET" };
    const boom = vi.fn(async () => { throw new Error("connect ECONNREFUSED http://user:pass@h:1/v1 Bearer SECRET"); });
    const err1 = await registerDomainOnHub({ ...hub, fetch: boom as any }, { name: "a" }).then(() => new Error("no throw"), (e) => e as Error);
    expect(String(err1.message)).not.toMatch(/user:pass|SECRET/);
    const bad = vi.fn(async () => new Response(JSON.stringify({ message: "denied for http://user:pass@h:1 SECRET" }), { status: 403 }));
    const err2 = await registerDomainOnHub({ ...hub, fetch: bad as any }, { name: "a" }).then(() => new Error("no throw"), (e) => e as Error);
    expect(err2.message).toContain("403");
    expect(err2.message).not.toMatch(/user:pass|SECRET/);
  });
  it("DELETE 404 is absent only for a not_found body", async () => {
    const nf = vi.fn(async () => new Response(JSON.stringify({ code: "not_found", message: "x" }), { status: 404 }));
    expect(await removeDomainOnHub({ baseUrl: "http://h", fetch: nf as any }, "a")).toBe("absent");
    const plain = vi.fn(async () => new Response("<html>", { status: 404 }));
    await expect(removeDomainOnHub({ baseUrl: "http://h", fetch: plain as any }, "a")).rejects.toThrow(/404/);
  });
});
