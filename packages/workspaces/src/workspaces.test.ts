import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  abandonChild, assertSlug, createChildWorkspace, createHomeChildWorkspace, defaultIsolation, ensureFeatureWorkspace, isWriter, makeTempRepo,
  mergeChild, repoOf, resolveWorkspacesRoot, WriterGuard, type RepoInfo, type TempRepo,
} from "./index.js";

let t: TempRepo;
beforeEach(() => { t = makeTempRepo("demo"); });
afterEach(() => t.cleanup());

async function setup() {
  const repo = (await repoOf(t.dir)) as RepoInfo;
  const feat = await ensureFeatureWorkspace({ root: t.root, repo, featureSlug: "f1", baseDir: t.dir });
  return { repo, feat };
}

describe("config", () => {
  it("defaults to <wolf-home>/workspaces", () => {
    expect(resolveWorkspacesRoot("/home/w")).toBe("/home/w/workspaces");
    expect(resolveWorkspacesRoot("/home/w", {})).toBe("/home/w/workspaces");
    expect(resolveWorkspacesRoot("/home/w", { workspaces: { root: "  " } })).toBe("/home/w/workspaces");
  });
  it("honours workspaces.root (absolute or relative to wolf home)", () => {
    expect(resolveWorkspacesRoot("/home/w", { workspaces: { root: "/data/ws" } })).toBe("/data/ws");
    expect(resolveWorkspacesRoot("/home/w", { workspaces: { root: "trees" } })).toBe("/home/w/trees");
    expect(resolveWorkspacesRoot("/home/w", { workspaces: { root: "~/trees" } })).toBe(join(homedir(), "trees"));
  });
});

describe("repoOf", () => {
  it("returns toplevel and name, from a subdir too", async () => {
    t.commitFile("sub/a.txt", "a");
    const r = await repoOf(join(t.dir, "sub"));
    expect(r).toMatchObject({ toplevel: t.dir, name: "demo", mainDir: t.dir });
  });
  it("is null outside git", async () => {
    const { mkdtempSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = realpathSync(mkdtempSync(join(tmpdir(), "nogit-")));
    expect(await repoOf(d)).toBeNull();
  });
  it("names the main repo from inside a linked worktree", async () => {
    const { feat } = await setup();
    expect(await repoOf(feat.path)).toMatchObject({ name: "demo", mainDir: t.dir, toplevel: feat.path });
  });
});

describe("feature workspace", () => {
  it("creates feat/<slug> from base HEAD at <root>/<repo>/<branch-slug>", async () => {
    const head = t.git(["rev-parse", "HEAD"]);
    const { feat } = await setup();
    expect(feat.branch).toBe("feat/f1");
    expect(feat.path).toBe(join(t.root, "demo", "feat-f1"));
    expect(t.git(["rev-parse", "HEAD"], feat.path)).toBe(head);
    expect(t.git(["branch", "--show-current"], feat.path)).toBe("feat/f1");
  });
  it("is idempotent and does not move the branch", async () => {
    const { repo, feat } = await setup();
    t.commitFile("x.txt", "x");
    const again = await ensureFeatureWorkspace({ root: t.root, repo, featureSlug: "f1", baseDir: t.dir });
    expect(again.path).toBe(feat.path);
    expect(t.git(["rev-parse", "feat/f1"])).not.toBe(t.git(["rev-parse", "HEAD"]));
  });
  it("recreates the worktree for an existing branch", async () => {
    const { repo, feat } = await setup();
    t.git(["worktree", "remove", feat.path]);
    const again = await ensureFeatureWorkspace({ root: t.root, repo, featureSlug: "f1", baseDir: t.dir });
    expect(existsSync(again.path)).toBe(true);
  });
  it("cuts from the HEAD of the given checkout", async () => {
    const repo = (await repoOf(t.dir)) as RepoInfo;
    const sha = t.commitFile("y.txt", "y");
    const feat = await ensureFeatureWorkspace({ root: t.root, repo, featureSlug: "f2", baseDir: t.dir });
    expect(t.git(["rev-parse", "HEAD"], feat.path)).toBe(sha);
  });
});

describe("child workspace", () => {
  it("cuts feat/<slug>--<child> from the feature branch", async () => {
    const { feat } = await setup();
    t.commitFile("f.txt", "f", "on feature", feat.path);
    const child = await createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "c1" });
    expect(child.branch).toBe("feat/f1--c1");
    expect(child.path).toBe(join(t.root, "demo", "feat-f1--c1"));
    expect(readFileSync(join(child.path, "f.txt"), "utf8")).toBe("f");
  });
});

