import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertNotHubMirror, findHubMirror, workerdMirrorDir } from "./mirror-guard.js";
import { commitWorkItem } from "../client/work-store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "mg-"));
const withState = (dir: string) => { mkdirSync(join(dir, ".sync"), { recursive: true }); writeFileSync(join(dir, ".sync", "d.json"), JSON.stringify({ v: 1, epoch: "e1", rev: 3, active: true })); };

describe("hub mirror guard", () => {
  it("refuses a write under the configured mirror dir (even not yet existing)", () => {
    const cfg = tmp(); mkdirSync(join(cfg, "kb-mirror"));
    expect(() => assertNotHubMirror(join(cfg, "kb-mirror", "domains", "d", "work"), { WORKERD_CONFIG_DIR: cfg })).toThrow(/read-only hub KB mirror.*via the hub/);
  });
  it("honours WORKERD_KB_MIRROR, expands ~, and requires an absolute path", () => {
    expect(workerdMirrorDir({ WORKERD_KB_MIRROR: "~/m" })).toBe(join(homedir(), "m"));
    expect(() => workerdMirrorDir({ WORKERD_KB_MIRROR: "rel/m" })).toThrow(/absolute/);
    const m = tmp();
    expect(() => assertNotHubMirror(join(m, "x"), { WORKERD_KB_MIRROR: m })).toThrow();
  });
  it("refuses via a symlink", () => {
    const cfg = tmp(); mkdirSync(join(cfg, "kb-mirror"));
    const link = join(tmp(), "link"); symlinkSync(join(cfg, "kb-mirror"), link);
    expect(() => assertNotHubMirror(join(link, "x"), { WORKERD_CONFIG_DIR: cfg })).toThrow();
  });
  it("refuses via a dangling symlink into the mirror", () => {
    const cfg = tmp(); // kb-mirror does not exist yet
    const link = join(tmp(), "dangling"); symlinkSync(join(cfg, "kb-mirror", "domains"), link);
    expect(() => assertNotHubMirror(join(link, "d", "work"), { WORKERD_CONFIG_DIR: cfg })).toThrow();
  });
  it.skipIf(process.platform !== "darwin")("compares case-insensitively on darwin", () => {
    const cfg = tmp(); mkdirSync(join(cfg, "kb-mirror"));
    expect(() => assertNotHubMirror(join(cfg, "KB-Mirror", "x"), { WORKERD_CONFIG_DIR: cfg })).toThrow();
  });
  it("blocks under a dir with workerd sync state", () => {
    const other = tmp(); withState(other);
    expect(findHubMirror(join(other, "domains", "d"), { WORKERD_CONFIG_DIR: tmp() })).toBeTruthy();
  });
  it("a .sync ancestor without workerd state does NOT block", () => {
    const other = tmp(); mkdirSync(join(other, ".sync"));
    writeFileSync(join(other, ".sync", "x.json"), JSON.stringify({ unrelated: true }));
    writeFileSync(join(other, ".sync", "IgnoreList"), "junk");
    expect(() => assertNotHubMirror(join(other, "domains", "d"), { WORKERD_CONFIG_DIR: tmp() })).not.toThrow();
  });
  it("WOLFPACK_KB_WRITER=1 opts out", () => {
    const cfg = tmp();
    expect(() => assertNotHubMirror(join(cfg, "kb-mirror", "x"), { WORKERD_CONFIG_DIR: cfg, WOLFPACK_KB_WRITER: "1" })).not.toThrow();
  });
  it("allows a write elsewhere", () => {
    expect(() => assertNotHubMirror(join(tmp(), "domains", "d"), { WORKERD_CONFIG_DIR: tmp() })).not.toThrow();
  });
  it("commitWorkItem throws under the mirror and writes nothing", () => {
    const cfg = tmp(); const old = process.env.WORKERD_CONFIG_DIR; process.env.WORKERD_CONFIG_DIR = cfg;
    try {
      const kbBase = join(cfg, "kb-mirror");
      expect(() => commitWorkItem({ kbBase, opsRoot: kbBase, denLocal: kbBase } as any, { id: "work-d-1", domain: "d", kind: "task", title: "t", log: [] } as any, "b")).toThrow(/hub KB mirror/);
      expect(() => readdirSyncSafe(join(kbBase, "domains"))).not.toThrow();
    } finally { if (old === undefined) delete process.env.WORKERD_CONFIG_DIR; else process.env.WORKERD_CONFIG_DIR = old; }
  });
});
import { existsSync } from "node:fs";
function readdirSyncSafe(p: string) { if (existsSync(p)) throw new Error("written"); }
