/**
 * GET /v1/wolves/:name/frame-file on a real wolf (startTestWolf): serves .html files from `<wolf home>/frames` and refuses
 * everything else (traversal, absolute, symlink escape, dotfiles, other extensions, oversize, missing).
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError, ProtocolError } from "@wolfpack/client";
import { fenceRoot, readViolation, unfenceRoot } from "../engine/fence.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

const boot = async () => {
  tw = await startTestWolf({ script: [] });
  mkdirSync(join(tw.root, "frames", "sub"), { recursive: true });
  return tw;
};
const get = (w: TestWolf, path: string) => w.client.getFrameFile!(w.home.split("/")[0]!, path);
const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as ProtocolError | undefined)?.code;

describe("frame-file route", () => {
  it("serves an html file under the frames directory as text/html", async () => {
    const w = await boot();
    writeFileSync(join(w.root, "frames", "sub", "a.HTML"), "<p>hi</p>");
    const r = await get(w, "sub/a.HTML");
    expect(new TextDecoder().decode(r.bytes)).toBe("<p>hi</p>");
    expect(r.mimeType).toBe("text/html; charset=utf-8");
  });

  it("sends the CSP sandbox header, so a frame opened directly is never a same-origin page", async () => {
    const w = await boot();
    writeFileSync(join(w.root, "frames", "a.html"), "<p>hi</p>");
    const res = await fetch(`${w.url}/v1/wolves/${w.home.split("/")[0]}/frame-file?path=a.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("fences the visualizer's reads (frames dir) to its roots, and leaves a worker's worktree fence unlimited", async () => {
    const w = await boot();
    const frames = join(w.root, "frames");
    expect(readViolation(frames, join(w.root, "wolf.yaml"))).toMatch(/^Refused: /);
    expect(readViolation(frames, join(w.root, "models.json"))).toMatch(/^Refused: /);
    expect(readViolation(frames, join(w.root, "work", "src.ts"))).toBeUndefined(); // the wolf's workspace
    const worker = mkdtempSync(join(tmpdir(), "worker-wt-"));
    fenceRoot(worker);
    expect(readViolation(worker, join(w.root, "wolf.yaml"))).toBeUndefined();
    unfenceRoot(worker);
  });

  it("refuses traversal and absolute paths with 400", async () => {
    const w = await boot();
    writeFileSync(join(w.root, "secret.html"), "x");
    expect(await code(get(w, "../secret.html"))).toBe("invalid_request");
    expect(await code(get(w, "sub/../../secret.html"))).toBe("invalid_request");
    expect(await code(get(w, join(w.root, "secret.html")))).toBe("invalid_request");
  });

  it("refuses a symlinked file and a symlinked directory that leave the root with 403", async () => {
    const w = await boot();
    const outside = mkdtempSync(join(tmpdir(), "frame-outside-"));
    writeFileSync(join(outside, "o.html"), "outside");
    symlinkSync(join(outside, "o.html"), join(w.root, "frames", "link.html"));
    symlinkSync(outside, join(w.root, "frames", "linkdir"));
    expect(await code(get(w, "link.html"))).toBe("forbidden");
    expect(await code(get(w, "linkdir/o.html"))).toBe("forbidden");
  });

  it("refuses dotfiles and dot-directories with 403", async () => {
    const w = await boot();
    mkdirSync(join(w.root, "frames", ".git"));
    writeFileSync(join(w.root, "frames", ".git", "x.html"), "x");
    writeFileSync(join(w.root, "frames", ".env.html"), "x");
    expect(await code(get(w, ".git/x.html"))).toBe("forbidden");
    expect(await code(get(w, ".env.html"))).toBe("forbidden");
  });

  it("refuses other extensions with 400, a directory with 403 and oversize files with 413", async () => {
    const w = await boot();
    writeFileSync(join(w.root, "frames", "n.txt"), "x");
    writeFileSync(join(w.root, "frames", "big.html"), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
    mkdirSync(join(w.root, "frames", "d.html"));
    expect(await code(get(w, "n.txt"))).toBe("invalid_request");
    expect(await code(get(w, "big.html"))).toBe("too_large");
    expect(await code(get(w, "d.html"))).toBe("forbidden");
  });

  it("answers 404 for a missing file", async () => {
    const w = await boot();
    await expect(get(w, "gone.html")).rejects.toBeInstanceOf(NotFoundError);
  });
});