describe("mergeChild", () => {
  it("rebases, fast-forwards the feature, and cleans up", async () => {
    const { feat } = await setup();
    const child = await createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "c1" });
    t.commitFile("c.txt", "c", "child work", child.path);
    t.commitFile("f.txt", "f", "feature moved", feat.path); // forces a real rebase
    expect(await mergeChild(child, feat)).toEqual({ ok: true });
    expect(readFileSync(join(feat.path, "c.txt"), "utf8")).toBe("c");
    expect(t.git(["log", "--format=%s", "-3"], feat.path).split("\n")).toEqual(["child work", "feature moved", "initial"]);
    expect(existsSync(child.path)).toBe(false);
    expect(t.git(["branch", "--list", "feat/f1--c1"])).toBe("");
  });
  it("reports conflicts, aborts the rebase and leaves both trees clean", async () => {
    const { feat } = await setup();
    const child = await createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "c1" });
    t.commitFile("README.md", "child\n", "child edit", child.path);
    const featSha = t.commitFile("README.md", "feature\n", "feature edit", feat.path);
    const childSha = t.git(["rev-parse", "HEAD"], child.path);
    expect(await mergeChild(child, feat)).toEqual({ ok: false, conflict: true, files: ["README.md"] });
    expect(t.git(["status", "--porcelain"], child.path)).toBe("");
    expect(t.git(["status", "--porcelain"], feat.path)).toBe("");
    expect(existsSync(join(child.path, ".git"))).toBe(true);
    expect(t.git(["rev-parse", "HEAD"], child.path)).toBe(childSha);
    expect(t.git(["rev-parse", "HEAD"], feat.path)).toBe(featSha);
    expect(t.git(["branch", "--show-current"], child.path)).toBe("feat/f1--c1");
  });
  it("refuses a dirty child without losing work", async () => {
    const { feat } = await setup();
    const child = await createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "c1" });
    writeFileSync(join(child.path, "wip.txt"), "wip");
    await expect(mergeChild(child, feat)).rejects.toThrow(/uncommitted changes/);
    expect(readFileSync(join(child.path, "wip.txt"), "utf8")).toBe("wip");
    t.git(["rev-parse", "--verify", "feat/f1--c1"]);
  });
  it("refuses a modified tracked file in the child too", async () => {
    const { feat } = await setup();
    const child = await createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "c1" });
    writeFileSync(join(child.path, "README.md"), "edited");
    await expect(mergeChild(child, feat)).rejects.toThrow(/uncommitted/);
  });
});

describe("abandonChild", () => {
  it("force-removes a dirty worktree and deletes the unmerged branch", async () => {
    const { feat } = await setup();
    const child = await createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "c1" });
    t.commitFile("c.txt", "c", "unmerged", child.path);
    writeFileSync(join(child.path, "wip.txt"), "wip");
    await abandonChild(child);
    expect(existsSync(child.path)).toBe(false);
    expect(t.git(["branch", "--list", "feat/f1--c1"])).toBe("");
    expect(existsSync(join(feat.path, "c.txt"))).toBe(false);
  });
});

