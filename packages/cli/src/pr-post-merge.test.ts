import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePostMergeArgs, prPostMerge, type PostMergeDeps } from "./pr-post-merge.js";
import { PrRefusal, type CmdResult } from "./pr-prepare.js";

const ok = (out = ""): CmdResult => ({ code: 0, out, err: "" });
const no = (code = 1, err = ""): CmdResult => ({ code, out: "", err });

interface Wt {
  path: string;
  branch?: string;
  /** `git status --porcelain` lines. */
  status?: string[];
  locked?: boolean;
}
interface Over {
  worktrees?: Wt[];
  /** Branch tips by name (refs/heads/ left off). */
  tips?: Record<string, string>;
  /** "a>b" means commit a is an ancestor of commit b. */
  ancestors?: string[];
  archives?: Record<string, string>;
  current?: string;
  fetchFails?: boolean;
  buildFails?: boolean;
  branchDeleteFails?: string[];
  /** Symlinked path -> real path (what fs.realpathSync would answer). */
  links?: Record<string, string>;
  /** `git reflog show` per branch, newest first; the last entry is where the branch was created. Default: one own commit. */
  reflogs?: Record<string, string[]>;
  /** Lines of `git rev-list --merges --parents origin/stable`. */
  merges?: string[];
  /** The branch the current worktree's HEAD is on, when the current path is not in the worktree list. */
  currentBranch?: string;
}

const MAIN = "/repo/main";
const STABLE = "/repo/stable";
const WOLF = "/repo/wolf";
const FEAT = "/repo/feat-a";

/** A repo after the owner merged: stable moved to s2 (a merge commit); wolf/1uk4 is at s1, feat/a at f1 (both inside s2). */
function base(over: Over = {}): Over {
  return {
    worktrees: [{ path: MAIN }, { path: STABLE, branch: "stable" }, { path: WOLF, branch: "wolf/1uk4" }, { path: FEAT, branch: "feat/a" }],
    tips: { stable: "s1", "wolf/1uk4": "s1", "feat/a": "f1", "origin/stable": "s2" },
    ancestors: ["s1>s2", "f1>s2", "f1>s1"],
    current: WOLF,
    ...over,
  };
}

function fakes(over: Over = {}) {
  const o = base(over);
  const tips = { ...o.tips! };
  const archives = { ...(o.archives ?? {}) };
  const calls: { args: string[]; cwd: string }[] = [];
  const builds: string[] = [];
  const out: string[] = [];
  const removed: string[] = [];
  const deleted: string[] = [];
  const sha = (name: string) => tips[name] ?? name;
  const deps: PostMergeDeps = {
    git(args, cwd = o.current!) {
      calls.push({ args, cwd });
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return ok(`${o.current}\n`);
      if (key === "symbolic-ref --short -q HEAD") {
        const here = o.worktrees!.find((w) => (o.links?.[o.current!] ?? o.current) === (o.links?.[w.path] ?? w.path));
        const b = here ? here.branch : o.currentBranch;
        return b ? ok(`${b}\n`) : no(1);
      }
      if (args[0] === "reflog" && args[1] === "show") {
        const b = args[args.length - 1]!.replace("refs/heads/", "");
        // Entries are "sha" or "sha|subject"; a bare sha is a commit, except the last one, which is the creation.
        const raw = o.reflogs?.[b] ?? [tips[b] ?? "", "base0"];
        return ok(raw.map((e, i) => (e.includes("|") ? e.replace("|", "\t") : `${e}\t${i === raw.length - 1 ? "branch: Created from HEAD" : "commit: work"}`)).join("\n") + "\n");
      }
      if (key === "rev-list --merges --parents refs/remotes/origin/stable") return ok((o.merges ?? []).join("\n") + "\n");
      if (args[0] === "fetch") return o.fetchFails ? no(1, "fatal: unable to access") : ok();
      if (args[0] === "rev-parse" && args[1] === "--verify" && args.includes("refs/remotes/origin/stable^{commit}")) return ok(`${tips["origin/stable"]}\n`);
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[3]?.startsWith("refs/archive/")) {
        const a = archives[args[3].slice("refs/archive/".length)];
        return a ? ok(`${a}\n`) : no(1);
      }
      if (key === "worktree list --porcelain") {
        return ok(
          o.worktrees!
            .map((w) => [`worktree ${w.path}`, `HEAD ${w.branch ? sha(w.branch) : "m0"}`, w.branch ? `branch refs/heads/${w.branch}` : "detached", ...(w.locked ? ["locked"] : [])].join("\n"))
            .join("\n\n") + "\n",
        );
      }
      if (args[0] === "for-each-ref") {
        return ok(Object.entries(tips).filter(([n]) => n !== "origin/stable").map(([n, s]) => `${n}\t${s}`).join("\n") + "\n");
      }
      if (args[0] === "status") return ok((o.worktrees!.find((w) => w.path === cwd)?.status ?? []).join("\n"));
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        const [a, b] = [sha(args[2]!), sha(args[3]!)];
        return a === b || o.ancestors!.includes(`${a}>${b}`) ? ok() : no(1);
      }
      if (args[0] === "merge" && args[1] === "--ff-only") {
        const w = o.worktrees!.find((x) => x.path === cwd)!;
        tips[w.branch!] = tips["origin/stable"]!;
        return ok();
      }
      if (args[0] === "update-ref") {
        archives[args[1]!.slice("refs/archive/".length)] = args[2]!;
        return ok();
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        removed.push(args[2]!);
        return ok();
      }
      if (args[0] === "branch" && args[1] === "-d") {
        if (o.branchDeleteFails?.includes(args[2]!)) return no(1, `error: the branch '${args[2]}' is not fully merged`);
        deleted.push(args[2]!);
        delete tips[args[2]!];
        return ok(`Deleted branch ${args[2]}\n`);
      }
      return ok();
    },
    build(cwd) {
      builds.push(cwd);
      return o.buildFails ? no(1, "tsc error") : ok();
    },
    realpath: (p) => o.links?.[p] ?? p,
    log: (l) => out.push(l),
  };
  return { deps, calls, builds, out, removed, deleted, archives, tips };
}
type Fakes = ReturnType<typeof fakes>;
const cmds = (f: Fakes) => f.calls.map((c) => `git ${c.args.join(" ")}`);
const MUTATING = /^git (merge |update-ref|worktree remove|branch |push|rebase|reset|checkout|commit)/;
const mutations = (f: Fakes) => cmds(f).filter((c) => MUTATING.test(c));

