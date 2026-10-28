import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@wolfpack/memory", async (orig) => ({
  ...(await orig<typeof import("@wolfpack/memory")>()),
  confirmGraduation: vi.fn(async () => ({ sent: ["e1"], archived: ["f", "t"], lateFolded: 0 })),
  unbindOnGraduation: vi.fn(() => {
    throw new Error("binding store locked");
  }),
}));

const { createGraduation } = await import("./graduation.js");

describe("createGraduation.confirm", () => {
  it("a failing unbind after the graduation happened is a warning, not an error", async () => {
    const den = mkdtempSync(join(tmpdir(), "grad-warn-"));
    mkdirSync(join(den, "tasks", "graduation"), { recursive: true });
    const token = "abcdef012345";
    const preview = { itemId: "f", title: "F", kind: "feature", domain: "d", token, createdAt: new Date().toISOString(), contributions: [], warnings: [], archive: [] };
    writeFileSync(join(den, "tasks", "graduation", `${token}.json`), JSON.stringify(preview));
    const g = createGraduation({
      client: {} as never,
      wolfDen: den,
      wolfName: "w",
      roots: () => ({}) as never,
      engine: () => ({}) as never,
      drain: async () => ({ folded: 0 }),
      ship: async () => undefined,
    });
    const r = await g.actions.confirm("f", token);
    expect(r).toMatchObject({ entries: ["e1"], archived: ["f", "t"], unbound: 0, warnings: [expect.stringContaining("binding store locked")] });
  });
});
