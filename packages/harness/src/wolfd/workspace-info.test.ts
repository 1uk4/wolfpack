/**
 * Header git tree on a real wolf (startTestWolf) over a throwaway repo (makeTempRepo): summaries carry the workspace
 * (home, feature, subagent), the status route reports dirty / ahead / commits / children, and a non-git wolf has none.
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@wolfpack/client";
import { makeTempRepo, type TempRepo } from "@wolfpack/workspaces";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "./scripted-model.js";
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
const real = (p: string) => realpathSync.native(p);

/** Parent: `spawn writer: <task>`. Child: `SLOW` waits for the gate, else answers at once. */
function scripted(gate: Promise<void>) {
  const step: FauxResponseStep = async (ctx, options) => {
    const child = JSON.stringify(ctx.messages.filter((m) => m.role === "system")).includes("You are the sub-agent");
    const last = [...ctx.messages].reverse().find((m) => m.role !== "system")!;
    const text = textOf(last.content);
    if (last.role === "toolResult") return fauxAssistantMessage(child ? "CHILD_DONE" : "ok");
    if (!child) {
      const m = /^spawn (\w+): (.*)$/s.exec(text);
      if (m) return fauxAssistantMessage(fauxToolCall("subagent", { agent: m[1], task: m[2] }), { stopReason: "toolUse" });
      return fauxAssistantMessage("ok");
    }
    if (text.includes("SLOW")) {
      await Promise.race([gate, new Promise<void>((r) => options?.signal?.addEventListener("abort", () => r()))]);
      return fauxAssistantMessage("slow done");
    }
    return fauxAssistantMessage("CHILD_RESULT");
  };
  return step;
}

async function boot(withRepo: boolean, gate: Promise<void> = Promise.resolve()) {
  if (withRepo) repo = makeTempRepo("demo");
  const w = await startTestWolf({
    script: Array.from({ length: 30 }, () => scripted(gate)),
    ...(repo ? { workspace: repo.dir, yaml: `workspaces:\n  root: ${repo.root}\n` } : {}),
  });
  const dir = join(w.root, "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "writer.md"), "---\nname: writer\ndescription: scripted writer\nmodel: fast\ntools: read, write, bash\n---\n\nYou are a test agent.\n");
  tw = w;
  return w;
}

const say = async (w: TestWolf, text: string, id: string) => {
  await w.client.submit(id, text, { whenBusy: "reject" });
  for await (const _ of w.client.watch(id));
};

describe("workspace on summaries", () => {
  it("home: repo and current branch, no base, not a worktree (list, create and detail agree)", async () => {
    const w = await boot(true);
    const expected = { repo: "demo", toplevel: real(repo!.dir), branch: "main", path: real(repo!.dir), isWorktree: false };
    const home = (await w.client.listThreads("testwolf")).find((t) => t.kind === "home")!;
    expect(home.workspace).toEqual(expected);
    expect((await w.client.getThread(w.home)).workspace).toEqual(expected);
    expect((await w.client.createThread!("testwolf", { kind: "home" })).workspace).toEqual(expected);
  });

  it("feature and subagent: worktree branches, base = where each was cut from; the status route reports dirty, ahead, commits, children", async () => {
    let open!: () => void;
    const w = await boot(true, new Promise<void>((r) => (open = r)));
    const feature = (await w.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-feat0001" })).id;
    // Before its first worktree spawn a feature thread works in the wolf's checkout.
    expect((await w.client.getThread(feature)).workspace).toMatchObject({ branch: "main", isWorktree: false });

    await say(w, "spawn writer: SLOW", feature);
    const branch = "feat/eat0001-work-wolfpack-feat0001";
    const fws = (await w.client.getThread(feature)).workspace!;
    expect(fws).toMatchObject({ repo: "demo", base: "main", branch, isWorktree: true });
    expect(fws.path).toBe(join(real(repo!.root), "demo", branch.replace("/", "-")));

    const [kid] = await vi.waitFor(async () => {
      const k = await w.client.listChildren!(feature);
      expect(k).toHaveLength(1);
      return k;
    });
    expect(kid.workspace).toMatchObject({ base: branch, isWorktree: true });
    expect(kid.workspace!.branch).toMatch(/^feat\/eat0001-work-wolfpack-feat0001--writer/);

    repo!.commitFile("a.txt", "one\n", "add a", fws.path);
    writeFileSync(join(fws.path, "README.md"), "# changed\n");
    writeFileSync(join(fws.path, "new.txt"), "x\n");
    const st = await w.client.getWorkspaceStatus!(feature);
    expect(st).toMatchObject({ branch, ahead: 1, behind: 0 });
    expect(st.dirty).toEqual(expect.arrayContaining([{ path: "README.md", status: " M" }, { path: "new.txt", status: "??" }]));
    expect(st.commits.map((c) => c.subject)).toEqual(["add a", "initial"]);
    expect(st.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(st.children).toEqual([{ threadId: kid.id, name: kid.title, branch: kid.workspace!.branch, path: kid.workspace!.path }]);

    const kst = await w.client.getWorkspaceStatus!(kid.id);
    expect(kst).toMatchObject({ branch: kid.workspace!.branch, ahead: 0, behind: 1, dirty: [], children: [] });
    open();
  });
});

describe("no git", () => {
  it("a wolf outside a repo reports no workspace and the status route is not_found", async () => {
    const w = await boot(false);
    expect((await w.client.getThread(w.home)).workspace).toBeUndefined();
    expect((await w.client.listThreads("testwolf")).every((t) => t.workspace === undefined)).toBe(true);
    await expect(w.client.getWorkspaceStatus!(w.home)).rejects.toBeInstanceOf(NotFoundError);
    await expect(w.client.getWorkspaceStatus!("nope/nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});
