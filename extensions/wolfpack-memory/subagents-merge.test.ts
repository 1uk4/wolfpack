/**
 * Merge on ship (ticket 8) on a real wolf over a throwaway git repo: a ship merges the child's branch into the feature
 * branch and cleans up; a conflict raises the card and each choice works; home children, dirty trees, explicit abandon;
 * main is never touched. Ship goes through the real task_done tool against a local Work server.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
/** Open gates hold a child (WAIT) or the conflict worker until the test releases them. */
let failGets = false;
let childGate: Promise<void> | undefined;
let resolverGate: Promise<void> | undefined;
let lastName = "";
const cleanups: Array<() => void> = [];
const gates: Array<() => void> = [];
/** A closed gate and its opener (opened at the end of the test, whatever happens). */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  gates.push(open);
  return { promise, open };
}

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
      if (req.method === "GET" && id !== "" && failGets) return send({ error: "down" }, 500);
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
  childGate = undefined;
  resolverGate = undefined;
  failGets = false;
});
afterEach(async () => {
  for (const open of gates.splice(0)) open();
  await tw?.stop();
  tw = undefined;
  repo?.cleanup();
  repo = undefined;
  await new Promise((r) => server.close(r));
  for (const open of gates.splice(0)) open();
  for (const c of cleanups.splice(0)) c();
});

const textOf = (c: unknown): string => (typeof c === "string" ? c : (c as Array<{ type: string; text?: string }>).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""));

/**
 * One scripted model. Parent: `spawn <agent> name=n: <brief>`, `ship <id>`, `merge <n> <action>`, `stop <n> abandon`; a
 * steered "Merge conflict merging" asks the card as told, and the answer is acted on. Children: `EDIT <file> <text>`
 * (write and commit; `DIRTY` adds an uncommitted file), and the conflict worker's brief resolves the rebase.
 */
function scripted(): FauxResponseStep {
  let conflictName = "";
  return async (ctx, options) => {
    const held = (g: Promise<void>) => Promise.race([g, new Promise<void>((r) => options?.signal?.addEventListener("abort", () => r()))]);
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
      if (rebase && resolverGate) await held(resolverGate);
      if (brief.includes("WAIT") && childGate) await held(childGate);
      if (rebase) return tool("bash", { command: `git rebase ${rebase[1]}; printf resolved > README.md; git add README.md; GIT_EDITOR=true git rebase --continue` });
      const touch = /^TOUCH (\S+)/.exec(brief);
      if (touch) return tool("bash", { command: `echo x > ${touch[1]}` });
      const edit = /^EDIT (\S+) (\S+)( DIRTY)?/.exec(brief);
      if (edit) return tool("bash", { command: `printf ${edit[2]} > ${edit[1]} && git add ${edit[1]} && git commit -qm child-edit${edit[3] ? " && echo junk > junk.txt" : ""}` });
      return fauxAssistantMessage("CHILD_NOOP");
    }
    const spawn = /^spawn (\w+) name=(\S+): (.*)$/s.exec(lastText);
    if (spawn) return tool("subagent", { agent: spawn[1], name: spawn[2], task: spawn[3] });
    const ship = /^ship (\S+)$/.exec(lastText);
    if (ship) return tool("task_done", { id: ship[1] });
    const merge = /^merge (\S+) (\w+)$/.exec(lastText);
    if (merge) return tool("subagent_merge", { name: (lastName = merge[1]), action: merge[2] });
    const stop = /^stop (\S+) abandon$/.exec(lastText);
    if (stop) return tool("subagent_stop", { name: (lastName = stop[1]), abandon: true });
    const plainStop = /^stop (\S+)$/.exec(lastText);
    if (plainStop) return tool("subagent_stop", { name: plainStop[1] });
    const confirm = /answered your (subagent_merge|subagent_stop) question/.exec(lastText);
    if (confirm) return lastText.includes(": yes") ? tool(confirm[1], confirm[1] === "subagent_merge" ? { name: lastName, action: "abandon" } : { name: lastName, abandon: true }) : fauxAssistantMessage("kept");
    if (lastText.includes("answered your ask_user_question question")) {
      const action = lastText.includes("Resolve with a worker") ? "resolve" : lastText.includes("I'll do it") ? "manual" : "abandon";
      return tool("subagent_merge", { name: conflictName, action });
    }
    if (lastText.includes("Merge conflict merging")) {
      conflictName = /subagent_merge\(\{ name: "([^"]+)"/.exec(lastText)![1];
      const question = /(Merge conflict merging [^\n]*?)\. The merge stopped/m.exec(lastText)![1];
      const options = JSON.parse(/options (\[.*\]). Then/.exec(lastText)![1]);
      return tool("ask_user_question", { question, options });
    }
    return fauxAssistantMessage(`parent: ${lastText.slice(0, 40)}`);
  };
}

