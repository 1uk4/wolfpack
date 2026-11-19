import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WOLFD_VERSION_STAMPS } from "./server.js";

describe("wolfd version stamp", () => {
  it("wolfd reports the VERSION stamp sitting next to its bundle", () => {
    const first = WOLFD_VERSION_STAMPS[0]!;
    expect(fileURLToPath(first)).toBe(fileURLToPath(new URL("./VERSION", import.meta.url)));
  });
});
