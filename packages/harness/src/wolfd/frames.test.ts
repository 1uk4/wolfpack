/** readFrameFile against a hostile frames dir: a symlinked root, a FIFO in place of a file, a symlinked final component. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "./http-error.js";
import { framesRoot, readFrameFile } from "./frames.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wolf-frames-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e.code;
    throw e;
  }
  return "served";
};

describe("readFrameFile hardening", () => {
  it("refuses a frames dir that is itself a symlink", async () => {
    const target = mkdtempSync(join(tmpdir(), "wolf-frames-target-"));
    writeFileSync(join(target, "x.html"), "<p>secret</p>");
    symlinkSync(target, framesRoot(home));
    expect(await codeOf(readFrameFile(home, "x.html"))).toBe("forbidden");
    rmSync(target, { recursive: true, force: true });
  });

  it("does not hang on a FIFO named like a frame, and refuses it", async () => {
    mkdirSync(framesRoot(home), { recursive: true });
    execFileSync("mkfifo", [join(framesRoot(home), "pipe.html")]);
    expect(await codeOf(readFrameFile(home, "pipe.html"))).toBe("forbidden");
  });

  it("serves an ordinary file and 404s a missing one", async () => {
    mkdirSync(framesRoot(home), { recursive: true });
    writeFileSync(join(framesRoot(home), "ok.html"), "<p>ok</p>");
    expect((await readFrameFile(home, "ok.html")).toString()).toBe("<p>ok</p>");
    expect(await codeOf(readFrameFile(home, "gone.html"))).toBe("not_found");
  });
});
