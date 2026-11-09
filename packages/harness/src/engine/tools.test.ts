import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { headerSize, lazyImageProcessor } from "./tools.js";

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

describe("fallback messages and structural failures", () => {
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("garbage that is not an image is 'unsupported or unreadable', not 'too large'", async () => {
    quiet();
    const p = lazyImageProcessor(async () => { throw new Error("boom"); });
    await expect(p.prepare(Buffer.from("not an image at all, just text bytes"), "image/png", DEFAULT_IMAGE_LIMITS)).rejects.toThrow(/unsupported or unreadable image, and the image processor is unavailable/);
  });

  it("a structural failure is warned about once and remembered: the loader is not called again", async () => {
    const spy = quiet();
    const load = vi.fn(async () => { throw new TypeError("Cannot read properties of undefined (reading 'endsWith')"); });
    const p = lazyImageProcessor(load);
    for (let i = 0; i < 3; i++) await p.prepare(solidPng(8, 8), "image/png", DEFAULT_IMAGE_LIMITS);
    expect(load).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(p.prepare(solidPng(2880, 1800), "image/png", DEFAULT_IMAGE_LIMITS)).rejects.toThrow(/too large to process here/);
  });

  it("a transient failure keeps retrying", async () => {
    quiet();
    const load = vi.fn(async () => { throw new Error("EAGAIN try again"); });
    const p = lazyImageProcessor(load);
    await p.prepare(solidPng(8, 8), "image/png", DEFAULT_IMAGE_LIMITS);
    await p.prepare(solidPng(8, 8), "image/png", DEFAULT_IMAGE_LIMITS);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("headerSize", () => {
  const webp = (kind: string, len = 40) => {
    const b = Buffer.alloc(len);
    b.write("RIFF", 0); b.write("WEBP", 8); b.write(kind, 12);
    return b;
  };
  it("reads PNG and rejects a wrong signature or truncation", () => {
    const png = solidPng(30, 20);
    expect(headerSize(png, "image/png")).toEqual({ width: 30, height: 20 });
    expect(headerSize(Buffer.concat([Buffer.from("XXXX"), png.subarray(4)]), "image/png")).toBeUndefined();
    expect(headerSize(png.subarray(0, 20), "image/png")).toBeUndefined();
  });
  it("GIF needs its magic", () => {
    const gif = Buffer.alloc(16);
    gif.write("GIF89a", 0); gif.writeUInt16LE(5, 6); gif.writeUInt16LE(7, 8);
    expect(headerSize(gif, "image/gif")).toEqual({ width: 5, height: 7 });
    gif.write("JUNK89", 0);
    expect(headerSize(gif, "image/gif")).toBeUndefined();
  });
  it("WebP VP8X needs RIFF/WEBP and at least 30 bytes", () => {
    const x = webp("VP8X");
    x[24] = 99; x[27] = 49; // width 100, height 50
    expect(headerSize(x, "image/webp")).toEqual({ width: 100, height: 50 });
    expect(headerSize(x.subarray(0, 29), "image/webp")).toBeUndefined();
    x.write("RIFX", 0);
    expect(headerSize(x, "image/webp")).toBeUndefined();
    expect(headerSize(Buffer.alloc(64, 7), "image/webp")).toBeUndefined();
  });
  it("JPEG without SOI or with a garbage segment is undefined", () => {
    expect(headerSize(Buffer.alloc(32, 1), "image/jpeg")).toBeUndefined();
    expect(headerSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]), "image/jpeg")).toBeUndefined();
  });
});

/** A `wolfpack` on PATH that supports `test` (a temp dir; the real PATH is never consulted). */
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "wolfpack-shim-"));
  writeFileSync(join(dir, "wolfpack"), "#!/bin/sh\n[ \"$1 $2\" = \"test --help\" ] && exit 0\nexit 1\n", { mode: 0o755 });
  process.env.PATH = `${dir}:${process.env.PATH}`;
});

