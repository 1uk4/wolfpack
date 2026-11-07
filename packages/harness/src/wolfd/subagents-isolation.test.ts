/**
 * Worktree isolation and the writer guard on a real wolf (startTestWolf) over a throwaway git repo (makeTempRepo):
 * defaults from the profile, the feature workspace and the thread's cwd move, a worktree per writer, explicit
 * overrides, no git outside a repo, the guard (refuse, release, restart).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
      const stop = /^stop (\w+)$/.exec(lastText);
      if (stop) return tool("subagent_stop", { name: stop[1] });
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

  it("a worktree child's spawn result says the merge is automatic; a shared-checkout child's does not", async () => {
    const { w, s } = await boot();
    await say(w, "spawn writer name=wt iso=worktree: do it");
    const wt = s.toolResults.at(-1)!;
    expect(wt).toContain("its branch is merged into the feature branch automatically");
    expect(wt).toContain("Don't merge by hand; use subagent_merge only after a merge conflict or when asked.");
    await settled(w, 1);
    await say(w, "spawn reader name=ro iso=none: look");
    expect(s.toolResults.at(-1)).not.toContain("merged into the feature branch");
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

describe("dependencies in a new worktree", () => {
  /** A fake `pnpm` first on PATH: records pid, cwd, argv and env; prints "boom"; waits for the gate file when gated; exits with `code`. */
  function fakePnpm(o: { code?: number; gated?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "fake-pnpm-"));
    const log = join(dir, "calls.log");
    const gateFile = join(dir, "gate");
    const pidFile = join(dir, "pid");
    writeFileSync(join(dir, "pnpm"), `#!/bin/sh\necho $$ > ${pidFile}\necho "$PWD :: $@ :: CI=$CI :: WP=$WOLFPACK_TEST" >> ${log}\necho boom\n${o.gated ? `n=0\nwhile [ ! -f ${gateFile} ] && [ $n -lt 300 ]; do sleep 0.1; n=$((n+1)); done\n` : ""}exit ${o.code ?? 0}\n`);
    chmodSync(join(dir, "pnpm"), 0o755);
    const prev = process.env.PATH;
    process.env.PATH = `${dir}:${prev}`;
    fakeDirs.push(dir);
    // (idempotent) release the gate, kill whatever still runs from this dir, put PATH back, remove the dir
    const cleanup = () => {
      try { writeFileSync(gateFile, ""); } catch { /* dir already gone */ }
      for (const pid of pidsIn(dir)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      process.env.PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    };
    cleanups.push(cleanup);
    const started = () => existsSync(log);
    return { dir, cleanup, log, started, open: () => writeFileSync(gateFile, ""), pid: () => Number(readFileSync(pidFile, "utf8").trim()) };
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const firstText = async (w: TestWolf, i = 0) => (await w.client.getThread((await kids(w))[i].id)).messages[0]?.text ?? "";
  const lockedRepo = () => { repo = makeTempRepo("demo"); repo.commitFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"); return repo; };

  // A gated fake pnpm must never outlive its test, whatever the test did (stopped the wolf, failed early, never opened the gate).
  const fakeDirs: string[] = [];
  const pidsIn = (dir: string): number[] =>
    spawnSync("pgrep", ["-f", dir], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number).filter((n) => n !== process.pid);
  afterAll(() => {
    const leaked = fakeDirs.flatMap((d) => pidsIn(d).map((pid) => `${pid} (${d})`));
    for (const l of leaked) { try { process.kill(Number(l.split(" ")[0]), "SIGKILL"); } catch { /* gone */ } }
    expect(leaked, "fake pnpm processes still alive after the suite").toEqual([]);
  });

  it("the fake pnpm's cleanup kills a process that is still waiting on its gate", async () => {
    const pnpm = fakePnpm({ gated: true });
    const child = spawn(join(pnpm.dir, "pnpm"), ["install"], { stdio: "ignore", detached: true });
    child.unref();
    await vi.waitFor(() => expect(pidsIn(pnpm.dir).length).toBeGreaterThan(0));
    pnpm.cleanup();
    await vi.waitFor(() => expect(pidsIn(pnpm.dir)).toEqual([]));
  });

  it("the fake pnpm's gate script gives up by itself", () => {
    const pnpm = fakePnpm({ gated: true });
    expect(readFileSync(join(pnpm.dir, "pnpm"), "utf8")).toMatch(/\[ \$n -lt 300 \]/); // a bounded wait loop, not an endless one
    pnpm.cleanup();
  });

  it("spawn returns before the install finishes; the child is told the outcome once it has", async () => {
    const pnpm = fakePnpm({ gated: true });
    const { w } = await boot({ repo: lockedRepo() });
    await say(w, "spawn writer: PWD please"); // (returns with the install still running)
    await vi.waitFor(() => expect(pnpm.started()).toBe(true));
    const [kid] = await kids(w);
    expect(kid.state).toBe("running");
    expect((await w.client.getThread(kid.id)).messages).toHaveLength(0);
    pnpm.open();
    await settled(w, 1);
    const [rec] = regOf(w).children;
    expect(rec.brief).toBe("PWD please");
    expect(await firstText(w)).toMatch(/^Dependencies: installed with pnpm in [0-9.]+ s\n\nPWD please$/);
    expect(readFileSync(pnpm.log, "utf8").trim()).toContain(`${rec.workspace.path} :: install --frozen-lockfile --prefer-offline`);
  });

  it("gives pnpm no WOLFPACK_* variables and CI=true", async () => {
    process.env.WOLFPACK_TEST = "leak";
    cleanups.push(() => { delete process.env.WOLFPACK_TEST; });
    const pnpm = fakePnpm();
    const { w } = await boot({ repo: lockedRepo() });
    await say(w, "spawn writer: PWD please");
    await settled(w, 1);
    expect(readFileSync(pnpm.log, "utf8")).toContain(":: CI=true :: WP=\n");
  });

  it("a queued child gets the line too, when it starts", async () => {
    fakePnpm();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const r = lockedRepo();
    const { w } = await boot({ gate, repo: r, yaml: `workspaces:\n  root: ${r.root}\nsubagents:\n  maxRunning: 1\n` });
    await say(w, "spawn writer name=one: SLOW first");
    await say(w, "spawn writer name=two: PWD second");
    await vi.waitFor(async () => expect((await kids(w)).map((k) => k.state).sort()).toEqual(["queued", "running"]));
    open();
    await settled(w, 2);
    const two = (await kids(w)).find((k) => k.title?.includes("two") || regOf(w).children.find((c) => c.id === k.id)?.name === "two")!;
    expect((await w.client.getThread(two.id)).messages[0].text).toMatch(/^Dependencies: installed with pnpm in [0-9.]+ s\n\nPWD second$/);
  });

  it("stopping the child during the install kills pnpm, and the child never gets its brief", async () => {
    const pnpm = fakePnpm({ gated: true });
    const { w } = await boot({ repo: lockedRepo() });
    await say(w, "spawn writer name=w1: PWD please");
    await vi.waitFor(() => expect(pnpm.started()).toBe(true));
    const pid = pnpm.pid();
    expect(alive(pid)).toBe(true);
    await say(w, "stop w1");
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    pnpm.open();
    await new Promise((r) => setTimeout(r, 300));
    const [kid] = await kids(w);
    expect(kid.state).toBe("stopped");
    expect((await w.client.getThread(kid.id)).messages).toHaveLength(0);
  });

  it("a failed install is told to the child with the log tail; the child still runs and the worktree stays", async () => {
    fakePnpm({ code: 1 });
    const { w } = await boot({ repo: lockedRepo() });
    await say(w, "spawn writer: PWD please");
    await settled(w, 1);
    const [rec] = regOf(w).children;
    const text = await firstText(w);
    expect(text).toMatch(/^Dependencies: install failed \(exit 1, log: .*pnpm-install\.log\); run `pnpm install` yourself\nLast log lines:\nboom\n\nPWD please$/);
    expect(existsSync(rec.workspace.path)).toBe(true);
  });

  it("without a pnpm-lock.yaml nothing is installed and the brief is unchanged", async () => {
    const pnpm = fakePnpm();
    const { w } = await boot();
    await say(w, "spawn writer: PWD please");
    await settled(w, 1);
    expect(pnpm.started()).toBe(false);
    expect(await firstText(w)).toBe("PWD please");
  });

  it("a reader gets no install", async () => {
    const pnpm = fakePnpm();
    const { w } = await boot({ repo: lockedRepo() });
    await say(w, "spawn reader: look");
    await settled(w, 1);
    expect(pnpm.started()).toBe(false);
  });

  it("a message sent during the install waits with the brief: ONE submit of line + brief + message, and the child is not failed", async () => {
    const pnpm = fakePnpm({ gated: true });
    const { w } = await boot({ repo: lockedRepo() });
    await say(w, "spawn writer name=w1: PWD please");
    await vi.waitFor(() => expect(pnpm.started()).toBe(true));
    await say(w, "message w1: and also this");
    expect((await w.client.getThread((await kids(w))[0].id)).messages).toHaveLength(0);
    pnpm.open();
    await settled(w, 1);
    const msgs = (await w.client.getThread((await kids(w))[0].id)).messages.filter((m) => m.role === "user");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/^Dependencies: installed with pnpm in [0-9.]+ s\n\nPWD please\n\nand also this$/);
    expect(regOf(w).children[0].state).toBe("done");
  });

  it("recover re-runs the install a restart cut off: the child gets line + brief", async () => {
    const pnpm = fakePnpm({ gated: true });
    const root = mkdtempSync(join(tmpdir(), "iso-deps-restart-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const r = lockedRepo();
    const first = await boot({ root, repo: r });
    await say(first.w, "spawn writer: PWD please");
    await vi.waitFor(() => expect(pnpm.started()).toBe(true));
    const firstPid = pnpm.pid();
    await first.w.stop();
    tw = undefined;
    await vi.waitFor(() => expect(alive(firstPid)).toBe(false)); // (closing the first wolfd killed its pnpm)
    pnpm.open();
    const second = await boot({ root, repo: r });
    await settled(second.w, 1);
    expect(await firstText(second.w)).toMatch(/^Dependencies: installed with pnpm in [0-9.]+ s\n\nPWD please$/);
    expect(readFileSync(pnpm.log, "utf8").trim().split("\n")).toHaveLength(2); // one install per process
  });

  it("a queued child whose install was cut off by a restart is installed when it starts", async () => {
    const pnpm = fakePnpm({ gated: true });
    const root = mkdtempSync(join(tmpdir(), "iso-deps-queued-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const r = lockedRepo();
    const yaml = `workspaces:\n  root: ${r.root}\nsubagents:\n  maxRunning: 1\n`;
    const first = await boot({ root, repo: r, yaml });
    await say(first.w, "spawn writer name=one: PWD first");
    await say(first.w, "spawn writer name=two: PWD second");
    await vi.waitFor(async () => expect((await kids(first.w)).map((k) => k.state).sort()).toEqual(["queued", "running"]));
    await first.w.stop();
    tw = undefined;
    pnpm.open();
    const second = await boot({ root, repo: r, yaml });
    await settled(second.w, 2);
    for (const k of await kids(second.w)) {
      expect((await second.w.client.getThread(k.id)).messages[0].text).toMatch(/^Dependencies: installed with pnpm in [0-9.]+ s\n\nPWD (first|second)$/);
    }
  });

  it("a child stopped during the install and then resumed gets a new install, then line + brief + message", async () => {
    const pnpm = fakePnpm({ gated: true });
    const { w } = await boot({ repo: lockedRepo() });
    await say(w, "spawn writer name=w1: PWD please");
    await vi.waitFor(() => expect(pnpm.started()).toBe(true));
    await say(w, "stop w1");
    await vi.waitFor(() => expect(regOf(w).children[0].state).toBe("stopped"));
    pnpm.open(); // (the first install is already killed; the next one passes at once)
    await say(w, "message w1: carry on");
    await settled(w, 1);
    const msgs = (await w.client.getThread((await kids(w))[0].id)).messages.filter((m) => m.role === "user");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/^Dependencies: installed with pnpm in [0-9.]+ s\n\nPWD please\n\ncarry on$/);
    expect(readFileSync(pnpm.log, "utf8").trim().split("\n")).toHaveLength(2);
  });

  /**
   * Holds the submits to child conversations created from now on until opened (the wolf runs in this process, so its
   * engine's createOwned is wrapped; restored after the test). `submits` records each child input.
   */
  function gateChildSubmits(w: TestWolf, opts: { swallow?: boolean } = {}) {
    const convs = w.wolf.engine.conversations;
    const orig = convs.createOwned.bind(convs);
    let armed = true;
    let entered = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const submits: string[] = [];
    convs.createOwned = async (...args: Parameters<typeof orig>) => {
      const swallow = opts.swallow;
      const made = await orig(...args);
      const submit = made.conversation.submit.bind(made.conversation);
      made.conversation.submit = async (o): ReturnType<typeof submit> => {
        submits.push(typeof o.input === "string" ? o.input : JSON.stringify(o.input));
        if (swallow) return {} as never; // (acknowledged but never delivered: wolfd "goes down" before the brief lands)
        if (armed) {
          entered++;
          await gate;
        }
        return submit(o);
      };
      return made;
    };
    cleanups.push(() => { convs.createOwned = orig; });
    return { submits, entered: () => entered, open: () => { armed = false; open(); }, disarm: () => { armed = false; } };
  }
  const userTexts = async (w: TestWolf, i = 0) => (await w.client.getThread((await kids(w))[i].id)).messages.filter((m) => m.role === "user").map((m) => m.text);

  it("a message while the brief submit is in flight (after the install) is neither lost nor turns into a second brief", async () => {
    fakePnpm();
    const { w } = await boot({ repo: lockedRepo() });
    const g = gateChildSubmits(w);
    void w.client.submit(w.home, "spawn writer name=w1: PWD please", { whenBusy: "reject" });
    await vi.waitFor(() => expect(g.entered()).toBe(1), { timeout: 8000 });
    const [kid] = await kids(w);
    await w.client.submit(kid.id, "mid message", { whenBusy: "reject" });
    g.open();
    await vi.waitFor(async () => expect((await userTexts(w)).join("\n")).toContain("mid message"), { timeout: 8000 });
    await settled(w, 1);
    const texts = await userTexts(w);
    expect(texts.filter((t) => t.includes("PWD please"))).toHaveLength(1); // one brief
    expect(texts.filter((t) => t.includes("mid message"))).toHaveLength(1); // delivered once
    expect(texts[0]).toMatch(/^Dependencies: installed with pnpm in [0-9.]+ s\n\nPWD please$/); // (the message was not in the input already built)
    expect(regOf(w).children[0]).toMatchObject({ state: "done" });
    expect(regOf(w).children[0].pending ?? []).toEqual([]);
  });

  it("the same on the no-lockfile path: a message while spawn's inline brief submit is in flight", async () => {
    const pnpm = fakePnpm();
    const { w } = await boot();
    const g = gateChildSubmits(w);
    void w.client.submit(w.home, "spawn writer name=w1: PWD please", { whenBusy: "reject" });
    await vi.waitFor(() => expect(g.entered()).toBe(1), { timeout: 8000 });
    const [kid] = await kids(w);
    await w.client.submit(kid.id, "mid message", { whenBusy: "reject" });
    g.open();
    await vi.waitFor(async () => expect((await userTexts(w)).join("\n")).toContain("mid message"), { timeout: 8000 });
    await settled(w, 1);
    const texts = await userTexts(w);
    expect(texts.filter((t) => t.includes("PWD please"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("mid message"))).toHaveLength(1);
    expect(texts[0]).toBe("PWD please");
    expect(pnpm.started()).toBe(false);
    expect(regOf(w).children[0]).toMatchObject({ state: "done" });
  });

  it("recover without a lockfile still submits the plain brief inline, as before", async () => {
    const pnpm = fakePnpm();
    const root = mkdtempSync(join(tmpdir(), "iso-deps-recover-plain-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    repo = makeTempRepo("demo");
    const first = await boot({ root, repo });
    const g = gateChildSubmits(first.w, { swallow: true }); // (the brief never lands: wolfd goes down first)
    await say(first.w, "spawn writer: PWD please");
    expect(g.submits).toEqual(["PWD please"]);
    expect(regOf(first.w).children[0].state).toBe("running");
    await first.w.stop();
    tw = undefined;
    const second = await boot({ root, repo });
    await settled(second.w, 1);
    expect(await userTexts(second.w)).toEqual(["PWD please"]);
    expect(pnpm.started()).toBe(false);
  });

  it("a child whose thread is gone when the install finishes is settled as failed, not left running", async () => {
    const pnpm = fakePnpm({ gated: true });
    const { w } = await boot({ repo: lockedRepo() });
    await say(w, "spawn writer name=w1: PWD please");
    await vi.waitFor(() => expect(pnpm.started()).toBe(true));
    const [kid] = await kids(w);
    (w.wolf.server as unknown as { threads: Map<string, unknown> }).threads.delete(kid.id);
    pnpm.open();
    await vi.waitFor(() => expect(regOf(w).children[0].state).toBe("failed"));
  });
});
