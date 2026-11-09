/** (Test: "getTree walks partOf level by level and never asks for the whole list") The unfiltered list is ~1.6 MB / ~4 s on the real hub, over the 3 s limit. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkClient } from "./work-client.js";

afterEach(() => vi.unstubAllGlobals());

const ITEMS: Record<string, { id: string; partOf?: string }> = {
  "work-d-root": { id: "work-d-root" },
  "work-d-a": { id: "work-d-a", partOf: "work-d-root" },
  "work-d-b": { id: "work-d-b", partOf: "work-d-root" },
  "work-d-a1": { id: "work-d-a1", partOf: "work-d-a" },
};

describe("WorkClient.getTree", () => {
  it("returns the root then its descendants depth first, from partOf-scoped reads only", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      const partOf = u.searchParams.get("partOf");
      if (partOf) return new Response(JSON.stringify({ items: Object.values(ITEMS).filter((i) => i.partOf === partOf) }));
      const id = u.pathname.split("/").pop()!;
      return ITEMS[id] ? new Response(JSON.stringify({ item: ITEMS[id] })) : new Response(JSON.stringify({ error: "nope" }), { status: 404 });
    });
    const tree = await new WorkClient("http://hub/v1/workapi", "tok").getTree("work-d-root");
    expect(tree.map((i) => i.id)).toEqual(["work-d-root", "work-d-a", "work-d-a1", "work-d-b"]);
    expect(urls.every((u) => !/\/work(\?|$)/.test(u) || u.includes("partOf="))).toBe(true);
    expect(await new WorkClient("http://hub/v1/workapi", "tok").getTree("work-d-missing")).toEqual([]);
  });
});