describe("coding bash env", () => {
  it("marks the shell as an agent's (WOLFPACK_AGENT_RUN=1) in the execution env, never in process.env", async () => {
    const { prepareCodingBash } = await import("./tools.js");
    const execution = { command: "echo hi", cwd: "/tmp", env: { KEEP: "1" } as Record<string, string>, inheritEnv: true };
    const before = process.env.WOLFPACK_AGENT_RUN;
    prepareCodingBash(execution);
    expect(execution.env).toEqual({ KEEP: "1", WOLFPACK_AGENT_RUN: "1" });
    expect(process.env.WOLFPACK_AGENT_RUN).toBe(before);
  });

  it("routes a direct test run through `wolfpack test`, and leaves other commands and the bypass alone", async () => {
    const { prepareCodingBash } = await import("./tools.js");
    const ex = (command: string, env: Record<string, string> = {}) => ({ command, cwd: "/tmp", env, inheritEnv: true });
    const a = ex("cd packages/cli && pnpm exec vitest run src/pm.test.ts");
    prepareCodingBash(a);
    expect(a.command).toMatch(/routed through the test queue.*; cd packages\/cli && wolfpack test run src\/pm\.test\.ts$/);
    const b = ex("pnpm run build");
    prepareCodingBash(b);
    expect(b.command).toBe("pnpm run build");
    const c = ex("pnpm exec vitest run x.test.ts", { WOLFPACK_TEST_BYPASS: "1" });
    prepareCodingBash(c);
    expect(c.command).toBe("pnpm exec vitest run x.test.ts");
  });

  const withGhEnv = async (fn: () => void | Promise<void>) => {
    const saved = { ...process.env };
    Object.assign(process.env, { GH_TOKEN: "t1", GITHUB_TOKEN: "t2", GH_ENTERPRISE_TOKEN: "t3", GITHUB_PAT_X: "t4", SSH_AUTH_SOCK: "/tmp/agent.sock", KEEP_ME: "yes" });
    try {
      await fn();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };
  const ex = (command: string) => ({ command, cwd: "/tmp", env: {} as Record<string, string>, inheritEnv: true });

  it("leaves the main wolf's shell untouched", async () => {
    const { prepareCodingBash } = await import("./tools.js");
    await withGhEnv(() => {
      const main = ex("gh pr create");
      prepareCodingBash(main, { conversationId: 900 });
      expect(main.inheritEnv).toBe(true);
      expect(main.env.GH_TOKEN).toBeUndefined();
      expect(main.command).toBe("gh pr create");
    });
  });

  it("strips GitHub and ssh credentials from a subagent shell, makes ssh fail, and holds it to the git lockdown", async () => {
    const { prepareCodingBash } = await import("./tools.js");
    const { markSubagentConversation } = await import("./fence.js");
    await withGhEnv(() => {
      markSubagentConversation(901);
      const sub = ex("git status");
      prepareCodingBash(sub, { conversationId: 901 });
      expect(sub.inheritEnv).toBe(false);
      expect(sub.env).toMatchObject({ KEEP_ME: "yes", WOLFPACK_AGENT_RUN: "1", GIT_SSH_COMMAND: "false", GIT_TERMINAL_PROMPT: "0" });
      for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_PAT_X", "SSH_AUTH_SOCK"]) expect(sub.env[k], k).toBeUndefined();
      expect(readdirSync(sub.env.GH_CONFIG_DIR!)).toEqual([]);
      expect(() => prepareCodingBash(ex("gh pr create"), { conversationId: 901 })).toThrow(/Blocked by bash/);
      expect(() => prepareCodingBash(ex("git push"), { conversationId: 901 })).toThrow(/Blocked by bash/);
    });
  });

  it("stops holding a conversation to the lockdown once it is unmarked", async () => {
    const { prepareCodingBash } = await import("./tools.js");
    const { markSubagentConversation, unmarkSubagentConversation } = await import("./fence.js");
    markSubagentConversation(902);
    expect(() => prepareCodingBash(ex("git push"), { conversationId: 902 })).toThrow(/Blocked by bash/);
    unmarkSubagentConversation(902);
    expect(() => prepareCodingBash(ex("git push"), { conversationId: 902 })).not.toThrow();
  });

  it("lets a conflict-resolve worker run the rebase its brief tells it to", async () => {
    const { checkWorkerCommand } = await import("@wolfpack/agents");
    const { conflictBrief } = await import("../wolfd/subagent-merge.js");
    const brief = conflictBrief({ path: "/w/child", branch: "feat/x-child" } as never, { path: "/w/feat", branch: "feat/x" } as never);
    const cmd = /`(git rebase [^`]+)`/.exec(brief)?.[1];
    expect(cmd).toBe("git rebase feat/x");
    expect(checkWorkerCommand(cmd!)).toBeNull();
  });
});
