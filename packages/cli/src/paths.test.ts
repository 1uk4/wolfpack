import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { remotePathsFrom, resolveBin } from "./paths.js";

describe("remotePathsFrom", () => {
  it("defaults match the standard VPS layout", () => {
    const p = remotePathsFrom({});
    expect(p.home("ab")).toBe("/home/wolf-ab");
    expect(p.user("ab")).toBe("wolf-ab");
    expect(p.den("ab")).toBe("/home/wolf-ab/den");
    expect(p.kbBase("ab")).toBe("/home/wolf-ab/knowledge/base");
    expect(p.librarianOps("ab")).toBe("/home/wolf-ab/librarian");
    expect(p.sharedKbBase).toBe("/var/wolfpack/kb/base");
    expect(p.sharedKbOps).toBe("/var/wolfpack/kb/ops");
    expect(p.homeGlob).toBe("/home/wolf-*");
  });
  it("honours config overrides", () => {
    const p = remotePathsFrom({ remote: { wolfHomeRoot: "/srv", wolfUserPrefix: "w-", kbRoot: "/data/kb" } });
    expect(p.home("x")).toBe("/srv/w-x");
    expect(p.sharedKbOps).toBe("/data/kb/ops");
    expect(p.homeGlob).toBe("/srv/w-*");
  });
});

describe("resolveBin", () => {
  it("finds executables via PATH then dirs, undefined otherwise", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "bin-"));
    const f = path.join(d, "tool-xyz");
    fs.writeFileSync(f, "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveBin("tool-xyz", { pathEnv: d, dirs: [] })).toBe(f);
    expect(resolveBin("tool-xyz", { pathEnv: "", dirs: [d] })).toBe(f);
    expect(resolveBin("nope-xyz", { pathEnv: d, dirs: [] })).toBeUndefined();
  });
});
