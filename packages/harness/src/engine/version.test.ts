import { describe, it, expect } from "vitest";
import { engineVersion } from "./version.js";

describe("engineVersion", () => {
  it("reads the installed pi-durable version", () => {
    expect(engineVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
