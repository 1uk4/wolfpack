import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeBody } from "./fetcher.js";

describe("decodeBody", () => {
  it("skips decoding an empty body (HEAD / 204 / 304 naming an encoding)", () => {
    expect(decodeBody(Buffer.alloc(0), "gzip", 100).length).toBe(0);
    expect(decodeBody(Buffer.alloc(0), "br", 100).length).toBe(0);
  });
  it("still decodes real bodies and rejects bad or unknown ones", () => {
    expect(decodeBody(gzipSync("hi"), "gzip", 100).toString()).toBe("hi");
    expect(() => decodeBody(Buffer.from("not gzip"), "gzip", 100)).toThrow(/could not decode/);
    expect(() => decodeBody(Buffer.from("x"), "zstd", 100)).toThrow(/unsupported/);
  });
});
