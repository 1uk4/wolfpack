/**
 * Merge on ship (ticket 8) on a real wolf over a throwaway git repo: a ship merges the child's branch into the feature
 * branch and cleans up; a conflict raises the card and each choice works; home children, dirty trees, explicit abandon;
 * main is never touched. Ship goes through the real task_done tool against a local Work server.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempRepo, type TempRepo } from "@wolfpack/workspaces";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import createTasksExtension from "./unified-tasks.js";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "../../packages/harness/src/wolfd/scripted-model.js";
import { startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";

vi.setConfig({ testTimeout: 30_000 });

const TASK = "work-wolfpack-task0001";
const FEATURE = "work-wolfpack-feat0001";
const items = new Map<string, Record<string, any>>();
let server: Server;
let endpoint: string;
let tw: TestWolf | undefined;
let repo: TempRepo | undefined;
let toolResults: string[] = [];

beforeEach(async () => {
  items.clear();
  items.set(FEATURE, { id: FEATURE, kind: "feature", title: "Feat", stage: "in_build", log: [], container: false, domain: "wolfpack", partOf: null });
  items.set(TASK, { id: TASK, kind: "task", title: "Task", stage: "approved", log: [], container: false, domain: "wolfpack", partOf: FEATURE });
  toolResults = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      const id = u.pathname.replace(/^\/work\/?/, "");
      const body = raw ? JSON.parse(raw) : {};
      const send = (data: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.method === "GET" && id === "") return send({ items: [...items.values()] });
      const it = items.get(id);
      if (!it) return send({ error: "not found" }, 404);
      if (req.method === "GET") return send({ item: it, body: null });
      if (req.method === "PATCH") {
        if (body.stage) it.stage = body.stage;
        return send({ item: it });
      }
      send({ error: "unsupported" }, 400);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
  repo?.cleanup();
  repo = undefined;
  await new Promise((r) => server.close(r));
});

const textOf = (c: unknown): string => (typeof c === "string" ? c : (c as Array<{ type: string; text?: string }>).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""));

/**
 * One scripted model. Parent: `spawn <agent> name=n: <brief>`, `ship <id>`, `merge <n> <action>`, `stop <n> abandon`; a
 * steered "Merge conflict merging" asks the card as told, and the answer is acted on. Children: `EDIT <file> <text>`
 * (write and commit; `DIRTY` adds an uncommitted file), and the conflict worker's brief resolves the rebase.
 */
