import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KB_COMPARE_NOISE, compareKb, formatReport, runKbCompare } from "./kb-compare.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "kbcmp-"));
  dirs.push(d);
  return d;
};
const put = (root: string, rel: string, body: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const FILES: Record<string, string> = {
  "entries/kb-a-1.md": "# one\n",
  "entries/kb-a-2.md": "# two\n",
  "versions/kb-a-1/2026-01-01.md": "old\n",
  "INDEX.md": "# idx\n",
  "_digest.json": "{}\n",
  "_registry.md": "reg\n",
};
/** Builds a Syncthing base and a mirror with the same domain content. */
function rig(layout: "flat" | "base" = "flat", domains = ["alpha"]) {
  const st = tmp();
  const mir = tmp();
  for (const d of domains) {
    for (const [p, b] of Object.entries(FILES)) {
      put(join(st, "domains", d), p, b);
      put(layout === "base" ? join(mir, "domains", d) : join(mir, d), p, b);
    }
    put(mir, `.sync/${d}.json`, JSON.stringify({ v: 1, epoch: "e1", rev: 7, active: true }));
  }
  return { st, mir, d: (x: string) => join(st, "domains", x), m: (x: string) => (layout === "base" ? join(mir, "domains", x) : join(mir, x)) };
}
const snapshot = (root: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) {
        out.push(`d ${p} ${s.mtimeMs}`);
        walk(p);
      } else out.push(`f ${p} ${s.mtimeMs} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return out;
};

describe("kb-compare", () => {
  it("identical trees are CLEAN, with hub revision and domains.yaml reported", () => {
    const r = rig();
    put(r.st, "domains.yaml", "domains: {}\n");
    const rep = compareKb({ syncthing: r.st, mirror: r.mir });
    expect(rep.verdict).toBe("CLEAN");
    expect(rep.domains[0]).toMatchObject({ domain: "alpha", matched: 6, hub: { epoch: "e1", rev: 7, active: true } });
    expect(rep.domainsYaml.exists).toBe(true);
    expect(rep.mirrorStateFiles).toEqual(["alpha.json"]);
  });

  it("ignores and lists noise on both sides", () => {
    const r = rig();
    const noise = [".stfolder/x", ".stignore", ".DS_Store", "entries/kb-a-1.sync-conflict-20260101-ABC.md", ".syncthing.INDEX.md.tmp", "~syncthing~INDEX.md.tmp", ".sync/x.json", "entries/.0a1b2c.tmp"];
    for (const n of noise) {
      put(r.d("alpha"), n, "junk");
      put(r.m("alpha"), n, "junk2");
    }
    const rep = compareKb({ syncthing: r.st, mirror: r.mir });
    expect(rep.verdict).toBe("CLEAN");
    expect(rep.domains[0]!.ignored.syncthing.sort()).toEqual([...noise].sort());
    expect(rep.domains[0]!.ignored.mirror).toHaveLength(noise.length);
    expect(KB_COMPARE_NOISE.length).toBeGreaterThanOrEqual(8);
  });

  it("missing file in the mirror, extra file in the mirror, and a mismatch each BLOCK", () => {
    let r = rig();
    rmSync(join(r.m("alpha"), "entries/kb-a-2.md"));
    let rep = compareKb({ syncthing: r.st, mirror: r.mir });
    expect(rep.verdict).toBe("BLOCKED");
    expect(rep.domains[0]!.onlyInSyncthing).toEqual(["entries/kb-a-2.md"]);

    r = rig();
    put(r.m("alpha"), "entries/kb-a-3.md", "extra");
    rep = compareKb({ syncthing: r.st, mirror: r.mir });
    expect(rep.verdict).toBe("BLOCKED");
    expect(rep.domains[0]!.onlyInMirror).toEqual(["entries/kb-a-3.md"]);

    r = rig();
    put(r.m("alpha"), "entries/kb-a-1.md", "# one \n");
    rep = compareKb({ syncthing: r.st, mirror: r.mir });
    expect(rep.verdict).toBe("BLOCKED");
    expect(rep.domains[0]!.mismatched.map((x) => x.path)).toEqual(["entries/kb-a-1.md"]);
  });

  it("versions/ files are compared", () => {
    const r = rig();
    put(r.m("alpha"), "versions/kb-a-1/2026-01-01.md", "changed");
    expect(compareKb({ syncthing: r.st, mirror: r.mir }).domains[0]!.mismatched.map((x) => x.path)).toEqual(["versions/kb-a-1/2026-01-01.md"]);
  });

  it("work/ files are reported as not-synced and do not block", () => {
    const r = rig();
    put(r.d("alpha"), "work/item-1.md", "w");
    put(r.d("alpha"), "work/sub/item-2.md", "w");
    put(r.m("alpha"), "work/other.md", "w");
    const rep = compareKb({ syncthing: r.st, mirror: r.mir });
    expect(rep.verdict).toBe("CLEAN");
    expect(rep.domains[0]!.notSynced.syncthing).toEqual(["work/item-1.md", "work/sub/item-2.md"]);
    expect(rep.domains[0]!.notSynced.mirror).toEqual(["work/other.md"]);
  });

  it("works with the base layout and multiple domains, honouring --domains", () => {
    const r = rig("base", ["alpha", "beta"]);
    expect(compareKb({ syncthing: r.st, mirror: r.mir, layout: "base" })).toMatchObject({ verdict: "CLEAN", domains: [{ domain: "alpha" }, { domain: "beta" }] });
    rmSync(join(r.m("beta"), "INDEX.md"));
    expect(compareKb({ syncthing: r.st, mirror: r.mir, layout: "base" }).verdict).toBe("BLOCKED");
    expect(compareKb({ syncthing: r.st, mirror: r.mir, layout: "base", domains: ["alpha"] }).verdict).toBe("CLEAN");
    // the wrong layout sees no mirror domains: everything is only-in-syncthing
    expect(compareKb({ syncthing: r.st, mirror: r.mir, layout: "flat" }).verdict).toBe("BLOCKED");
  });

  it("a domain present on one side only is BLOCKED", () => {
    const r = rig();
    mkdirSync(join(r.st, "domains", "gamma"), { recursive: true });
    put(r.d("gamma"), "INDEX.md", "x");
    const rep = compareKb({ syncthing: r.st, mirror: r.mir });
    expect(rep.verdict).toBe("BLOCKED");
    expect(rep.domains.find((d) => d.domain === "gamma")).toMatchObject({ mirrorPresent: false, onlyInSyncthing: ["INDEX.md"] });
  });

  it("modifies neither tree", () => {
    const r = rig();
    put(r.d("alpha"), "work/w.md", "w");
    put(r.m("alpha"), ".DS_Store", "x");
    put(r.m("alpha"), "entries/kb-a-1.md", "different");
    const before = [snapshot(r.st), snapshot(r.mir)];
    const json = join(tmp(), "out.json");
    expect(runKbCompare(["--syncthing", r.st, "--mirror", r.mir, "--json", json], () => {})).toBe(1);
    expect([snapshot(r.st), snapshot(r.mir)]).toEqual(before);
    expect(JSON.parse(readFileSync(json, "utf8")).verdict).toBe("BLOCKED");
  });

  it("refuses a symlinked domain root (either side)", () => {
    const r = rig();
    const real = tmp();
    rmSync(r.m("alpha"), { recursive: true });
    symlinkSync(real, r.m("alpha"));
    expect(() => compareKb({ syncthing: r.st, mirror: r.mir })).toThrow(/symlink/);
    const msgs: string[] = [];
    expect(runKbCompare(["--syncthing", r.st, "--mirror", r.mir], () => {}, (m) => msgs.push(m))).toBe(2);
    expect(msgs.join()).toMatch(/symlink/);

    const r2 = rig();
    rmSync(r2.d("alpha"), { recursive: true });
    symlinkSync(real, r2.d("alpha"));
    expect(() => compareKb({ syncthing: r2.st, mirror: r2.mir })).toThrow(/symlink/);
  });

  it("a symlink inside a tree blocks and is not followed", () => {
    const r = rig();
    symlinkSync("/etc/hosts", join(r.m("alpha"), "entries", "kb-a-9.md"));
    const rep = compareKb({ syncthing: r.st, mirror: r.mir });
    expect(rep.verdict).toBe("BLOCKED");
    expect(rep.domains[0]!.problems[0]).toMatch(/symlink/);
  });

  it("CLI exit codes: 0 clean, 1 blocked, 2 usage", () => {
    const r = rig();
    const sink = () => {};
    expect(runKbCompare(["--syncthing", r.st, "--mirror", r.mir], sink)).toBe(0);
    rmSync(join(r.m("alpha"), "INDEX.md"));
    expect(runKbCompare(["--syncthing", r.st, "--mirror", r.mir], sink)).toBe(1);
    expect(runKbCompare(["--syncthing", r.st], sink, sink)).toBe(2);
    expect(runKbCompare(["--syncthing", r.st, "--mirror", r.mir, "--layout", "x"], sink, sink)).toBe(2);
    expect(runKbCompare(["--bogus"], sink, sink)).toBe(2);
  });

  it("sample report", () => {
    const r = rig();
    put(r.d("alpha"), "work/w.md", "w");
    put(r.m("alpha"), ".DS_Store", "x");
    rmSync(join(r.m("alpha"), "entries/kb-a-2.md"));
    put(r.m("alpha"), "entries/kb-a-1.md", "different");
    const text = formatReport(compareKb({ syncthing: r.st, mirror: r.mir }));
    expect(text).toContain("VERDICT: BLOCKED");
    if (process.env.KB_COMPARE_SAMPLE) console.log(text.replaceAll(r.st, "<st>").replaceAll(r.mir, "<mirror>"));
  });
});