describe("WriterGuard", () => {
  it("fails for another owner, allows the same owner, frees on release", () => {
    const g = new WriterGuard();
    expect(g.acquire(t.dir, "a")).toEqual({ ok: true });
    expect(g.acquire(t.dir, "a")).toEqual({ ok: true });
    expect(g.acquire(t.dir, "b")).toEqual({ ok: false, owner: "a" });
    expect(g.release(t.dir, "b")).toBe(false);
    expect(g.release(t.dir, "a")).toBe(true);
    expect(g.acquire(t.dir, "b")).toEqual({ ok: true });
  });
  it("keys by realpath so symlinks collide; distinct dirs don't", () => {
    const g = new WriterGuard();
    const link = join(t.base, "link");
    symlinkSync(t.dir, link);
    g.acquire(t.dir, "a");
    expect(g.acquire(link, "b")).toEqual({ ok: false, owner: "a" });
    expect(g.acquire(t.base, "b")).toEqual({ ok: true });
  });
});

describe("isolation defaults", () => {
  it("detects writers", () => {
    expect(isWriter(["read", "grep"])).toBe(false);
    expect(isWriter(["read", "grep", "find", "ls", "guarded_bash"])).toBe(false);
    expect(isWriter(["read", "bash"])).toBe(true);
    expect(isWriter(["Edit"])).toBe(true);
    expect(isWriter(["write"])).toBe(true);
    expect(isWriter(undefined)).toBe(true);
    expect(isWriter([])).toBe(false);
  });
  it("is always none outside git, even when the profile says worktree", () => {
    expect(defaultIsolation({ tools: ["edit"], isolation: "worktree" }, false)).toBe("none");
    expect(defaultIsolation({ isolation: "worktree" }, false)).toBe("none");
  });
  it("defaults by writer and git, explicit wins", () => {
    expect(defaultIsolation({ tools: ["edit"] }, true)).toBe("worktree");
    expect(defaultIsolation({}, true)).toBe("worktree");
    expect(defaultIsolation({ tools: ["edit"] }, false)).toBe("none");
    expect(defaultIsolation({ tools: ["read"] }, true)).toBe("none");
    expect(defaultIsolation({ tools: ["read"], isolation: "worktree" }, true)).toBe("worktree");
    expect(defaultIsolation({ tools: ["edit"], isolation: "none" }, true)).toBe("none");
  });
});

describe("slugs and path collisions", () => {
  it("rejects unsafe slugs", () => {
    for (const bad of ["", "a/b", "..", "a..b", "a--b", "x.lock", "X.LOCK", "-a", ".a", "a b", "a;rm"]) {
      expect(() => assertSlug(bad), bad).toThrow(/invalid/);
    }
    for (const ok of ["a", "f1", "My_feat.2", "a-b"]) expect(() => assertSlug(ok)).not.toThrow();
  });
  it("rejects bad slugs in ensure/create", async () => {
    const { repo, feat } = await setup();
    await expect(ensureFeatureWorkspace({ root: t.root, repo, featureSlug: "a/b", baseDir: t.dir })).rejects.toThrow(/invalid/);
    await expect(createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "c--d" })).rejects.toThrow(/invalid/);
  });
  it("refuses a path already used by another branch", async () => {
    const repo = (await repoOf(t.dir)) as RepoInfo;
    t.git(["worktree", "add", "-b", "other", join(t.root, "demo", "feat-f1")]);
    await expect(ensureFeatureWorkspace({ root: t.root, repo, featureSlug: "f1", baseDir: t.dir })).rejects.toThrow(/already taken/);
  });
});

