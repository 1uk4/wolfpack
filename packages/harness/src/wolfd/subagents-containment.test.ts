/**
 * Containment of worktree sub-agents on a real wolf (startTestWolf) over a throwaway repo (makeTempRepo): the brief is
 * rewritten to the child's worktree, its prompt says where it works, write and edit refuse paths outside it, a commit
 * that lands on the main checkout is reported, and a child without a worktree is left alone.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempRepo, type TempRepo } from "@wolfpack/workspaces";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "./scripted-model.js";
import { rewriteBrief } from "./subagents.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
let repo: TempRepo | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
  repo?.cleanup();
  repo = undefined;
});

const textOf = (c: unknown): string => (typeof c === "string" ? c : (c as Array<{ type: string; text?: string }>).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""));

/** Parent: `spawn <agent> [iso=…]: <task>`. Child: acts by the MODE_ word in its brief, one tool call per step, and answers with all its results. */
function scripted(mainDir: () => string) {
  const parentResults: string[] = [];
  const childResults: string[] = [];
  const childSystems: string[] = [];
  const childBriefs: string[] = [];
  const step: FauxResponseStep = async (ctx) => {
    const system = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
    const child = system.includes("You are the sub-agent");
    const user = ctx.messages.find((m) => m.role === "user");
    const brief = user ? textOf(user.content) : "";
    const results = ctx.messages.filter((m) => m.role === "toolResult");
    const last = [...ctx.messages].reverse().find((m) => m.role !== "system")!;
    const call = (name: string, args: Record<string, any>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    if (!child) {
      if (last.role === "toolResult") {
        parentResults.push(textOf(last.content));
        return fauxAssistantMessage("ok");
      }
      const m = /^spawn (\w+)((?: \w+=\S+)*): (.*)$/s.exec(textOf(last.content));
      if (m) {
        const opt = Object.fromEntries([...m[2].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
        return call("subagent", { agent: m[1], task: m[3], ...(opt.iso ? { isolation: opt.iso } : {}) });
      }
      return fauxAssistantMessage("parent");
    }
    if (results.length === 0) {
      childSystems.push(system);
      childBriefs.push(brief);
    }
    const main = mainDir();
    const n = results.length;
    if (n > 0) childResults[n - 1] = textOf(results[n - 1].content);
    if (brief.includes("MODE_FENCE")) {
      const plan: Array<[string, Record<string, any>]> = [
        ["write", { path: join(main, "leak.txt"), content: "leak" }],
        ["edit", { path: join(main, "README.md"), edits: [{ oldText: "# demo", newText: "# hacked" }] }],
        ["bash", { command: `ln -s ${main} escape` }],
        ["write", { path: "escape/via-link.txt", content: "leak" }],
        ["write", { path: "../outside.txt", content: "leak" }],
        ["write", { path: "work.txt", content: "real work" }],
        ["bash", { command: "git add -A -- work.txt && git commit -q -m work" }],
      ];
      if (n < plan.length) return call(...plan[n]);
    } else if (brief.includes("MODE_SNEAK")) {
      if (n === 0) return call("bash", { command: `cd ${main} && git commit -q --allow-empty -m sneaky` });
    } else if (brief.includes("MODE_UNCOMMITTED")) {
      if (n === 0) return call("bash", { command: `echo hi > ${main}/stray.txt` });
    } else if (brief.includes("MODE_QUIET")) {
      if (n === 0) return call("write", { path: "quiet.txt", content: "q" });
      if (n === 1) return call("bash", { command: "git add -A && git commit -q -m quiet" });
    } else if (brief.includes("MODE_ABSOLUTE")) {
      if (n === 0) return call("write", { path: join(main, "direct.txt"), content: "direct" });
    }
    return fauxAssistantMessage("CHILD_DONE");
  };
  return { step, parentResults, childResults, childSystems, childBriefs };
}

async function boot() {
  repo = makeTempRepo("demo");
  const r = repo;
  const s = scripted(() => r.dir);
  const w = await startTestWolf({ script: Array.from({ length: 80 }, () => s.step), workspace: r.dir, yaml: `workspaces:\n  root: ${r.root}\n` });
  const dir = join(w.root, "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "editor.md"), "---\nname: editor\ndescription: scripted editor\nmodel: fast\ntools: read, write, edit, bash\n---\n\nYou are a test agent.\n");
  tw = w;
  return { w, s, r };
}

const say = async (w: TestWolf, text: string) => {
  await w.client.submit(w.home, text, { whenBusy: "reject" });
  for await (const _ of w.client.watch(w.home));
};
const settled = (w: TestWolf, n: number) =>
  vi.waitFor(async () => {
    const k = await w.client.listChildren!(w.home);
    expect(k).toHaveLength(n);
    expect(k.every((c) => c.state === "done")).toBe(true);
  }, { timeout: 8000 });
const regOf = (w: TestWolf): { children: Array<Record<string, any>> } => JSON.parse(readFileSync(join(w.wolf.config.den, "wolfd", "subagents.json"), "utf8"));
const parentText = async (w: TestWolf) => (await w.client.getThread(w.home)).messages.map((m) => m.text).join("\n");
const real = (p: string) => realpathSync.native(p);

describe("rewriteBrief", () => {
  it("rewrites the main checkout, its realpath and ~ forms, but not look-alike paths", () => {
    const home = process.env.HOME ?? "/root";
    const out = rewriteBrief(`Repo: /a/repo (also ${home}/x/repo/sub and /a/repo/src/f.ts; not /a/repo-other or /b/a/repo)`, ["/a/repo", `${home}/x/repo`], "/w/child");
    expect(out.split("\n")[0]).toMatch(/^Note: paths in this brief were rewritten to your worktree \/w\/child/);
    expect(out).toContain("Repo: /w/child (also /w/child/sub and /w/child/src/f.ts; not /a/repo-other or /b/a/repo)");
  });

  it("changes nothing when no off-limits path occurs", () => {
    expect(rewriteBrief("do the thing in src/", ["/a/repo"], "/w/child")).toBe("do the thing in src/");
  });
});

describe("worktree child containment", () => {
  it("rewrites the brief, names the worktree in the prompt, and tells the parent to use relative paths", async () => {
    const { w, s, r } = await boot();
    await say(w, `spawn editor: MODE_QUIET Repo: ${r.dir}. Commit on your branch.`);
    await settled(w, 1);
    const [rec] = regOf(w).children;
    const ws = rec.workspace.path;
    expect(s.childBriefs[0]).toMatch(new RegExp(`^Note: paths in this brief were rewritten to your worktree ${ws}`));
    expect(s.childBriefs[0]).toContain(`Repo: ${ws}.`);
    expect(s.childBriefs[0]).not.toContain(`Repo: ${r.dir}`);
    expect(rec.brief).toBe(s.childBriefs[0]);
    expect(s.childSystems[0]).toContain(`Your working copy is ${ws} on branch ${rec.workspace.branch}. Do all reads, edits, tests and commits there.`);
    expect(s.childSystems[0]).toContain(`main checkout at ${r.dir}`);
    expect(s.childSystems[0]).toContain("off-limits; never edit or commit there");
    expect(s.parentResults[0]).toContain("paths relative to the repo, never the main checkout's absolute path");
    // quiet: the work is in the worktree, main is untouched, no warning
    expect(existsSync(join(ws, "quiet.txt"))).toBe(true);
    expect(r.git(["log", "--format=%s"])).toBe("initial");
    expect(await parentText(w)).not.toContain("WARNING");
  });

  it("refuses write and edit outside the worktree (absolute, symlink, ..) and lets the work land inside", async () => {
    const { w, s, r } = await boot();
    await say(w, `spawn editor: MODE_FENCE Repo: ${r.dir}`);
    await settled(w, 1);
    const [rec] = regOf(w).children;
    const ws = rec.workspace.path;
    for (const i of [0, 1, 3, 4]) {
      expect(s.childResults[i]).toContain("Refused");
      expect(s.childResults[i]).toContain(`Your allowed root is ${real(ws)}`);
    }
    expect(existsSync(join(r.dir, "leak.txt"))).toBe(false);
    expect(readFileSync(join(r.dir, "README.md"), "utf8")).toBe("# demo\n");
    expect(existsSync(join(ws, "..", "outside.txt"))).toBe(false);
    expect(readFileSync(join(ws, "work.txt"), "utf8")).toBe("real work");
    expect(r.git(["log", "--format=%s", rec.workspace.branch]).split("\n")[0]).toBe("work");
    expect(r.git(["log", "--format=%s", "main"])).toBe("initial");
    expect(await parentText(w)).not.toContain("WARNING");
  });

  it("reports a commit that landed on the main checkout, with a ledger entry, and does not revert it", async () => {
    const { w, r } = await boot();
    const before = r.git(["rev-parse", "HEAD"]);
    await say(w, "spawn editor: MODE_SNEAK");
    await settled(w, 1);
    const after = r.git(["rev-parse", "HEAD"]);
    expect(after).not.toBe(before);
    await vi.waitFor(async () => expect(await parentText(w)).toContain(`WARNING: the main checkout ${r.dir} changed while this child ran (HEAD ${before.slice(0, 9)} -> ${after.slice(0, 9)}; 0 new uncommitted files). Its work may not be in its worktree.`));
    const [child] = await w.client.listChildren!(w.home);
    expect((await w.client.getLedger!(child.id)).some((e) => e.kind === "error" && e.text.startsWith("WARNING: the main checkout"))).toBe(true);
    expect(r.git(["log", "-1", "--format=%s"])).toBe("sneaky");
  });

  it("reports new uncommitted files on the main checkout too", async () => {
    const { w, r } = await boot();
    await say(w, "spawn editor: MODE_UNCOMMITTED");
    await settled(w, 1);
    await vi.waitFor(async () => expect(await parentText(w)).toMatch(/WARNING: the main checkout .* changed while this child ran \(HEAD (\w+) -> \1; 1 new uncommitted files\)/));
    expect(existsSync(join(r.dir, "stray.txt"))).toBe(true);
  });

  it("leaves a child without a worktree alone: brief verbatim, no section, no fence, no detection", async () => {
    const { w, s, r } = await boot();
    await say(w, `spawn editor iso=none: MODE_ABSOLUTE Repo: ${r.dir}`);
    await settled(w, 1);
    const [rec] = regOf(w).children;
    expect(rec.isolation).toBe("none");
    expect(rec.mainWatch).toBeUndefined();
    expect(s.childBriefs[0]).toBe(`MODE_ABSOLUTE Repo: ${r.dir}`);
    expect(s.childSystems[0]).not.toContain("Your working copy is");
    expect(readFileSync(join(r.dir, "direct.txt"), "utf8")).toBe("direct");
    expect(s.parentResults[0]).not.toContain("paths relative to the repo");
    expect(await parentText(w)).not.toContain("WARNING");
  });
});

describe("build order", () => {
  it("harness declares @wolfpack/memory (package dependency and tsconfig reference), as it imports it", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const ts = JSON.parse(readFileSync(new URL("../../tsconfig.json", import.meta.url), "utf8"));
    expect(pkg.dependencies["@wolfpack/memory"]).toBeDefined();
    expect(ts.references.map((r: { path: string }) => r.path)).toContain("../memory");
  });
});
