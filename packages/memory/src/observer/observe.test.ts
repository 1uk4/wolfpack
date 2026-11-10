import { describe, it, expect } from "vitest";
import { OBSERVER_SYSTEM } from "@wolfpack/engine";
import { observe } from "./observe.js";

function fakeEngine() {
  const seen: { system: string; schema: any }[] = [];
  const engine = {
    call: async (_tier: string, schema: any, req: { system: string }) => {
      seen.push({ system: req.system, schema });
      return { observations: [{ timestamp: "2026-11-09 10:00", content: "x", general: true }] };
    },
  } as any;
  return { engine, seen };
}

const fields = (schema: any) => Object.keys(schema.shape.observations.element.shape);

describe("observe general flag", () => {
  it("sends the unchanged base prompt and schema when the flag is off", async () => {
    const { engine, seen } = fakeEngine();
    const r = await observe({ engine, chunkText: "hi" });
    expect(seen[0].system).toBe(OBSERVER_SYSTEM);
    expect(seen[0].system).not.toContain("General flag");
    expect(fields(seen[0].schema)).toEqual(["timestamp", "content", "domain"]);
    expect(r.observations).toHaveLength(1);
  });

  it("adds the general-flag block and field when the flag is on", async () => {
    const { engine, seen } = fakeEngine();
    await observe({ engine, chunkText: "hi", generalFlag: true });
    expect(seen[0].system).toContain("General flag:");
    expect(fields(seen[0].schema)).toContain("general");
  });
});