describe("wolfpack pr post-merge: arguments", () => {
  it("accepts only --dry-run and --apply, and the command words anywhere", () => {
    expect(parsePostMergeArgs(["pr", "post-merge"])).toEqual({ apply: false, dryRun: false });
    expect(parsePostMergeArgs(["pr", "post-merge", "--apply"])).toEqual({ apply: true, dryRun: false });
    expect(parsePostMergeArgs(["--dry-run", "pr", "post-merge"])).toEqual({ apply: false, dryRun: true });
  });

  it("refuses unknown arguments, naming them, and --apply together with --dry-run", () => {
    expect(() => parsePostMergeArgs(["pr", "post-merge", "--force"])).toThrow(/unknown argument "--force"/);
    expect(() => parsePostMergeArgs(["pr", "post-merge", "stable"])).toThrow(PrRefusal);
    expect(() => parsePostMergeArgs(["pr", "post-merge", "--apply", "--dry-run"])).toThrow(/either/);
  });
});

describe("wolfpack pr post-merge: the plan (no --apply)", () => {
  it("fetches only the remote-tracking stable ref, changes nothing else, and prints what --apply would do", async () => {
    const f = fakes();
    await prPostMerge({}, f.deps);
    expect(cmds(f)).toContain("git fetch origin +refs/heads/stable:refs/remotes/origin/stable");
    expect(mutations(f)).toEqual([]);
    expect(f.builds).toEqual([]);
    const text = f.out.join("\n");
    expect(text).toContain(`would fast-forward stable (${STABLE})`);
    expect(text).toContain(`would fast-forward wolf/1uk4 (${WOLF})`);
    expect(text).toContain("would archive feat/a at refs/archive/feat/a");
    expect(text).toContain("would remove the worktree " + FEAT);
    expect(text).toContain("would delete the branch feat/a");
    expect(text).toContain("would build (npx turbo run build)");
    expect(text).toContain("run again with --apply");
  });

  it("--dry-run does not even fetch", async () => {
    const f = fakes();
    await prPostMerge({ dryRun: true }, f.deps);
    expect(cmds(f).some((c) => c.startsWith("git fetch"))).toBe(false);
    expect(mutations(f)).toEqual([]);
    expect(f.out.join("\n")).toContain("not fetching");
  });
});