function scripted(): FauxResponseStep {
  let conflictName = "";
  return async (ctx) => {
    const system = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
    const child = system.includes("You are the sub-agent");
    const users = ctx.messages.filter((m) => m.role === "user");
    const last = [...ctx.messages].reverse().find((m) => m.role !== "system")!;
    const lastText = textOf(last.content);
    const tool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    if (last.role === "toolResult") {
      toolResults.push(lastText);
      return fauxAssistantMessage(child ? "CHILD_DONE" : `ok:${last.toolName}`);
    }
    if (child) {
      const brief = textOf(users[0].content);
      const rebase = /`git rebase ([^`]+)`/.exec(brief);
      if (rebase) return tool("bash", { command: `git rebase ${rebase[1]}; printf resolved > README.md; git add README.md; GIT_EDITOR=true git rebase --continue` });
      const edit = /^EDIT (\S+) (\S+)( DIRTY)?/.exec(brief);
      if (edit) return tool("bash", { command: `printf ${edit[2]} > ${edit[1]} && git add ${edit[1]} && git commit -qm child-edit${edit[3] ? " && echo junk > junk.txt" : ""}` });
      return fauxAssistantMessage("CHILD_NOOP");
    }
    const spawn = /^spawn (\w+) name=(\S+): (.*)$/s.exec(lastText);
    if (spawn) return tool("subagent", { agent: spawn[1], name: spawn[2], task: spawn[3] });
    const ship = /^ship (\S+)$/.exec(lastText);
    if (ship) return tool("task_done", { id: ship[1] });
    const merge = /^merge (\S+) (\w+)$/.exec(lastText);
    if (merge) return tool("subagent_merge", { name: merge[1], action: merge[2] });
    const stop = /^stop (\S+) abandon$/.exec(lastText);
    if (stop) return tool("subagent_stop", { name: stop[1], abandon: true });
    if (lastText.includes("answered your ask_user_question question")) {
      const action = lastText.includes("Resolve with a worker") ? "resolve" : lastText.includes("I'll do it") ? "manual" : "abandon";
      return tool("subagent_merge", { name: conflictName, action });
    }
    if (lastText.includes("Merge conflict merging")) {
      conflictName = /subagent_merge\(\{ name: "([^"]+)"/.exec(lastText)![1];
      const question = /^(Merge conflict merging [^\n]*?)\. The merge stopped/m.exec(lastText)![1];
      const options = JSON.parse(/options (\[.*\]). Then/.exec(lastText)![1]);
      return tool("ask_user_question", { question, options });
    }
    return fauxAssistantMessage(`parent: ${lastText.slice(0, 40)}`);
  };
}

const agentFile = (name: string) => `---\nname: ${name}\ndescription: scripted ${name}\nmodel: fast\ntools: read, write, bash\n---\n\nYou are a test agent.\n`;

async function boot() {
  repo = makeTempRepo("demo");
  const step = scripted();
  tw = await startTestWolf({
    script: Array.from({ length: 80 }, () => step),
    workspace: repo.dir,
    yaml: `workspaces:\n  root: ${repo.root}\n`,
    hooks: {
      extensions: (rt) => [
        adaptToDurable(
          createTasksExtension({ autoShip: true }, { wolfDen: rt.den, wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: {}, capabilities: { askCards: true }, env: { ...rt.env, WORK_ENDPOINT: endpoint, WORK_TOKEN: "t" } } as never),
          { wolfDen: rt.den, wolfName: "1uk4", onCardTool: rt.onCardTool },
        ),
      ],
    },
  });
  const dir = join(tw.root, "agent", "agents");
  mkdirSync(dir, { recursive: true });
  for (const n of ["writer", "worker"]) writeFileSync(join(dir, `${n}.md`), agentFile(n));
  const feature = (await tw.client.createThread!("testwolf", { kind: "feature", workItemId: FEATURE })).id;
  return { w: tw, feature };
}

const say = async (w: TestWolf, text: string, id: string) => {
  await w.client.submit(id, text, { whenBusy: "reject" });
  for await (const _ of w.client.watch(id));
};
const regOf = (w: TestWolf): { children: Array<Record<string, any>> } => JSON.parse(readFileSync(join(w.wolf.config.den, "wolfd", "subagents.json"), "utf8"));
const threadsOf = (w: TestWolf): Array<Record<string, any>> => JSON.parse(readFileSync(join(w.wolf.config.den, "wolfd", "threads.json"), "utf8")).threads;
const doneKids = (w: TestWolf, parent: string, n: number) =>
  vi.waitFor(async () => {
    const k = await w.client.listChildren!(parent);
    expect(k).toHaveLength(n);
    expect(k.every((c) => c.state === "done")).toBe(true);
  }, { timeout: 8000 });
const parentSaid = (w: TestWolf, parent: string, needle: string) =>
  vi.waitFor(async () => expect((await w.client.getThread(parent)).messages.map((m) => m.text).join("\n")).toContain(needle), { timeout: 8000 });
const branches = (r: TempRepo) => r.git(["branch", "--format=%(refname:short)"]).split("\n").sort();

/** A feature thread with one finished child (named `kid`) that served TASK. */
async function withChild(brief: string) {
  const { w, feature } = await boot();
  await say(w, `spawn writer name=kid: ${brief} for ${TASK}`, feature);
  await doneKids(w, feature, 1);
  const rec = regOf(w).children[0];
  const featureWs = threadsOf(w).find((t) => t.id === feature)!.workspace as { branch: string; path: string };
  return { w, feature, rec, featureWs };
}

describe("merge on ship", () => {
  it("ships a task served by a worktree child: rebase, fast-forward, worktree and branch removed, parent told, main untouched", async () => {
    const { w, feature, rec, featureWs } = await withChild("EDIT a.txt one");
    const main = repo!.git(["rev-parse", "main"]);
    expect(existsSync(rec.workspace.path)).toBe(true);
    await say(w, `ship ${TASK}`, feature);
    await parentSaid(w, feature, `Merged ${rec.workspace.branch} into ${featureWs.branch} (1 commit)`);
    expect(items.get(TASK)!.stage).toBe("shipped");
    expect(repo!.git(["show", `${featureWs.branch}:a.txt`])).toBe("one");
    expect(existsSync(rec.workspace.path)).toBe(false);
    expect(branches(repo!)).not.toContain(rec.workspace.branch);
    expect(repo!.git(["rev-parse", "main"])).toBe(main);
    expect(repo!.git(["ls-tree", "--name-only", "main"])).not.toContain("a.txt");
    expect(regOf(w).children[0].workspace).toBeUndefined();
  });

  it("a ship of some other task leaves the child alone", async () => {
    const { w, feature, rec } = await withChild("EDIT a.txt one");
    items.set("work-wolfpack-other001", { id: "work-wolfpack-other001", kind: "task", title: "O", stage: "approved", log: [], container: false, domain: "wolfpack", partOf: FEATURE });
    await say(w, "ship work-wolfpack-other001", feature);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(rec.workspace.path)).toBe(true);
    expect(branches(repo!)).toContain(rec.workspace.branch);
  });

  it("a home-spawned child is not merged: the parent is told the branch and path", async () => {
    const { w } = await boot();
    await say(w, `spawn writer name=kid: EDIT a.txt one for ${TASK}`, w.home);
    await doneKids(w, w.home, 1);
    const rec = regOf(w).children[0];
    expect(rec.workspace.branch).toMatch(/^feat\/home--/);
    await say(w, `ship ${TASK}`, w.home);
    await parentSaid(w, w.home, "there is no feature branch to merge it into");
    await parentSaid(w, w.home, rec.workspace.path);
    expect(existsSync(rec.workspace.path)).toBe(true);
    expect(branches(repo!)).toContain(rec.workspace.branch);
    expect(repo!.git(["ls-tree", "--name-only", "main"])).not.toContain("a.txt");
  });

  it("a dirty child worktree is not merged; once committed or stashed, retry merges it", async () => {
    const { w, feature, rec, featureWs } = await withChild("EDIT a.txt one DIRTY");
    await say(w, `ship ${TASK}`, feature);
    await parentSaid(w, feature, "uncommitted changes");
    await parentSaid(w, feature, "Commit or stash");
    expect(existsSync(rec.workspace.path)).toBe(true);
    expect(branches(repo!)).toContain(rec.workspace.branch);
    repo!.git(["stash", "-u", "-q"], rec.workspace.path);
    await say(w, "merge kid retry", feature);
    expect(toolResults.at(-1)).toContain(`Merged ${rec.workspace.branch} into ${featureWs.branch}`);
    expect(repo!.git(["show", `${featureWs.branch}:a.txt`])).toBe("one");
    expect(existsSync(rec.workspace.path)).toBe(false);
  });

  it("subagent_stop with abandon removes the worktree and branch; the child cannot be resumed", async () => {
    const { w, feature, rec, featureWs } = await withChild("EDIT a.txt one");
    const main = repo!.git(["rev-parse", "main"]);
    const featureHead = repo!.git(["rev-parse", featureWs.branch]);
    await say(w, "stop kid abandon", feature);
    expect(toolResults.at(-1)).toContain(`Abandoned ${rec.workspace.branch}`);
    expect(existsSync(rec.workspace.path)).toBe(false);
    expect(branches(repo!)).not.toContain(rec.workspace.branch);
    expect(repo!.git(["rev-parse", "main"])).toBe(main);
    expect(repo!.git(["rev-parse", featureWs.branch])).toBe(featureHead);
    await expect(w.client.submit((await w.client.listChildren!(feature))[0].id, "hello", { whenBusy: "reject" })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("conflict card", () => {
  /** A child that rewrote README.md, a feature branch that rewrote it differently, then the ship: the card is pending. */
  async function conflicted() {
    const t = await withChild("EDIT README.md child");
    repo!.commitFile("README.md", "feature\n", "feature edit", t.featureWs.path);
    const title = `Merge conflict merging ${t.rec.workspace.branch} into ${t.featureWs.branch}: README.md`;
    await say(t.w, `ship ${TASK}`, t.feature);
    await parentSaid(t.w, t.feature, title);
    let pending: Awaited<ReturnType<TestWolf["client"]["getThread"]>>["pendingCards"];
    await vi.waitFor(async () => {
      pending = (await t.w.client.getThread(t.feature)).pendingCards;
      expect(pending).toHaveLength(1);
    }, { timeout: 8000 });
    const p = pending![0];
    expect(p.card.tool).toBe("ask_user_question");
    expect(p.card.fields[0]).toMatchObject({ kind: "single", label: title });
    expect((p.card.fields[0] as { options: Array<{ label: string }> }).options.map((o) => o.label)).toEqual(["Resolve with a worker", "I'll do it", "Abandon branch"]);
    // the merge stopped with both trees clean
    expect(repo!.git(["status", "--porcelain"], t.rec.workspace.path)).toBe("");
    expect(repo!.git(["status", "--porcelain"], t.featureWs.path)).toBe("");
    const answer = async (value: string) => {
      await t.w.client.answerCard!(t.feature, p.callId, { [p.card.fields[0].id]: { value } });
      for await (const _ of t.w.client.watch(t.feature));
    };
    return { ...t, answer };
  }

  it("Resolve with a worker: a worker rebases and resolves in the child's worktree, then it is merged again", async () => {
    const t = await conflicted();
    const main = repo!.git(["rev-parse", "main"]);
    await t.answer("resolve");
    await parentSaid(t.w, t.feature, `Merged ${t.rec.workspace.branch} into ${t.featureWs.branch}`);
    expect(repo!.git(["show", `${t.featureWs.branch}:README.md`])).toBe("resolved");
    expect(existsSync(t.rec.workspace.path)).toBe(false);
    expect(branches(repo!)).not.toContain(t.rec.workspace.branch);
    expect(regOf(t.w).children.some((c) => c.agent === "worker" && c.resolves === t.rec.id)).toBe(true);
    expect(repo!.git(["rev-parse", "main"])).toBe(main);
  });

  it("I'll do it: worktree and branch stay, the owner gets the path and commands", async () => {
    const t = await conflicted();
    await t.answer("manual");
    expect(existsSync(t.rec.workspace.path)).toBe(true);
    expect(branches(repo!)).toContain(t.rec.workspace.branch);
    await vi.waitFor(() => expect(toolResults.at(-1)).toContain("Left as is"), { timeout: 8000 });
    const steps = toolResults.at(-1)!;
    expect(steps).toContain(`cd ${t.rec.workspace.path}`);
    expect(steps).toContain(`git rebase ${t.featureWs.branch}`);
    expect(steps).toContain(`git -C ${t.featureWs.path} merge --ff-only ${t.rec.workspace.branch}`);
  });

  it("Abandon branch: worktree and branch removed, the feature branch untouched", async () => {
    const t = await conflicted();
    const featureHead = repo!.git(["rev-parse", t.featureWs.branch]);
    await t.answer("abandon");
    await vi.waitFor(() => expect(toolResults.at(-1)).toContain(`Abandoned ${t.rec.workspace.branch}`), { timeout: 8000 });
    expect(existsSync(t.rec.workspace.path)).toBe(false);
    expect(branches(repo!)).not.toContain(t.rec.workspace.branch);
    expect(repo!.git(["rev-parse", t.featureWs.branch])).toBe(featureHead);
  });
});
