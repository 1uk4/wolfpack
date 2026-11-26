/**
 * The read fence: a fence given `readRoots` limits read/ls/grep/find to its root plus those roots (realpaths, so a symlink
 * cannot leave), and a root that would widen to a protected path is dropped. Seam: the exported fence functions and the tool wrapper.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fenceReadTool, fenceRoot, readViolation, safeReadRoots, unfenceRoot } from "./fence.js";

let base: string;
let frames: string;
let repo: string;
let kb: string;
let secrets: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "fence-read-")));
  frames = join(base, "home", "frames");
  repo = join(base, "repo");
  kb = join(base, "kb", "domains");
  secrets = join(base, "home", ".wolfpack");
  for (const d of [frames, repo, kb, secrets]) mkdirSync(d, { recursive: true });
  writeFileSync(join(secrets, "keys.env"), "KEY=1");
  writeFileSync(join(base, "home", "wolf.yaml"), "name: x");
  fenceRoot(frames, [], { readRoots: [repo, kb] });
});
afterEach(() => {
  unfenceRoot(frames);
  rmSync(base, { recursive: true, force: true });
});

describe("read fence", () => {
  it("refuses the wolf's secrets and config, and a symlink inside an allowed root that points out of it", () => {
    symlinkSync(secrets, join(repo, "link"));
    for (const p of [join(secrets, "keys.env"), join(base, "home", "wolf.yaml"), join(repo, "link", "keys.env"), "../wolf.yaml", "~/.ssh/id_ed25519"]) {
      expect(readViolation(frames, p), p).toMatch(/^Refused: .* outside what you may read/);
    }
  });

  it("allows files in the frames dir, the repo and the KB mirror, and no path at all", () => {
    for (const p of ["a.html", join(frames, "a.html"), join(repo, "src", "x.ts"), join(kb, "personal", "entries", "e.md")]) {
      expect(readViolation(frames, p), p).toBeUndefined();
    }
  });

  it("is inert for a fence without readRoots (a worker's)", () => {
    const worker = join(base, "worker");
    mkdirSync(worker);
    fenceRoot(worker);
    expect(readViolation(worker, join(secrets, "keys.env"))).toBeUndefined();
    unfenceRoot(worker);
  });

  it("wraps a tool: a refused path never reaches it", async () => {
    let ran = 0;
    const tool = fenceReadTool({ name: "read", execute: () => void ran++ } as never as { name: string; execute: (a: never, b: never, c: never) => unknown });
    const call = (path: string) => (tool.execute as (a: unknown, b: unknown, c: unknown) => unknown)({ path }, { env: { cwd: frames } }, {});
    expect(() => call(join(secrets, "keys.env"))).toThrow(/Refused/);
    expect(ran).toBe(0);
    call(join(repo, "ok.ts"));
    expect(ran).toBe(1);
  });

  it("drops a read root that is, or contains, the wolf home or $HOME", () => {
    const dropped: string[] = [];
    const kept = safeReadRoots([repo, join(base, "home"), base, undefined], [join(base, "home")], (r) => dropped.push(r));
    expect(kept).toEqual([repo]);
    expect(dropped).toEqual([join(base, "home"), base]);
  });
});