describe("wolfpack pr post-merge: --apply", () => {
  it("fast-forwards stable and the wolf branch with --ff-only in their own worktrees, then builds each", async () => {
    const f = fakes();
    await prPostMerge({ apply: true }, f.deps);
    const ff = f.calls.filter((c) => c.args[0] === "merge");
    expect(ff.map((c) => `${c.cwd}: ${c.args.join(" ")}`)).toEqual([`${STABLE}: merge --ff-only origin/stable`, `${WOLF}: merge --ff-only origin/stable`]);
    expect(f.builds).toEqual([STABLE, WOLF]);
  });

  it("finds the worktrees from git worktree list, not from assumed paths", async () => {
    const f = fakes({ worktrees: [{ path: MAIN }, { path: "/elsewhere/odd place/s", branch: "stable" }, { path: "/x/w", branch: "wolf/1uk4" }], current: "/x/w" });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.calls.filter((c) => c.args[0] === "merge").map((c) => c.cwd)).toEqual(["/elsewhere/odd place/s", "/x/w"]);
  });

  it("skips a dirty worktree and one that has diverged, reports why, and builds only what moved", async () => {
    const f = fakes({
      worktrees: [{ path: MAIN }, { path: STABLE, branch: "stable", status: [" M README.md"] }, { path: WOLF, branch: "wolf/1uk4" }, { path: FEAT, branch: "feat/a" }],
      tips: { stable: "s1", "wolf/1uk4": "w9", "feat/a": "f1", "origin/stable": "s2" },
      ancestors: ["s1>s2", "f1>s2"],
    });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.calls.some((c) => c.args[0] === "merge")).toBe(false);
    expect(f.builds).toEqual([]);
    const text = f.out.join("\n");
    expect(text).toContain(`skipped stable (${STABLE}): it has uncommitted changes`);
    expect(text).toContain(`skipped wolf/1uk4 (${WOLF}): it has diverged from origin/stable (cannot fast-forward)`);
  });

  it("does not count the console's generated next-env.d.ts as a dirty tree", async () => {
    const f = fakes({ worktrees: [{ path: MAIN }, { path: STABLE, branch: "stable", status: [" M apps/console/next-env.d.ts"] }] });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.calls.filter((c) => c.args[0] === "merge").map((c) => c.cwd)).toEqual([STABLE]);
  });

  it("says a worktree is already up to date, or ahead of origin/stable, and leaves it alone", async () => {
    const f = fakes({ tips: { stable: "s2", "wolf/1uk4": "w9", "feat/a": "f1", "origin/stable": "s2" }, ancestors: ["f1>s2", "s2>w9"] });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.calls.some((c) => c.args[0] === "merge")).toBe(false);
    const text = f.out.join("\n");
    expect(text).toContain("stable is already up to date");
    expect(text).toContain("wolf/1uk4 is ahead of origin/stable; nothing to do");
  });

  it("archives a merged feature branch at refs/archive/<branch>, removes its clean worktree and deletes the branch with -d", async () => {
    const f = fakes();
    await prPostMerge({ apply: true }, f.deps);
    expect(f.archives["feat/a"]).toBe("f1");
    expect(f.removed).toEqual([FEAT]);
    expect(f.deleted).toEqual(["feat/a"]);
    const c = cmds(f);
    expect(c).toContain("git update-ref refs/archive/feat/a f1 ");
    expect(c.indexOf("git update-ref refs/archive/feat/a f1 ")).toBeLessThan(c.indexOf(`git worktree remove ${FEAT}`));
    expect(c.indexOf(`git worktree remove ${FEAT}`)).toBeLessThan(c.indexOf("git branch -d feat/a"));
  });

  it("never touches a feature branch that is not fully in origin/stable", async () => {
    const f = fakes({ tips: { stable: "s1", "wolf/1uk4": "s1", "feat/a": "f1", "feat/b": "f7", "origin/stable": "s2" } , worktrees: [{ path: MAIN }, { path: STABLE, branch: "stable" }, { path: WOLF, branch: "wolf/1uk4" }, { path: FEAT, branch: "feat/a" }, { path: "/repo/feat-b", branch: "feat/b" }] });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.archives["feat/b"]).toBeUndefined();
    expect(f.removed).not.toContain("/repo/feat-b");
    expect(f.deleted).not.toContain("feat/b");
    expect(f.out.join("\n")).toContain("feat/b: not in origin/stable yet; left alone");
  });

  it("reports, and does not overwrite, an archive ref that already points elsewhere; the branch is kept", async () => {
    const f = fakes({ archives: { "feat/a": "old9" } });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.archives["feat/a"]).toBe("old9");
    expect(cmds(f).some((c) => c.startsWith("git update-ref"))).toBe(false);
    expect(f.removed).toEqual([]);
    expect(f.deleted).toEqual([]);
    expect(f.out.join("\n")).toContain("refs/archive/feat/a already points at old9, not f1; kept the branch and its worktree");
  });

  it("is happy with an archive ref that already points at the tip, and still cleans up", async () => {
    const f = fakes({ archives: { "feat/a": "f1" } });
    await prPostMerge({ apply: true }, f.deps);
    expect(cmds(f).some((c) => c.startsWith("git update-ref"))).toBe(false);
    expect(f.deleted).toEqual(["feat/a"]);
  });

  it("keeps a dirty feature worktree and its branch, but still archives the tip", async () => {
    const f = fakes({ worktrees: [{ path: MAIN }, { path: STABLE, branch: "stable" }, { path: WOLF, branch: "wolf/1uk4" }, { path: FEAT, branch: "feat/a", status: ["?? scratch.txt"] }] });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.archives["feat/a"]).toBe("f1");
    expect(f.removed).toEqual([]);
    expect(f.deleted).toEqual([]);
    expect(f.out.join("\n")).toContain(`kept the worktree ${FEAT}: it has uncommitted changes`);
  });

  it("never removes the current worktree or the main checkout, even when their branch is merged", async () => {
    const f = fakes({
      worktrees: [{ path: MAIN, branch: "feat/m" }, { path: STABLE, branch: "stable" }, { path: FEAT, branch: "feat/a" }],
      tips: { stable: "s1", "feat/a": "f1", "feat/m": "m1", "origin/stable": "s2" },
      ancestors: ["s1>s2", "f1>s2", "m1>s2"],
      current: FEAT,
    });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.removed).toEqual([]);
    expect(f.deleted).toEqual([]);
    expect(f.out.join("\n")).toContain("the current worktree");
    expect(f.out.join("\n")).toContain("the main checkout");
  });

  it("fast-forwards only stable and the current wolf's branch: another wolf's worktree is left alone and not built", async () => {
    const OTHER = "/repo/other-wolf";
    const f = fakes({
      worktrees: [{ path: MAIN }, { path: STABLE, branch: "stable" }, { path: WOLF, branch: "wolf/1uk4" }, { path: OTHER, branch: "wolf/other" }, { path: FEAT, branch: "feat/a" }],
      tips: { stable: "s1", "wolf/1uk4": "s1", "wolf/other": "o1", "feat/a": "f1", "origin/stable": "s2" },
      ancestors: ["s1>s2", "o1>s2", "f1>s2", "f1>s1"],
    });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.calls.filter((c) => c.args[0] === "merge").map((c) => c.cwd)).toEqual([STABLE, WOLF]);
    expect(f.builds).toEqual([STABLE, WOLF]);
    expect(f.tips["wolf/other"]).toBe("o1");
    expect(f.out.join("\n")).toContain(`left alone wolf/other (${OTHER}): it is not the current wolf's branch`);
  });

  it("from a feat worktree it fast-forwards only stable and says the wolf branch was not touched", async () => {
    const f = fakes({ current: FEAT });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.calls.filter((c) => c.args[0] === "merge").map((c) => c.cwd)).toEqual([STABLE]);
    expect(f.builds).toEqual([STABLE]);
    expect(f.out.join("\n")).toContain("the wolf branch was not touched: this worktree is on feat/a, not on a wolf/<name> branch");
  });

  it("from a detached HEAD it also moves only stable and says so", async () => {
    const f = fakes({ worktrees: [{ path: MAIN }, { path: STABLE, branch: "stable" }, { path: WOLF, branch: "wolf/1uk4" }], current: "/repo/detached" });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.calls.filter((c) => c.args[0] === "merge").map((c) => c.cwd)).toEqual([STABLE]);
    expect(f.out.join("\n")).toContain("not on a wolf/<name> branch (detached HEAD)");
  });

  it("compares worktree paths by real path: a symlinked current path is still the current worktree", async () => {
    const f = fakes({ current: "/links/feat-a", links: { "/links/feat-a": FEAT } });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.removed).toEqual([]);
    expect(f.deleted).toEqual([]);
    expect(f.out.join("\n")).toContain("it is the current worktree");
  });

  it("never touches a worktree whose branch is the one the current HEAD is on, even at a path it cannot match", async () => {
    const f = fakes({ current: "/somewhere/else", currentBranch: "feat/a" });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.removed).toEqual([]);
    expect(f.deleted).toEqual([]);
  });

  it("knows the main checkout by real path: it is listed under a symlinked path and is still never removed", async () => {
    const f = fakes({
      worktrees: [{ path: "/links/main", branch: "feat/m" }, { path: STABLE, branch: "stable" }, { path: WOLF, branch: "wolf/1uk4" }],
      tips: { stable: "s1", "wolf/1uk4": "s1", "feat/m": "m1", "origin/stable": "s2" },
      ancestors: ["s1>s2", "m1>s2", "m1>s1"],
      links: { "/links/main": "/repo/real-main" },
      current: WOLF,
    });
    // The main checkout's real path differs from the listed one; it must still be recognised as the main checkout.
    await prPostMerge({ apply: true }, f.deps);
    expect(f.removed).toEqual([]);
    expect(f.out.join("\n")).toContain("it is the main checkout");
  });

  it("says 'ahead' not 'diverged' and moves nothing when stable is merely ahead of origin/stable", async () => {
    const f = fakes({ tips: { stable: "s3", "wolf/1uk4": "s3", "feat/a": "f1", "origin/stable": "s2" }, ancestors: ["s2>s3", "f1>s2", "f1>s3"] });
    await prPostMerge({ apply: true }, f.deps);
    const text = f.out.join("\n");
    expect(text).toContain("stable is ahead of origin/stable; nothing to do");
    expect(text).not.toContain("diverged");
    expect(f.calls.some((c) => c.args[0] === "merge")).toBe(false);
  });

  it("cleans up a branch when its tip is the second parent of a merge reachable from origin/stable, even with no reflog", async () => {
    const f = fakes({ reflogs: { "feat/a": [] }, merges: ["s2 s1 f1"] });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.deleted).toEqual(["feat/a"]);
  });

  it("does not count the first parent of a merge as proof", async () => {
    const f = fakes({ reflogs: { "feat/a": [] }, merges: ["s2 f1 w1"] });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.deleted).toEqual([]);
    expect(f.archives["feat/a"]).toBeUndefined();
    expect(f.out.join("\n")).toContain("feat/a: can't prove it was merged; left alone");
  });

  it("cleans up a fast-forwarded branch when its reflog shows it moved from where it was created", async () => {
    const f = fakes({ reflogs: { "feat/a": ["f1", "f0", "s0"] } });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.deleted).toEqual(["feat/a"]);
  });

  it("leaves a branch alone when its reflog shows it only moved (fast-forward, reset, merge) and never had a commit", async () => {
    const f = fakes({ reflogs: { "feat/a": ["f1|merge wolf/t: Fast-forward", "x1|reset: moving to x1", "s0|branch: Created from HEAD"] }, merges: ["s2 s1 f1"] });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.deleted).toEqual([]);
    expect(f.archives["feat/a"]).toBeUndefined();
    expect(f.out.join("\n")).toContain("feat/a: can't prove it was merged; left alone");
  });

  it.each(["commit: work", "commit (merge): Merge branch 'x'", "commit (amend): work", "commit (initial): first"])("accepts a reflog entry that starts with 'commit' as proof: %s", async (subject) => {
    const f = fakes({ reflogs: { "feat/a": [`f1|${subject}`, "s0|branch: Created from HEAD"] } });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.deleted).toEqual(["feat/a"]);
  });

  it("creates no archive for the branch of the current worktree, in the plan or with --apply", async () => {
    for (const apply of [false, true]) {
      const f = fakes({ current: FEAT });
      await prPostMerge({ apply, dryRun: !apply }, f.deps);
      expect(f.archives["feat/a"], `apply=${apply}`).toBeUndefined();
      expect(f.out.join("\n")).not.toContain("archive feat/a");
      expect(f.out.join("\n")).toContain("the current worktree");
    }
  });

  it("creates no archive for the main checkout's branch, nor for the branch of the current HEAD at an unmatched path", async () => {
    const f = fakes({
      worktrees: [{ path: MAIN, branch: "feat/m" }, { path: STABLE, branch: "stable" }, { path: WOLF, branch: "wolf/1uk4" }, { path: FEAT, branch: "feat/a" }],
      tips: { stable: "s1", "wolf/1uk4": "s1", "feat/a": "f1", "feat/m": "m1", "origin/stable": "s2" },
      ancestors: ["s1>s2", "f1>s2", "m1>s2", "f1>s1", "m1>s1"],
      current: "/somewhere/else",
      currentBranch: "feat/a",
    });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.archives["feat/m"]).toBeUndefined();
    expect(f.archives["feat/a"]).toBeUndefined();
  });

  it("leaves a branch alone when its reflog shows it never left its creation point, even if a merge has its tip as a parent", async () => {
    const f = fakes({ reflogs: { "feat/a": ["f1|branch: Created from HEAD"] }, merges: ["s2 s1 f1"] });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.deleted).toEqual([]);
    expect(f.out.join("\n")).toContain("feat/a: can't prove it was merged; left alone");
  });

  it("leaves a branch alone, saying it can't prove it, when there is no reflog and no merge commit with it as a parent", async () => {
    const f = fakes({ reflogs: { "feat/a": [] } });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.deleted).toEqual([]);
    expect(f.removed).toEqual([]);
    expect(f.out.join("\n")).toContain("feat/a: can't prove it was merged; left alone");
  });

  it("skips a branch whose tip equals the tip of stable, origin/stable or any wolf branch", async () => {
    for (const same of ["stable", "wolf/1uk4", "origin/stable"]) {
      const tips: Record<string, string> = { stable: "s1", "wolf/1uk4": "w1", "feat/a": "f1", "origin/stable": "s2" };
      tips["feat/a"] = tips[same]!;
      const f = fakes({ tips, ancestors: ["s1>s2", "w1>s2", "s1>w1"] });
      await prPostMerge({ apply: true }, f.deps);
      expect(f.deleted).toEqual([]);
      expect(f.out.join("\n")).toContain("feat/a: can't prove it was merged; left alone");
    }
  });

  it("reports git's refusal to delete a branch and carries on", async () => {
    const f = fakes({ branchDeleteFails: ["feat/a"] });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.out.join("\n")).toContain("could not delete feat/a: error: the branch 'feat/a' is not fully merged");
  });

  it("uses git branch -d and never -D, push, rebase, reset, force or a merge that is not --ff-only", async () => {
    const f = fakes();
    await prPostMerge({ apply: true }, f.deps);
    const c = cmds(f);
    expect(c.some((x) => /branch -D|branch .*--force|\bpush\b|\brebase\b|\breset\b|--force|worktree remove .*-f/.test(x))).toBe(false);
    for (const m of c.filter((x) => x.startsWith("git merge "))) expect(m).toBe("git merge --ff-only origin/stable");
    expect(c.some((x) => x.startsWith("git branch -d "))).toBe(true);
  });

  it("builds only the worktrees that moved, and says when the build fails", async () => {
    const f = fakes({ buildFails: true });
    const r = await prPostMerge({ apply: true }, f.deps);
    expect(r.failed).toBe(true);
    expect(f.out.join("\n")).toContain(`build failed in ${STABLE}: tsc error`);
  });

  it("does not build when nothing fast-forwarded", async () => {
    const f = fakes({ tips: { stable: "s2", "wolf/1uk4": "s2", "feat/a": "f1", "origin/stable": "s2" } });
    await prPostMerge({ apply: true }, f.deps);
    expect(f.builds).toEqual([]);
  });

  it("refuses, changing nothing, when the fetch fails", async () => {
    const f = fakes({ fetchFails: true });
    await expect(prPostMerge({ apply: true }, f.deps)).rejects.toThrow(/git fetch failed: fatal: unable to access/);
    expect(mutations(f)).toEqual([]);
  });
});

