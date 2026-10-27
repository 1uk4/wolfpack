import { describe, expect, it } from "vitest";
import { ROUTES, buildPath, matchRoute } from "./index.js";

describe("route table", () => {
  it("matches every route and decodes params", () => {
    expect(matchRoute("GET", "/v1/wolves")).toMatchObject({ name: "listWolves" });
    expect(matchRoute("POST", "/v1/wolves/1uk4/threads")).toMatchObject({ name: "createThread", params: { name: "1uk4" } });
    expect(matchRoute("GET", "/v1/threads/1uk4%2Fhome/stream")).toMatchObject({ name: "streamThread", params: { id: "1uk4/home" } });
  });
  it("distinguishes unknown path from wrong method", () => {
    expect(matchRoute("GET", "/v1/nope")).toBeUndefined();
    expect(matchRoute("DELETE", "/v1/wolves")).toBe("method");
  });
  it("buildPath round-trips through matchRoute", () => {
    for (const [name, r] of Object.entries(ROUTES)) {
      const p = buildPath(name as keyof typeof ROUTES, { name: "a/b", id: "a/b", attachmentId: "x" });
      expect(matchRoute(r.method, p)).toMatchObject({ name });
    }
  });
});
