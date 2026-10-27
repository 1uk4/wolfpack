import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
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

  for (const worker of [false, true]) {
    it(`the real processor shrinks a retina-sized screenshot to the read limits (${worker ? "worker thread" : "in process"})`, async () => {
      const p = lazyImageProcessor(() => createNodePhotonImages({ worker, idleMs: 50 }));
      const out = await p.prepare(solidPng(2880, 1800), "image/png", DEFAULT_IMAGE_LIMITS);
      expect(out?.resized?.from).toEqual({ width: 2880, height: 1800 });
      expect(out!.resized!.to.width).toBeLessThanOrEqual(DEFAULT_IMAGE_LIMITS.maxWidth);
      expect(out!.resized!.to.height).toBeLessThanOrEqual(DEFAULT_IMAGE_LIMITS.maxHeight);
    });
  }

  describe("when the processor cannot load (e.g. no WASM in a bundle)", () => {
    const warn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

    it("an image within the limits still passes through unchanged", async () => {
      warn();
      const png = solidPng(64, 64);
      const p = lazyImageProcessor(async () => { throw new Error("ENOENT photon_rs_bg.wasm"); });
      const out = await p.prepare(png, "image/png", DEFAULT_IMAGE_LIMITS);
      expect(out).toEqual({ data: png.toString("base64"), mimeType: "image/png" });
    });

    it("an oversized image is refused with a clear message, not an opaque error", async () => {
      const spy = warn();
      const p = lazyImageProcessor(async () => { throw new Error("ENOENT photon_rs_bg.wasm"); });
      await expect(p.prepare(solidPng(2880, 1800), "image/png", DEFAULT_IMAGE_LIMITS)).rejects.toThrow(/image too large to process here.*ENOENT/);
      expect(spy).toHaveBeenCalled();
    });

    it("a failed load is not cached: the next image retries and succeeds", async () => {
      warn();
      const prepare = vi.fn(async () => ({ data: "ok", mimeType: "image/png" }));
      const load = vi.fn<() => Promise<ImageProcessor>>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ prepare });
      const p = lazyImageProcessor(load);
      await p.prepare(solidPng(8, 8), "image/png", DEFAULT_IMAGE_LIMITS);
      expect(await p.prepare(solidPng(8, 8), "image/png", DEFAULT_IMAGE_LIMITS)).toEqual({ data: "ok", mimeType: "image/png" });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("a processor that loads but cannot start (Photon in a CJS bundle) degrades the same way", async () => {
      warn();
      const p = lazyImageProcessor(async () => ({ prepare: async () => { throw new TypeError("Cannot read properties of undefined (reading 'endsWith')"); } }));
      await expect(p.prepare(solidPng(2880, 1800), "image/png", DEFAULT_IMAGE_LIMITS)).rejects.toThrow(/image too large to process here/);
      expect((await p.prepare(solidPng(8, 8), "image/png", DEFAULT_IMAGE_LIMITS))?.mimeType).toBe("image/png");
    });

    it("once it has worked, a failure on one image is surfaced and the processor kept", async () => {
      const prepare = vi.fn().mockResolvedValueOnce({ data: "ok", mimeType: "image/png" }).mockRejectedValueOnce(new Error("bad pixels")).mockResolvedValue({ data: "ok", mimeType: "image/png" });
      const load = vi.fn(async () => ({ prepare }));
      const p = lazyImageProcessor(load);
      await p.prepare(solidPng(8, 8), "image/png", DEFAULT_IMAGE_LIMITS);
      await expect(p.prepare(solidPng(8, 8), "image/png", DEFAULT_IMAGE_LIMITS)).rejects.toThrow("bad pixels");
      await p.prepare(solidPng(8, 8), "image/png", DEFAULT_IMAGE_LIMITS);
      expect(load).toHaveBeenCalledTimes(1);
    });
  });
});