describe("wolfpack pr post-merge: real git", () => {
  let tmp: string;
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const g = (cwd: string, ...a: string[]) => {
    const r = spawnSync("git", a, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (cwd: string, file: string) => {
    fs.writeFileSync(path.join(cwd, file), file);
    g(cwd, "add", file);
    g(cwd, "commit", "-q", "-m", file);
  };

  /** A repo with a remote, a main checkout (detached), a stable worktree and a wolf/t worktree. */
  function world() {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "postmerge-")));
    const origin = path.join(tmp, "origin.git");
    const main = path.join(tmp, "main");
    g(tmp, "init", "-q", "--bare", "-b", "stable", origin);
    g(tmp, "init", "-q", "-b", "stable", main);
    for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"]]) g(main, "config", k, v!);
    g(main, "remote", "add", "origin", origin);
    commit(main, "base.txt");
    g(main, "push", "-q", "origin", "stable");
    g(main, "branch", "wolf/t");
    g(main, "checkout", "-q", "--detach");
    const wt = (name: string, branch: string, create = false) => {
      const p = path.join(tmp, name);
      g(main, "worktree", "add", "-q", ...(create ? ["-b", branch, p, "stable"] : [p, branch]));
      return p;
    };
    const stableWt = wt("stable-wt", "stable");
    const wolfWt = wt("wolf", "wolf/t");
    /** The owner merges `wolf/t` into stable on the remote, with a merge commit. */
    const ownerMerges = () => {
      const clone = path.join(tmp, "clone");
      g(tmp, "clone", "-q", "-b", "stable", origin, clone);
      for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"]]) g(clone, "config", k, v!);
      g(wolfWt, "push", "-q", "origin", "wolf/t");
      g(clone, "fetch", "-q", "origin", "wolf/t");
      g(clone, "merge", "-q", "--no-ff", "-m", "release", "origin/wolf/t");
      g(clone, "push", "-q", "origin", "stable");
    };
    const out: string[] = [];
    const builds: string[] = [];
    /** Runs post-merge from `from` (a worktree path). */
    const run = (from: string, apply = true) => {
      const deps: PostMergeDeps = {
        git: (args, cwd = from) => {
          const r = spawnSync("git", args, { cwd, encoding: "utf8" });
          return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
        },
        build: (cwd) => (builds.push(cwd), { code: 0, out: "", err: "" }),
        realpath: (p) => fs.realpathSync(p),
        log: (l) => out.push(l),
      };
      return prPostMerge({ apply }, deps);
    };
    return { origin, main, stableWt, wolfWt, wt, ownerMerges, run, out, builds };
  }

  it("archives a merged feature, fast-forwards stable and the wolf branch, and removes the worktree and branch", async () => {
    const w = world();
    g(w.main, "branch", "feat/done");
    const featWt = w.wt("feat", "feat/done");
    commit(featWt, "feature.txt");
    g(w.wolfWt, "merge", "-q", "--no-ff", "-m", "merge feat", "feat/done");
    w.ownerMerges();
    const tip = g(w.main, "rev-parse", "feat/done");
    await w.run(w.wolfWt);
    expect(g(w.main, "rev-parse", "refs/archive/feat/done")).toBe(tip);
    expect(g(w.main, "rev-parse", "stable")).toBe(g(w.main, "rev-parse", "origin/stable"));
    expect(g(w.main, "rev-parse", "wolf/t")).toBe(g(w.main, "rev-parse", "origin/stable"));
    expect(fs.existsSync(featWt)).toBe(false);
    expect(g(w.main, "branch", "--list", "feat/done")).toBe("");
    expect(w.builds.sort()).toEqual([w.stableWt, w.wolfWt].sort());
    expect(g(w.origin, "rev-parse", "stable")).toBe(g(w.main, "rev-parse", "origin/stable"));
    // About 25 real git processes: over the default 5 s when the whole suite runs in parallel.
  }, 30_000);

  it("cleans up a branch that was fast-forwarded into wolf (no merge commit of its own), because its reflog shows its own commits", async () => {
    const w = world();
    g(w.main, "branch", "feat/ff");
    const featWt = w.wt("feat-ff", "feat/ff");
    commit(featWt, "ff.txt");
    g(w.wolfWt, "merge", "-q", "--ff-only", "feat/ff");
    commit(w.wolfWt, "after.txt");
    w.ownerMerges();
    await w.run(w.wolfWt);
    expect(g(w.main, "branch", "--list", "feat/ff")).toBe("");
    expect(fs.existsSync(featWt)).toBe(false);
    expect(g(w.main, "rev-parse", "--verify", "refs/archive/feat/ff")).toMatch(/^[0-9a-f]{40}$/);
  }, 30_000);

  it("leaves alone a branch that was cut, then only fast-forwarded to an older released wolf tip, with no commits of its own", async () => {
    const w = world();
    g(w.main, "branch", "feat/ffonly");
    const wt = w.wt("feat-ffonly", "feat/ffonly");
    commit(w.wolfWt, "released.txt");
    const released = g(w.wolfWt, "rev-parse", "HEAD");
    w.ownerMerges();
    commit(w.wolfWt, "later.txt"); // wolf/t has moved on, so the branch tip is not any wolf tip
    g(wt, "merge", "-q", "--ff-only", released);
    await w.run(w.wolfWt);
    expect(g(w.main, "branch", "--list", "feat/ffonly")).toContain("feat/ffonly");
    expect(fs.existsSync(wt)).toBe(true);
    expect(g(w.main, "for-each-ref", "refs/archive/")).toBe("");
    expect(w.out.join("\n")).toContain("feat/ffonly: can't prove it was merged; left alone");
  }, 30_000);

  it("leaves a zero-commit feature branch cut from stable untouched: no archive, no removal, no deletion", async () => {
    const w = world();
    g(w.main, "branch", "feat/zero");
    const zeroWt = w.wt("feat-zero", "feat/zero");
    commit(w.wolfWt, "other.txt");
    w.ownerMerges();
    await w.run(w.wolfWt);
    expect(g(w.main, "branch", "--list", "feat/zero")).toContain("feat/zero");
    expect(fs.existsSync(zeroWt)).toBe(true);
    expect(g(w.main, "for-each-ref", "refs/archive/")).toBe("");
    expect(w.out.join("\n")).toContain("feat/zero: can't prove it was merged; left alone");
  }, 30_000);

  it("leaves a zero-commit feature branch alone even when it was cut from a commit that is a merge parent in stable", async () => {
    const w = world();
    // The branch is cut from a commit that later became the second parent of a merge in origin/stable.
    commit(w.wolfWt, "x.txt");
    g(w.main, "branch", "feat/zero", "wolf/t");
    const zeroWt = w.wt("feat-zero", "feat/zero");
    commit(w.wolfWt, "y.txt");
    w.ownerMerges();
    commit(w.wolfWt, "z.txt");
    g(w.wolfWt, "fetch", "-q", "origin");
    await w.run(w.wolfWt, false);
    await w.run(w.wolfWt);
    expect(g(w.main, "branch", "--list", "feat/zero")).toContain("feat/zero");
    expect(fs.existsSync(zeroWt)).toBe(true);
  }, 30_000);

  it("keeps an archive ref that points elsewhere, and the branch and worktree with it", async () => {
    const w = world();
    g(w.main, "branch", "feat/done");
    const featWt = w.wt("feat", "feat/done");
    commit(featWt, "feature.txt");
    g(w.wolfWt, "merge", "-q", "--no-ff", "-m", "merge feat", "feat/done");
    w.ownerMerges();
    const elsewhere = g(w.main, "rev-parse", "stable");
    g(w.main, "update-ref", "refs/archive/feat/done", elsewhere);
    await w.run(w.wolfWt);
    expect(g(w.main, "rev-parse", "refs/archive/feat/done")).toBe(elsewhere);
    expect(g(w.main, "branch", "--list", "feat/done")).toContain("feat/done");
    expect(fs.existsSync(featWt)).toBe(true);
    expect(w.out.join("\n")).toContain("already points at");
  }, 30_000);

  it("run from a feat worktree, moves only stable, leaves another wolf's branch alone and builds only stable", async () => {
    const w = world();
    g(w.main, "branch", "wolf/other", "stable");
    const otherWt = w.wt("other-wolf", "wolf/other");
    g(w.main, "branch", "feat/here");
    const hereWt = w.wt("feat-here", "feat/here");
    commit(w.wolfWt, "r.txt");
    w.ownerMerges();
    const wolfBefore = g(w.main, "rev-parse", "wolf/t");
    const otherBefore = g(w.main, "rev-parse", "wolf/other");
    await w.run(hereWt);
    expect(g(w.main, "rev-parse", "stable")).toBe(g(w.main, "rev-parse", "origin/stable"));
    expect(g(w.main, "rev-parse", "wolf/t")).toBe(wolfBefore);
    expect(g(w.main, "rev-parse", "wolf/other")).toBe(otherBefore);
    expect(fs.existsSync(otherWt)).toBe(true);
    expect(w.builds).toEqual([w.stableWt]);
    expect(w.out.join("\n")).toContain("the wolf branch was not touched");
  }, 30_000);
});