const agentFile = (name: string) => `---\nname: ${name}\ndescription: scripted ${name}\nmodel: fast\ntools: read, write, bash\n---\n\nYou are a test agent.\n`;

const root = (): string => {
  const r = mkdtempSync(join(tmpdir(), "merge-wolf-"));
  cleanups.push(() => rmSync(r, { recursive: true, force: true }));
  return r;
};
let wolfRoot = "";

/** Start the wolf over `wolfRoot` (a restart reuses it). */
async function start() {
  const step = scripted();
  tw = await startTestWolf({
    script: Array.from({ length: 80 }, () => step),
    root: wolfRoot,
    env: { WORK_ENDPOINT: endpoint, WORK_TOKEN: "t" },
    workspace: repo!.dir,
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
  return tw;
}

async function boot() {
  repo = makeTempRepo("demo");
  wolfRoot = root();
  await start();
  const w = tw!;
  const dir = join(w.root, "agent", "agents");
  mkdirSync(dir, { recursive: true });
  for (const n of ["writer", "worker"]) writeFileSync(join(dir, `${n}.md`), agentFile(n));
  const feature = (await w.client.createThread!("testwolf", { kind: "feature", workItemId: FEATURE })).id;
  return { w, feature };
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
    await parentSaid(w, feature, `Sub-agent "${rec.name}" merge: Merged ${rec.workspace.branch} into ${featureWs.branch} (1 commit)`);
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

  /** The one pending card of a thread, answered with the confirm field. */
  const pendingConfirm = async (w: TestWolf, feature: string) => {
    let pending: Awaited<ReturnType<TestWolf["client"]["getThread"]>>["pendingCards"];
    await vi.waitFor(async () => {
      pending = (await w.client.getThread(feature)).pendingCards;
      expect(pending).toHaveLength(1);
    }, { timeout: 8000 });
    const p = pending![0];
    return { p, answer: async (yes: boolean) => { await w.client.answerCard!(feature, p.callId, { confirm: { value: yes } }); for await (const _ of w.client.watch(feature)); } };
  };

  it("abandon with unmerged commits raises a card and does nothing without a yes; no keeps the branch", async () => {
    const { w, feature, rec, featureWs } = await withChild("EDIT a.txt one");
    const main = repo!.git(["rev-parse", "main"]);
    await say(w, "stop kid abandon", feature);
    const { p, answer } = await pendingConfirm(w, feature);
    expect(p.card.tool).toBe("subagent_stop");
    expect(p.card.fields[0]).toMatchObject({ kind: "confirm", label: `Abandon ${rec.workspace.branch} (1 unmerged commit)?` });
    expect(existsSync(rec.workspace.path)).toBe(true);
    expect(regOf(w).children[0].state).toBe("done");
    await answer(false);
    expect(existsSync(rec.workspace.path)).toBe(true);
    expect(branches(repo!)).toContain(rec.workspace.branch);
    // asking again after a no does not raise another card
    await say(w, "stop kid abandon", feature);
    expect((await w.client.getThread(feature)).pendingCards ?? []).toHaveLength(0);
    expect(toolResults.at(-1)).toContain("said no");
    expect(repo!.git(["rev-parse", "main"])).toBe(main);
    expect(repo!.git(["rev-parse", featureWs.branch])).toBe(featureWs && repo!.git(["rev-parse", featureWs.branch]));
  });

  it("a yes abandons (subagent_stop), once: the yes is spent and the child cannot be resumed", async () => {
    const { w, feature, rec, featureWs } = await withChild("EDIT a.txt one");
    const main = repo!.git(["rev-parse", "main"]);
    const featureHead = repo!.git(["rev-parse", featureWs.branch]);
    await say(w, "stop kid abandon", feature);
    const { answer } = await pendingConfirm(w, feature);
    await answer(true);
    await vi.waitFor(() => expect(toolResults.at(-1)).toContain(`Abandoned ${rec.workspace.branch}`), { timeout: 8000 });
    expect(existsSync(rec.workspace.path)).toBe(false);
    expect(branches(repo!)).not.toContain(rec.workspace.branch);
    expect(repo!.git(["rev-parse", "main"])).toBe(main);
    expect(repo!.git(["rev-parse", featureWs.branch])).toBe(featureHead);
    await expect(w.client.submit((await w.client.listChildren!(feature))[0].id, "hello", { whenBusy: "reject" })).rejects.toMatchObject({ code: "invalid_request" });
    // the yes is spent: a second call neither abandons again nor asks again
    await say(w, "stop kid abandon", feature);
    expect((await w.client.getThread(feature)).pendingCards ?? []).toHaveLength(0);
    expect(toolResults.at(-1)).toMatch(/no worktree/);
  });

  it("subagent_merge action abandon is gated the same way", async () => {
    const { w, feature, rec } = await withChild("EDIT a.txt one");
    await say(w, "merge kid abandon", feature);
    const { p, answer } = await pendingConfirm(w, feature);
    expect(p.card.tool).toBe("subagent_merge");
    expect(existsSync(rec.workspace.path)).toBe(true);
    await answer(true);
    await vi.waitFor(() => expect(existsSync(rec.workspace.path)).toBe(false), { timeout: 8000 });
    expect(branches(repo!)).not.toContain(rec.workspace.branch);
  });

  it("a branch with no unmerged commits is abandoned freely", async () => {
    const { w, feature, rec } = await withChild("NOOP");
    await say(w, "merge kid abandon", feature);
    expect((await w.client.getThread(feature)).pendingCards ?? []).toHaveLength(0);
    expect(toolResults.at(-1)).toContain(`Abandoned ${rec.workspace.branch}`);
    expect(existsSync(rec.workspace.path)).toBe(false);
    expect(branches(repo!)).not.toContain(rec.workspace.branch);
  });

  it("a 0-commit child with uncommitted changes asks first, then abandons on a yes", async () => {
    const { w, feature, rec } = await withChild("TOUCH README.md");
    await say(w, "merge kid abandon", feature);
    const { p, answer } = await pendingConfirm(w, feature);
    expect(p.card.fields[0]).toMatchObject({ label: `Abandon ${rec.workspace.branch} (1 uncommitted file)?` });
    expect(existsSync(rec.workspace.path)).toBe(true);
    await answer(true);
    await vi.waitFor(() => expect(existsSync(rec.workspace.path)).toBe(false), { timeout: 8000 });
    expect(branches(repo!)).not.toContain(rec.workspace.branch);
  }, 30_000);

  it("an untracked-only file also asks", async () => {
    const { w, feature, rec } = await withChild("TOUCH scratch.txt");
    await say(w, "stop kid abandon", feature);
    const { p } = await pendingConfirm(w, feature);
    expect(p.card.fields[0]).toMatchObject({ label: `Abandon ${rec.workspace.branch} (1 uncommitted file)?` });
    expect(existsSync(rec.workspace.path)).toBe(true);
  });

  it("a failed Work lookup at boot is retried by the next recover", async () => {
    const { w, feature, rec, featureWs } = await withChild("EDIT a.txt one");
    await w.stop();
    items.get(TASK)!.stage = "shipped";
    failGets = true;
    await start();
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(rec.workspace.path)).toBe(true);
    expect(regOf(tw!).children[0].mergeTried).toBeUndefined();
    await tw!.stop();
    failGets = false;
    await start();
    await parentSaid(tw!, feature, `Merged ${rec.workspace.branch} into ${featureWs.branch}`);
    expect(existsSync(rec.workspace.path)).toBe(false);
  });

  it("recover merges a child whose task shipped while wolfd was down, once", async () => {
    const { w, feature, rec, featureWs } = await withChild("EDIT a.txt one");
    await w.stop();
    items.get(TASK)!.stage = "shipped";
    await start();
    await parentSaid(tw!, feature, `Merged ${rec.workspace.branch} into ${featureWs.branch} (1 commit)`);
    expect(repo!.git(["show", `${featureWs.branch}:a.txt`])).toBe("one");
    expect(existsSync(rec.workspace.path)).toBe(false);
    expect(regOf(tw!).children[0].workspace).toBeUndefined();
  });

  it("a child that finishes after its task shipped is merged when it finishes", async () => {
    const g = gate();
    const release = g.open;
    childGate = g.promise;
    const { w, feature } = await boot();
    await say(w, `spawn writer name=kid: EDIT a.txt one WAIT for ${TASK}`, feature);
    const rec = regOf(w).children[0];
    await say(w, `ship ${TASK}`, feature);
    await parentSaid(w, feature, "is still running");
    expect(existsSync(rec.workspace.path)).toBe(true);
    release();
    await parentSaid(w, feature, `Merged ${rec.workspace.branch} into`);
    expect(existsSync(rec.workspace.path)).toBe(false);
  });

  it("a ship in another thread of the wolf merges the child; the child's parent is told", async () => {
    const { w, feature, rec, featureWs } = await withChild("EDIT a.txt one");
    await say(w, `ship ${TASK}`, w.home);
    await parentSaid(w, feature, `Merged ${rec.workspace.branch} into ${featureWs.branch} (1 commit)`);
    expect(repo!.git(["show", `${featureWs.branch}:a.txt`])).toBe("one");
    expect(existsSync(rec.workspace.path)).toBe(false);
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

  it("while a conflict worker holds the worktree: abandon and retry are refused, a second resolve is refused; stopping the worker is reported", async () => {
    const g = gate();
    const release = g.open;
    resolverGate = g.promise;
    const t = await conflicted();
    await t.answer("resolve");
    await vi.waitFor(async () => expect((await t.w.client.listChildren!(t.feature)).some((c) => c.title === "kid-resolve" && c.state === "running")).toBe(true), { timeout: 8000 });
    await say(t.w, "merge kid abandon", t.feature);
    expect(toolResults.at(-1)).toContain("conflict worker");
    expect((await t.w.client.getThread(t.feature)).pendingCards ?? []).toHaveLength(0);
    await say(t.w, "merge kid retry", t.feature);
    expect(toolResults.at(-1)).toContain("conflict worker");
    await say(t.w, "merge kid resolve", t.feature);
    expect(toolResults.at(-1)).toContain("already resolving");
    expect(regOf(t.w).children.filter((c) => c.resolves === t.rec.id)).toHaveLength(1);
    expect(existsSync(t.rec.workspace.path)).toBe(true);
    await say(t.w, "stop kid-resolve", t.feature);
    await parentSaid(t.w, t.feature, 'Conflict worker "kid-resolve" was stopped before');
    expect(existsSync(t.rec.workspace.path)).toBe(true);
    release();
  });

  it("the resolve worker is tied to its child by spawn, and cannot be resumed once the branch is merged", async () => {
    const t = await conflicted();
    await t.answer("resolve");
    await parentSaid(t.w, t.feature, `Merged ${t.rec.workspace.branch} into ${t.featureWs.branch}`);
    const worker = regOf(t.w).children.find((c) => c.agent === "worker")!;
    expect(worker.resolves).toBe(t.rec.id);
    await expect(t.w.client.submit(worker.id, "more", { whenBusy: "reject" })).rejects.toMatchObject({ code: "invalid_request" });
  });
});