describe("mergeChild robustness", () => {
  it("merges a child with no commits", async () => {
    const { feat } = await setup();
    const child = await createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "c1" });
    expect(await mergeChild(child, feat)).toEqual({ ok: true });
    expect(existsSync(child.path)).toBe(false);
  });
  it("retries the rebase once when the fast-forward fails", async () => {
    const { feat } = await setup();
    const child = await createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "c1" });
    t.commitFile("c.txt", "c", "child", child.path);
    let calls = 0;
    const r = await mergeChild(child, feat, {
      beforeFastForward: async (n) => { calls++; if (n === 0) t.commitFile("late.txt", "l", "late", feat.path); },
    });
    expect(r).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(t.git(["log", "--format=%s", "-3"], feat.path).split("\n")).toEqual(["child", "late", "initial"]);
  });
  it("reports when the fast-forward keeps failing", async () => {
    const { feat } = await setup();
    const child = await createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "c1" });
    t.commitFile("c.txt", "c", "child", child.path);
    await expect(mergeChild(child, feat, {
      beforeFastForward: async (n) => { t.commitFile(`late${n}.txt`, "l", "late", feat.path); },
    })).rejects.toThrow(/after a retry/);
    expect(existsSync(child.path)).toBe(true);
  });
  it("serialises two concurrent merges into one feature", async () => {
    const { feat } = await setup();
    const a = await createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "a" });
    const b = await createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "b" });
    t.commitFile("a.txt", "a", "A", a.path);
    t.commitFile("b.txt", "b", "B", b.path);
    const [ra, rb] = await Promise.all([mergeChild(a, feat), mergeChild(b, feat)]);
    expect([ra, rb]).toEqual([{ ok: true }, { ok: true }]);
    expect(t.git(["log", "--format=%s", "-3"], feat.path).split("\n").sort()).toEqual(["A", "B", "initial"]);
    expect(t.git(["status", "--porcelain"], feat.path)).toBe("");
  });
  it("refuses a detached or wrong branch", async () => {
    const { feat } = await setup();
    const child = await createChildWorkspace({ root: t.root, featureWs: feat, featureSlug: "f1", childSlug: "c1" });
    t.git(["checkout", "-q", "--detach"], child.path);
    await expect(mergeChild(child, feat)).rejects.toThrow(/detached HEAD/);
    t.git(["checkout", "-q", "-b", "stray"], child.path);
    await expect(mergeChild(child, feat)).rejects.toThrow(/stray checked out/);
    t.git(["checkout", "-q", child.branch], child.path);
    await expect(mergeChild(child, { ...feat, branch: "feat/other" })).rejects.toThrow(/expected feat\/other/);
  });
});

describe("worktrees", () => {
  it("recreates a pruned (directory deleted) worktree", async () => {
    const { repo, feat } = await setup();
    const { rmSync } = await import("node:fs");
    rmSync(feat.path, { recursive: true });
    const again = await ensureFeatureWorkspace({ root: t.root, repo, featureSlug: "f1", baseDir: t.dir });
    expect(existsSync(join(again.path, "README.md"))).toBe(true);
  });
  it("returns realpath-normalised paths", async () => {
    const { feat } = await setup();
    const { realpathSync } = await import("node:fs");
    expect(feat.path).toBe(realpathSync.native(feat.path));
  });
  it("guard releaseAll frees every dir for an owner", () => {
    const g = new WriterGuard();
    mkdirSync(join(t.base, "other"));
    g.acquire(t.dir, "a"); g.acquire(join(t.base, "other"), "a"); g.acquire(t.base, "b");
    expect(g.releaseAll("a")).toBe(2);
    expect(g.holder(t.base)).toBe("b");
  });
});

describe("createHomeChildWorkspace", () => {
  it("cuts feat/home--<slug> from the HEAD of baseDir, idempotently", async () => {
    const repo = (await repoOf(t.dir)) as RepoInfo;
    const a = await createHomeChildWorkspace({ root: t.root, repo, childSlug: "w-1", baseDir: t.dir });
    expect(a.branch).toBe("feat/home--w-1");
    expect(a.path).toBe(join(t.root, "demo", "feat-home--w-1"));
    expect(t.git(["rev-parse", a.branch])).toBe(t.git(["rev-parse", "HEAD"]));
    expect(await createHomeChildWorkspace({ root: t.root, repo, childSlug: "w-1", baseDir: t.dir })).toEqual(a);
  });
});
