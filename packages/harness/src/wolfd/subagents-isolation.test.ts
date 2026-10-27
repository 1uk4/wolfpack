/**
 * Worktree isolation and the writer guard on a real wolf (startTestWolf) over a throwaway git repo (makeTempRepo):
 * defaults from the profile, the feature workspace and the thread's cwd move, a worktree per writer, explicit
 * overrides, no git outside a repo, the guard (refuse, release, restart).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempRepo, setGitCommand, type TempRepo } from "@wolfpack/workspaces";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
let repo: TempRepo | undefined;
const cleanups: Array<() => void> = [];
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
  repo?.cleanup();
  repo = undefined;
  for (const c of cleanups.splice(0)) c();
});

const textOf = (c: unknown): string => (typeof c === "string" ? c : (c as Array<{ type: string; text?: string }>).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""));

/**
 * One scripted model for every conversation. Parent: `spawn <agent> [name=n] [iso=worktree|none]: <task>`, `pwd`,
 * `HOLD` (mid-turn until the gate opens). Child: `PWD` runs pwd, `SLOW` waits for the gate, else answers at once.
 */
function scripted(gate?: Promise<void>) {
  const toolResults: string[] = [];
  const parentSystems: string[] = [];
  const step: FauxResponseStep = async (ctx, options) => {
    const system = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
    const child = system.includes("You are the sub-agent");
    if (!child) parentSystems.push(system);
    // (a cwd move leaves a system message after the tool result)
    const last = [...ctx.messages].reverse().find((m) => m.role !== "system")!;
    const lastText = textOf(last.content);
    const tool = (name: string, args: Record<string, string>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    if (last.role === "toolResult") {
      toolResults.push(lastText);
      // `spawnpwd`: a bash call in the same turn, after the spawn (does the thread's new cwd reach it?)
      const user = [...ctx.messages].reverse().find((m) => m.role === "user");
      if (!child && last.toolName === "subagent" && user && textOf(user.content).startsWith("spawnpwd ")) return tool("bash", { command: "pwd >> ../inflight.log; echo marker" });
      return fauxAssistantMessage(child ? `CHILD_DONE(${lastText.trim()})` : `ok:${last.toolName}`);
    }
    if (!child) {
      const m = /^spawn(?:pwd)? (\w+)((?: \w+=\S+)*): (.*)$/s.exec(lastText);
      if (m) {
        const opt = Object.fromEntries([...m[2].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
        return tool("subagent", { agent: m[1], task: m[3], ...(opt.name ? { name: opt.name } : {}), ...(opt.iso ? { isolation: opt.iso } : {}) });
      }
      const msg = /^message (\w+): (.*)$/s.exec(lastText);
      if (msg) return tool("subagent_message", { name: msg[1], message: msg[2] });
      if (lastText === "pwd") return tool("bash", { command: "pwd" });
      if (lastText === "HOLD") {
        await Promise.race([gate, new Promise<void>((r) => options?.signal?.addEventListener("abort", () => r()))]);
        return fauxAssistantMessage("held done");
      }
      return fauxAssistantMessage(`parent: ${lastText.slice(0, 40)}`);
    }
    if (lastText.includes("PWD")) return tool("bash", { command: "pwd" });
    if (lastText.includes("SLOW")) {
      await Promise.race([gate, new Promise<void>((r) => options?.signal?.addEventListener("abort", () => r()))]);
      return fauxAssistantMessage("slow done");
    }
    return fauxAssistantMessage(`CHILD_RESULT(${lastText.slice(0, 30)})`);
  };
  return { step, toolResults, parentSystems };
}

const agentFile = (name: string, tools: string) => `---\nname: ${name}\ndescription: scripted ${name}\nmodel: fast\ntools: ${tools}\n---\n\nYou are a test agent.\n`;

async function boot(opts: { gate?: Promise<void>; repo?: TempRepo | null; root?: string; yaml?: string } = {}) {
  const r = opts.repo === undefined ? (repo = makeTempRepo("demo")) : opts.repo;
  const s = scripted(opts.gate);
  const w = await startTestWolf({
    script: Array.from({ length: 60 }, () => s.step),
    ...(opts.root ? { root: opts.root } : {}),
    ...(r ? { workspace: r.dir, yaml: opts.yaml ?? `workspaces:\n  root: ${r.root}\n` } : {}),
  });
  const dir = join(w.root, "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "writer.md"), agentFile("writer", "read, write, bash"));
  writeFileSync(join(dir, "reader.md"), agentFile("reader", "read, grep"));
  writeFileSync(join(dir, "declared.md"), agentFile("declared", "read, bash").replace("model: fast", "model: fast\nisolation: none"));
  tw = w;
  return { w, s };
}

const say = async (w: TestWolf, text: string, id = w.home) => {
  await w.client.submit(id, text, { whenBusy: "reject" });
  for await (const _ of w.client.watch(id));
};
const kids = (w: TestWolf, parent = w.home) => w.client.listChildren!(parent);
const settled = (w: TestWolf, n: number, parent = w.home) =>
  vi.waitFor(async () => {
    const k = await kids(w, parent);
    expect(k).toHaveLength(n);
    expect(k.every((c) => c.state === "done")).toBe(true);
  }, { timeout: 8000 });
const regOf = (w: TestWolf): { children: Array<Record<string, any>> } => JSON.parse(readFileSync(join(w.wolf.config.den, "wolfd", "subagents.json"), "utf8"));
const threadsOf = (w: TestWolf): { threads: Array<Record<string, any>> } => JSON.parse(readFileSync(join(w.wolf.config.den, "wolfd", "threads.json"), "utf8"));
const branches = (r: TempRepo) => r.git(["branch", "--format=%(refname:short)"]).split("\n").sort();
const real = (p: string) => realpathSync.native(p);
const FEATURE = "work-wolfpack-feat0001";
/** Slug: the last 7 of the work id, then the thread title (the id itself, with no Work API) cut to 30. */
const FEATURE_BRANCH = "feat/eat0001-work-wolfpack-feat0001";
const openFeature = async (w: TestWolf) => (await w.client.createThread!("testwolf", { kind: "feature", workItemId: FEATURE })).id;

describe("defaults and overrides", () => {
  it("a writer from home gets a worktree on a branch cut from the repo's HEAD; a read-only profile stays in place", async () => {
    const { w } = await boot();
    const head = repo!.git(["rev-parse", "HEAD"]);
    await say(w, "spawn writer: PWD please");
    await settled(w, 1);
    const [rec] = regOf(w).children;
    expect(rec.isolation).toBe("worktree");
    expect(rec.workspace.branch).toMatch(/^feat\/home--writer-[0-9a-f]{8}$/);
    expect(rec.workspace.path).toBe(join(real(repo!.root), "demo", rec.workspace.branch.replace("/", "-")));
    expect(rec.cwd).toBe(rec.workspace.path);
    expect(repo!.git(["rev-parse", rec.workspace.branch])).toBe(head);
    expect((await w.client.getThread((await kids(w))[0].id)).messages.map((m) => m.text).join("\n")).toContain(`CHILD_DONE(${rec.workspace.path})`);

    await say(w, "spawn reader: look");
    await settled(w, 2);
    const reader = regOf(w).children.find((c) => c.agent === "reader")!;
    expect(reader).toMatchObject({ isolation: "none", cwd: repo!.dir });
    expect(reader.workspace).toBeUndefined();
    expect(reader.guardDir).toBeUndefined();
    expect(branches(repo!).filter((b) => b.startsWith("feat/"))).toEqual([rec.workspace.branch]);
  });

  it("explicit isolation wins over the profile: worktree for a reader, none for a writer; a profile's own isolation counts", async () => {
    const { w } = await boot();
    await say(w, "spawn reader name=r1 iso=worktree: look");
    await settled(w, 1);
    await say(w, "spawn writer name=w1 iso=none: write");
    await settled(w, 2);
    await say(w, "spawn declared name=d1: declared none"); // profile: isolation none, tools include bash
    await settled(w, 3);
    const by = Object.fromEntries(regOf(w).children.map((c) => [c.name, c]));
    expect(by.r1.isolation).toBe("worktree");
    expect(by.r1.workspace.path).toContain(join(real(repo!.root), "demo"));
    expect(by.w1).toMatchObject({ isolation: "none", cwd: repo!.dir });
    expect(by.d1).toMatchObject({ isolation: "none", cwd: repo!.dir });
  });

  it("outside git no git runs at all, whatever the profile or request says", async () => {
    const bin = mkdtempSync(join(tmpdir(), "git-shim-"));
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> ${log}\nexec ${execFileSync("which", ["git"], { encoding: "utf8" }).trim()} "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const prev = setGitCommand(join(bin, "git"));
    cleanups.push(() => {
      setGitCommand(prev);
      rmSync(bin, { recursive: true, force: true });
    });
    const { w } = await boot({ repo: null });
    await say(w, "spawn writer name=a: one");
    await say(w, "spawn writer name=b iso=worktree: two");
    await say(w, "spawn writer name=c iso=none: three"); // no guard outside git: all three run
    await settled(w, 3);
    const recs = regOf(w).children;
    expect(recs.map((c) => c.isolation)).toEqual(["none", "none", "none"]);
    expect(recs.every((c) => c.cwd === join(w.root, "work") && !c.workspace && !c.guardDir)).toBe(true);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(w.root, "workspaces"))).toBe(false);
    const feature = await openFeature(w);
    await say(w, "spawn writer name=f: in a feature", feature);
    await settled(w, 1, feature);
    expect(existsSync(log)).toBe(false);
    expect(threadsOf(w).threads[0].workspace).toBeUndefined();
  });
});

describe("feature threads", () => {
  it("the first writing spawn creates feat/<slug> with a worktree, saves it on the thread and moves the thread's cwd; children branch from it", async () => {
    const { w, s } = await boot();
    const feature = await openFeature(w);
    const head = repo!.git(["rev-parse", "HEAD"]);
    await say(w, "spawn reader: read only first", feature);
    await settled(w, 1, feature);
    expect(threadsOf(w).threads[0].workspace).toBeUndefined(); // a read-only spawn does not create it
    expect(branches(repo!)).toEqual(["main"]);

    await say(w, "spawn writer name=alpha: PWD", feature);
    await settled(w, 2, feature);
    const ws = threadsOf(w).threads[0].workspace;
    expect(ws.branch).toBe(FEATURE_BRANCH);
    expect(ws.path).toBe(join(real(repo!.root), "demo", FEATURE_BRANCH.replace("/", "-")));
    expect(repo!.git(["rev-parse", ws.branch])).toBe(head);
    const alpha = regOf(w).children.find((c) => c.name === "alpha")!;
    expect(alpha.workspace.branch).toMatch(new RegExp(`^${FEATURE_BRANCH}--alpha-[0-9a-f]{8}$`));
    expect(alpha.workspace.path).toBe(join(real(repo!.root), "demo", alpha.workspace.branch.replace("/", "-")));
    expect(repo!.git(["merge-base", "--is-ancestor", ws.branch, alpha.workspace.branch])).toBe("");
    expect(alpha.cwd).toBe(alpha.workspace.path);

    // the thread's own tools now run in the feature workspace
    await say(w, "pwd", feature);
    expect(s.toolResults.at(-1)).toContain(ws.path);
    await say(w, "pwd");
    expect(s.toolResults.at(-1)).toContain(repo!.dir); // home stays put

    // a second writer reuses the feature workspace
    await say(w, "spawn writer name=beta: other", feature);
    await settled(w, 3, feature);
    expect(branches(repo!).map((b) => b.replace(/-[0-9a-f]{8}$/, ""))).toEqual([FEATURE_BRANCH, `${FEATURE_BRANCH}--alpha`, `${FEATURE_BRANCH}--beta`, "main"]);
    expect(threadsOf(w).threads[0].workspace).toEqual(ws);
  });

  it("restart keeps the workspaces, the thread's cwd and the guard state", async () => {
    const root = mkdtempSync(join(tmpdir(), "iso-restart-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const r = (repo = makeTempRepo("demo"));
    const first = await boot({ gate, root, repo: r });
    const feature = await openFeature(first.w);
    await say(first.w, "spawn writer name=alpha: SLOW one", feature);
    await say(first.w, "spawn writer name=gamma iso=none: SLOW shared"); // from home: holds the shared checkout
    await vi.waitFor(() => expect(regOf(first.w).children).toHaveLength(2));
    const ws = threadsOf(first.w).threads[0].workspace;
    const before = regOf(first.w).children.map((c) => [c.name, c.guardDir]);
    await first.w.stop();
    tw = undefined;
    open();

    // second process, same root and repo: the children still hold their dirs until they finish
    let open2!: () => void;
    const second = await boot({ gate: new Promise<void>((x) => (open2 = x)), root, repo: r });
    expect(threadsOf(second.w).threads[0].workspace).toEqual(ws);
    expect(regOf(second.w).children.map((c) => [c.name, c.guardDir])).toEqual(before);
    await say(second.w, "spawn writer name=delta iso=none: more"); // gamma was re-acquired on boot
    expect(second.s.toolResults.at(-1)).toContain('isolation: "worktree"');
    await say(second.w, "pwd", feature);
    expect(second.s.toolResults.at(-1)).toContain(ws.path);
    open2();
  });
});

describe("the writer guard", () => {
  it("refuses a second writer in the shared checkout, points to worktree, and allows again after the first is done", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { w, s } = await boot({ gate });
    await say(w, "spawn writer name=first iso=none: SLOW hold");
    await vi.waitFor(() => expect(regOf(w).children[0]?.guardDir).toBe(real(repo!.dir)));

    await say(w, "spawn writer name=second iso=none: refused?");
    expect(s.toolResults.at(-1)).toMatch(/sub-agent "first" is already writing in .*isolation: "worktree"/);
    expect(await kids(w)).toHaveLength(1); // no thread, no record, no worktree
    await say(w, "spawn reader name=ro iso=none: reads are fine");
    await say(w, "spawn writer name=third: default is a worktree");
    await vi.waitFor(async () => expect((await kids(w)).filter((c) => c.title !== "first").every((c) => c.state === "done")).toBe(true));
    expect(await kids(w)).toHaveLength(3);

    open();
    await vi.waitFor(async () => expect((await kids(w)).find((c) => c.title === "first")!.state).toBe("done"));
    expect(regOf(w).children.find((c) => c.name === "first")!.guardDir).toBeDefined(); // kept as the record of where it ran
    await say(w, "spawn writer name=fourth iso=none: free again");
    await settled(w, 4);
  });

  it("a stopped writer frees the checkout; a resume takes it back, and is refused while another writer holds it", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { w } = await boot({ gate });
    await say(w, "spawn writer name=first iso=none: SLOW hold");
    await vi.waitFor(() => expect(regOf(w).children).toHaveLength(1));
    await w.client.submit(w.home, "stop", { whenBusy: "reject" });
    for await (const _ of w.client.watch(w.home));
    await (w.wolf.server as unknown as { subagents: { stopByName(c: string, n: string): Promise<unknown> } }).subagents.stopByName(String(w.wolf.conversation.id), "first");
    await vi.waitFor(async () => expect((await kids(w))[0].state).toBe("stopped"));
    await say(w, "spawn writer name=second iso=none: SLOW takes it");
    await vi.waitFor(() => expect(regOf(w).children).toHaveLength(2));
    const msg = await (w.wolf.server as unknown as { subagents: { message(c: string, n: string, m: string): Promise<{ text: string; isError?: boolean }> } }).subagents.message(String(w.wolf.conversation.id), "first", "resume");
    expect(msg.isError).toBe(true);
    expect(msg.text).toContain('isolation: "worktree"');
    open();
  });

  it("another thread mid-turn in the same checkout counts as a writer; the caller itself does not", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { w, s } = await boot({ gate });
    const feature = await openFeature(w);
    // the caller is mid-turn in the checkout while spawning: fine
    await say(w, "spawn writer name=solo iso=none: alone");
    await settled(w, 1);
    // home mid-turn: a feature thread (still in the shared checkout) may not start a none-writer there
    await w.client.submit(w.home, "HOLD", { whenBusy: "reject" });
    await vi.waitFor(async () => expect((await w.client.getThread(w.home)).busy).toBe(true));
    await say(w, "spawn writer name=blocked iso=none: no", feature);
    expect(s.toolResults.at(-1)).toMatch(/Home thread \(mid-turn\) is already writing .*isolation: "worktree"/);
    await say(w, "spawn writer name=ok iso=worktree: yes", feature);
    await settled(w, 1, feature);
    open();
  });
});

describe("feature workspace safety", () => {
  it("refuses to adopt an existing branch of the same name, changing nothing", async () => {
    const { w, s } = await boot();
    repo!.git(["branch", FEATURE_BRANCH]);
    const feature = await openFeature(w);
    await say(w, "spawn writer name=a: nope", feature);
    expect(s.toolResults.at(-1)).toMatch(/Could not create the worktree: .*already exists.*not recorded as this thread's workspace/);
    expect(await kids(w, feature)).toHaveLength(0);
    expect(threadsOf(w).threads[0].workspace).toBeUndefined();
    expect(branches(repo!)).toEqual([FEATURE_BRANCH, "main"]);
    expect(existsSync(join(repo!.root, "demo"))).toBe(false);
  });

  it("a cwd move reaches the next turn's tools; whether it reaches the in-flight turn is pinned here", async () => {
    const { w, s } = await boot();
    const feature = await openFeature(w);
    await say(w, "spawnpwd writer name=a: PWD", feature);
    await settled(w, 1, feature);
    const ws = threadsOf(w).threads[0].workspace;
    // the bash call that followed the spawn in the same turn already ran in the feature workspace (`../inflight.log`)
    expect(existsSync(join(ws.path, "..", "inflight.log"))).toBe(true);
    expect(existsSync(join(repo!.base, "inflight.log"))).toBe(false);
    await say(w, "pwd", feature);
    expect(s.toolResults.at(-1)!.trim()).toBe(ws.path);
  });

  it("the prompt names the new workspace from the next turn", async () => {
    const { w, s } = await boot();
    const feature = await openFeature(w);
    await say(w, "spawn writer name=a: x", feature);
    await settled(w, 1, feature);
    const ws = threadsOf(w).threads[0].workspace;
    await say(w, "hello", feature);
    const seen = [...s.parentSystems.at(-1)!.matchAll(/Your workspace is ([^\\]*?)\.\\n/g)].map((m) => m[1]);
    expect(seen.at(-1)).toBe(ws.path);
  });

  it("a missing workspace on reopen is dropped: the thread falls back to the wolf's workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "iso-gone-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const r = (repo = makeTempRepo("demo"));
    const first = await boot({ root, repo: r });
    const feature = await openFeature(first.w);
    await say(first.w, "spawn writer name=a: x", feature);
    await settled(first.w, 1, feature);
    const ws = threadsOf(first.w).threads[0].workspace;
    await first.w.stop();
    tw = undefined;
    rmSync(ws.path, { recursive: true, force: true });
    const second = await boot({ root, repo: r });
    expect(threadsOf(second.w).threads[0].workspace).toBeUndefined();
    await say(second.w, "pwd", feature);
    expect(second.s.toolResults.at(-1)!.trim()).toBe(r.dir);
  });
});

describe("rollback and edge repos", () => {
  it("a spawn whose conversation cannot be created leaves no worktree, branch or guard", async () => {
    const { w } = await boot();
    const m = (w.wolf.server as unknown as { subagents: { opts: { createOwned: () => Promise<never> } } }).subagents;
    m.opts.createOwned = async () => {
      throw new Error("boom");
    };
    await say(w, "spawn writer name=a: x");
    expect(await kids(w)).toHaveLength(0);
    expect(branches(repo!)).toEqual(["main"]);
    expect(repo!.git(["worktree", "list"]).split("\n")).toHaveLength(1);
    // the guard is free again
    m.opts.createOwned = undefined as never;
  });

  it("a resume re-acquires the guard for a stopped writer", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { w, s } = await boot({ gate });
    const sub = (w.wolf.server as unknown as { subagents: { stopByName(c: string, n: string): Promise<unknown> } }).subagents;
    await say(w, "spawn writer name=first iso=none: SLOW hold");
    await vi.waitFor(() => expect(regOf(w).children).toHaveLength(1));
    await sub.stopByName(String(w.wolf.conversation.id), "first");
    await vi.waitFor(async () => expect((await kids(w))[0].state).toBe("stopped"));
    await say(w, "message first: SLOW again");
    await vi.waitFor(async () => expect((await kids(w))[0].state).toBe("running"));
    await say(w, "spawn writer name=second iso=none: refused");
    expect(s.toolResults.at(-1)).toMatch(/sub-agent "first" is already writing/);
    open();
  });

  it("works from a linked worktree (.git is a file): the child is cut from the main repo", async () => {
    const r = (repo = makeTempRepo("demo"));
    const linked = join(r.base, "linked");
    r.git(["worktree", "add", "-b", "side", linked]);
    const s = scripted();
    tw = await startTestWolf({ script: Array.from({ length: 30 }, () => s.step), workspace: linked, yaml: `workspaces:\n  root: ${r.root}\n` });
    const dir = join(tw.root, "agent", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "writer.md"), agentFile("writer", "read, write, bash"));
    await say(tw, "spawn writer name=a: x");
    await settled(tw, 1);
    const rec = regOf(tw).children[0];
    expect(rec.workspace.path).toContain(join(real(r.root), "demo"));
    expect(r.git(["merge-base", "--is-ancestor", "side", rec.workspace.branch])).toBe("");
  });

  it("refuses a writer when git cannot read the repository (unborn HEAD); a reader runs in place", async () => {
    const r = (repo = makeTempRepo("demo"));
    const bare = join(r.base, "fresh");
    mkdirSync(bare);
    r.git(["init", "-q", "-b", "main"], bare);
    const s = scripted();
    tw = await startTestWolf({ script: Array.from({ length: 30 }, () => s.step), workspace: bare, yaml: `workspaces:\n  root: ${r.root}\n` });
    const dir = join(tw.root, "agent", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "writer.md"), agentFile("writer", "read, write, bash"));
    writeFileSync(join(dir, "reader.md"), agentFile("reader", "read, grep"));
    await say(tw, "spawn writer name=a: x");
    expect(s.toolResults.at(-1)).toMatch(/Could not create the worktree|Refused/);
    expect(await kids(tw)).toHaveLength(0);
    await say(tw, "spawn reader name=r: x");
    await settled(tw, 1);
  });
});
