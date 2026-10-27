import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { lazyImageProcessor } from "./tools.js";

const crc = (b: Buffer) => {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const t = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(t));
  return Buffer.concat([len, t, sum]);
};
function solidPng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 200)]);
  const idat = deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

describe("lazyImageProcessor", () => {
  it("loads once, on first use, and delegates", async () => {
    const prepare = vi.fn(async () => undefined);
    const load = vi.fn(async () => ({ prepare }));
    const p = lazyImageProcessor(load);
    expect(load).not.toHaveBeenCalled();
    await p.prepare(new Uint8Array(1), "image/png", DEFAULT_IMAGE_LIMITS);
    await p.prepare(new Uint8Array(2), "image/png", DEFAULT_IMAGE_LIMITS);
    expect(load).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("the real processor shrinks a retina-sized screenshot to the read limits", async () => {
    const p = lazyImageProcessor(() => createNodePhotonImages({ worker: false }));
    const out = await p.prepare(solidPng(2880, 1800), "image/png", DEFAULT_IMAGE_LIMITS);
    expect(out?.resized?.from).toEqual({ width: 2880, height: 1800 });
    expect(out!.resized!.to.width).toBeLessThanOrEqual(DEFAULT_IMAGE_LIMITS.maxWidth);
    expect(out!.resized!.to.height).toBeLessThanOrEqual(DEFAULT_IMAGE_LIMITS.maxHeight);
  });
});
