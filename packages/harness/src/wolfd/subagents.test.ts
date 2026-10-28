/**
 * Subagents on a real wolf (startTestWolf: real sqlite + pi-durable, one scripted model answering every conversation):
 * spawn -> child thread -> result steer to the parent, resume, depth 1, questions to the parent, stop, restart.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary, WolfEvent } from "@wolfpack/protocol";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
const roots: string[] = [];
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Call {
  child: boolean;
  /** The whole request (system prompt, tool declarations, messages) as text. */
  request: string;
  last: string;
}

/** One scripted model for every conversation: answers by who is asking (a child's prompt says so) and what was said last. */
function scriptedAgents(opts: { gate?: Promise<void>; parentGate?: Promise<void> } = {}): { step: FauxResponseStep; calls: Call[] } {
  const calls: Call[] = [];
  const step: FauxResponseStep = async (ctx, options) => {
    const system = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
    const child = system.includes("You are the sub-agent");
    const last = ctx.messages[ctx.messages.length - 1];
    const lastText =
      typeof last.content === "string" ? last.content : (last.content as Array<{ type: string; text?: string }>).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    calls.push({ child, request: JSON.stringify(ctx.messages), last: lastText });
    const tool = (name: string, args: Record<string, string>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    if (!child) {
      if (last.role === "toolResult") return fauxAssistantMessage(`ok:${last.toolName}`);
      const spawn = /^spawn(?:\[(\w+)\])?: (.*)$/s.exec(lastText);
      if (spawn) return tool("subagent", { agent: "tester", task: spawn[2], ...(spawn[1] ? { name: spawn[1] } : {}) });
      const msg = /^message\[(\w+)\]: (.*)$/s.exec(lastText);
      if (msg) return tool("subagent_message", { name: msg[1], message: msg[2] });
      const stop = /^stop\[(\w+)\]$/.exec(lastText);
      if (stop) return tool("subagent_stop", { name: stop[1] });
      if (lastText === "slowcard") {
        await opts.parentGate;
        return tool("ask_user_question", { question: "Proceed?" });
      }
      if (lastText === "card") return tool("ask_user_question", { question: "Proceed?" });
      if (lastText === "list") return tool("subagents_list", {});
      if (lastText === "try-nested") return tool("subagent", { agent: "tester", task: "nested" });
      if (/Sub-agent "\w+" asks/.test(lastText)) return tool("subagent_message", { name: "tester", message: "use main" });
      if (/Sub-agent "\w+" (completed|failed|was stopped)/.test(lastText)) return fauxAssistantMessage("parent saw the result");
      return fauxAssistantMessage(`parent: ${lastText.slice(0, 40)}`);
    }
    if (last.role === "toolResult") return fauxAssistantMessage(`child finished after ${last.toolName}`);
    if (lastText.includes("ASK")) return tool("ask_user_question", { question: "Which branch?" });
    if (lastText.includes("NEST")) return tool("subagent", { agent: "tester", task: "grandchild" });
    if (lastText.includes("SLOW")) {
      // Held until the gate opens or the request is cancelled (a stop, a shutdown).
      const signal = options?.signal;
      await Promise.race([opts.gate, new Promise<void>((r) => signal?.addEventListener("abort", () => r()))]);
      if (signal?.aborted) return fauxAssistantMessage("", { stopReason: "aborted" });
      return fauxAssistantMessage("child slow done");
    }
    return fauxAssistantMessage(`CHILD_RESULT(${lastText.slice(0, 40)})`);
  };
  return { step, calls };
}

const many = (step: FauxResponseStep): FauxResponseStep[] => Array.from({ length: 40 }, () => step);

const profile = (tools: string) => `---\nname: tester\ndescription: A scripted test agent\nmodel: fast\ntools: ${tools}\n---\n\nYou are a test agent. Do what the brief says.\n`;
const PROFILE = "---\nname: tester\ndescription: A scripted test agent\nmodel: fast\ntools: read, grep\n---\n\nYou are a test agent. Do what the brief says.\n";

async function boot(agents: { step: FauxResponseStep }, root?: string): Promise<TestWolf> {
  const w = await startTestWolf({ script: many(agents.step), ...(root ? { root } : {}) });
  // The wolf's own roster layer: <wolf-home>/agent/agents.
  const dir = join(w.root, "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tester.md"), PROFILE);
  return w;
}

const drain = async (w: TestWolf, id: string) => {
  for await (const _ of w.client.watch(id));
};
const texts = async (w: TestWolf, id: string) => (await w.client.getThread(id)).messages.map((m) => m.text);
const kids = (w: TestWolf, parent = w.home) => w.client.listChildren!(parent);

/** Ask the parent to do something and wait for its turn to end. */
async function say(w: TestWolf, text: string, id = w.home): Promise<void> {
  await w.client.submit(id, text, { whenBusy: "reject" });
  await drain(w, id);
}

/** Wait until the parent is idle and has seen `n` messages starting with `prefix`. */
const parentSaw = (w: TestWolf, prefix: string, n = 1, id = w.home) =>
  vi.waitFor(
    async () => {
      const d = await w.client.getThread(id);
      expect(d.busy).toBe(false);
      expect(d.messages.filter((m) => m.role === "user" && m.text.startsWith(prefix))).toHaveLength(n);
    },
    { timeout: 8000 },
  );

describe("spawn", () => {
  it("creates a child thread and the child's result reaches the parent as a steer that starts its turn", async () => {
    const agents = scriptedAgents();
    tw = await boot(agents);
    await say(tw, "spawn: look at the cache layer");

    const [child] = await kids(tw);
    expect(child).toMatchObject({ kind: "subagent", parentThreadId: tw.home, agent: "tester", title: "tester" });
    expect(child.id).not.toBe(tw.home);
    expect((await tw.client.listThreads("testwolf")).map((t) => t.id)).toContain(child.id);

    await parentSaw(tw, 'Sub-agent "tester" completed');
    const home = await texts(tw, tw.home);
    expect(home[0]).toBe("spawn: look at the cache layer");
    expect(home.join("\n")).toContain("CHILD_RESULT(look at the cache layer)");
    expect(home.at(-1)).toBe("parent saw the result");

    // the child's thread is readable: its brief and its answer
    const detail = await tw.client.getThread(child.id);
    expect(detail.messages.map((m) => m.text)).toEqual(["look at the cache layer", "CHILD_RESULT(look at the cache layer)"]);
    expect(detail).toMatchObject({ kind: "subagent", parentThreadId: tw.home, state: "done" });
    expect(detail.finishedAt).toBeTruthy();
    expect((await kids(tw))[0]).toMatchObject({ state: "done", tokens: expect.any(Number) });

    // the ledger: the brief down, the result up, each with sender and time
    const ledger = await tw.client.getLedger!(child.id);
    expect(ledger.map((e) => [e.from, e.to, e.kind])).toEqual([
      ["parent", "child", "brief"],
      ["child", "parent", "result"],
    ]);
    expect(ledger[0].text).toBe("look at the cache layer");
    expect(Date.parse(ledger[0].at)).not.toBeNaN();
    expect(ledger.map((e) => e.id)).toEqual([1, 2]);
  });

  it("the child starts fresh: the profile's prompt and the brief, none of the parent's history", async () => {
    const agents = scriptedAgents();
    tw = await boot(agents);
    await say(tw, "an earlier chat about PARENT_ONLY_TOPIC");
    await say(tw, "spawn: do the thing");
    await parentSaw(tw, 'Sub-agent "tester" completed');
    const childCalls = agents.calls.filter((c) => c.child);
    expect(childCalls.length).toBeGreaterThan(0);
    for (const c of childCalls) expect(c.request).not.toContain("PARENT_ONLY_TOPIC");
    expect(childCalls[0].request).toContain("You are a test agent. Do what the brief says.");
    expect(childCalls[0].last).toBe("do the thing");
  });

  it("names are unique among a parent's children, and the roster and children are listed", async () => {
    const agents = scriptedAgents();
    tw = await boot(agents);
    await say(tw, "spawn[tester]: one");
    await say(tw, "spawn[tester]: two");
    await parentSaw(tw, 'Sub-agent "tester', 2);
    expect((await kids(tw)).map((c) => c.title).sort()).toEqual(["tester", "tester-2"]);
    await say(tw, "list");
    const listed = (await tw.client.getThread(tw.home)).messages.flatMap((m) => m.tools ?? []).find((t) => t.name === "subagents_list");
    expect(listed?.result).toContain("tester [fast, background] — A scripted test agent");
    expect(listed?.result).toContain("scout");
    expect(listed?.result).toContain("Your sub-agents:");
    expect(listed?.result).toContain("tester-2 [tester] done");
  });

  it("refuses an unknown agent, a bad tier and a bad isolation without creating a thread", async () => {
    const agents = scriptedAgents();
    tw = await boot(agents);
    const results = async () => (await tw!.client.getThread(tw!.home)).messages.flatMap((m) => m.tools ?? []).map((t) => t.result);
    tw.scripted.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent", { agent: "nope", task: "x" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("subagent", { agent: "tester", task: "x", model: "huge" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("subagent", { agent: "tester", task: "x", isolation: "moon" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await say(tw, "go");
    const r = (await results()).join("\n");
    expect(r).toContain('You may not spawn the "nope" agent');
    expect(r).toContain("must be a tier");
    expect(r).toContain('isolation must be "worktree" or "none"');
    expect(await kids(tw)).toEqual([]);
  });
});

describe("depth 1", () => {
  it("a child is not offered the spawn tools; its parent is", async () => {
    const agents = scriptedAgents();
    tw = await boot(agents);
    await say(tw, "spawn: plain");
    await parentSaw(tw, 'Sub-agent "tester" completed');
    const spawnTools = ["subagent_message", "subagents_list", "subagent_stop", '"subagent"'];
    const parentCall = agents.calls.find((c) => !c.child)!;
    const childCall = agents.calls.find((c) => c.child)!;
    for (const t of spawnTools) expect(parentCall.request, `parent has ${t}`).toContain(t);
    for (const t of spawnTools) expect(childCall.request, `child has ${t}`).not.toContain(t);
    // what it does have: the profile's tools it can use, and the way to ask
    expect(childCall.request).toContain("ask_user_question");
    expect(childCall.request).toContain('"read"');
    expect(childCall.request).not.toContain('"bash"');
  });
});

describe("resume", () => {
  it("a message to a finished child resumes it and its next result is delivered again", async () => {
    const agents = scriptedAgents();
    tw = await boot(agents);
    await say(tw, "spawn: first job");
    await parentSaw(tw, 'Sub-agent "tester" completed');

    await say(tw, "message[tester]: now the second job");
    await parentSaw(tw, 'Sub-agent "tester" completed', 2);
    const home = (await texts(tw, tw.home)).join("\n");
    expect(home).toContain("CHILD_RESULT(first job)");
    expect(home).toContain("CHILD_RESULT(now the second job)");
    const [child] = await kids(tw);
    expect(child.state).toBe("done");
    expect((await tw.client.getLedger!(child.id)).map((e) => [e.from, e.kind])).toEqual([
      ["parent", "brief"],
      ["child", "result"],
      ["parent", "resume"],
      ["child", "result"],
    ]);
    // the child's own history carries on in the same thread
    expect((await texts(tw, child.id)).filter((t) => t.startsWith("CHILD_RESULT"))).toHaveLength(2);
  });

  it("the operator can type into a child: it resumes, and the parent learns of the new result", async () => {
    const agents = scriptedAgents();
    tw = await boot(agents);
    await say(tw, "spawn: first job");
    await parentSaw(tw, 'Sub-agent "tester" completed');
    const [child] = await kids(tw);

    const ack = await tw.client.submit(child.id, "a manual correction", { whenBusy: "reject" });
    expect(ack.disposition).toBe("started");
    await parentSaw(tw, 'Sub-agent "tester" completed', 2);
    expect((await tw.client.getLedger!(child.id)).map((e) => [e.from, e.to, e.kind])).toEqual([
      ["parent", "child", "brief"],
      ["child", "parent", "result"],
      ["owner", "child", "resume"],
      ["child", "parent", "result"],
    ]);
    expect((await texts(tw, tw.home)).join("\n")).toContain("CHILD_RESULT(a manual correction)");
  });
});

describe("questions", () => {
  it("a child's ask_user_question goes to the parent, the child waits, and the parent's answer resumes it", async () => {
    const agents = scriptedAgents();
    tw = await boot(agents);
    await say(tw, "spawn: pick the branch, ASK first");

    await parentSaw(tw, 'Sub-agent "tester" asks');
    const [child] = await kids(tw);
    const home = (await texts(tw, tw.home)).join("\n");
    expect(home).toContain("Which branch?");
    expect(home).toContain('Reply with subagent_message({ name: "tester"');
    // the parent answered (the scripted parent calls subagent_message), and the child's answer reached it
    await parentSaw(tw, 'Sub-agent "tester" completed');
    expect((await tw.client.getLedger!(child.id)).map((e) => [e.from, e.to, e.kind])).toEqual([
      ["parent", "child", "brief"],
      ["child", "parent", "question"],
      ["parent", "child", "resume"],
      ["child", "parent", "result"],
    ]);
    // the question is the parent's to answer: it never reaches the operator's needs-you
    expect(await tw.client.listCards!("testwolf")).toEqual([]);
  });

  it("while it waits, the child is `waiting` and not needs-you", async () => {
    const agents = scriptedAgents();
    // the parent does not answer: a plain acknowledgement
    const base = agents.step as unknown as (ctx: never) => Promise<ReturnType<typeof fauxAssistantMessage>>;
    const quiet: FauxResponseStep = async (ctx) => {
      const r = await base(ctx as never);
      return JSON.stringify(r.content).includes('"subagent_message"') ? fauxAssistantMessage("I will think about it") : r;
    };
    tw = await boot({ step: quiet });
    await say(tw, "spawn: ASK me");
    await parentSaw(tw, 'Sub-agent "tester" asks');
    const [child] = await kids(tw);
    expect(child).toMatchObject({ state: "waiting", status: "idle" });
    expect((await tw.client.getThread(child.id)).pendingCards).toHaveLength(1);
    expect(await tw.client.listCards!("testwolf")).toEqual([]);
  });
});

describe("stop", () => {
  it("subagent_stop cancels the child's turn; it can be resumed", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const agents = scriptedAgents({ gate });
    tw = await boot(agents);
    await say(tw, "spawn: SLOW work");
    await vi.waitFor(() => expect(agents.calls.some((c) => c.child)).toBe(true));
    const [child] = await kids(tw);
    expect(child.state).toBe("running");

    await say(tw, "stop[tester]");
    await vi.waitFor(async () => expect((await kids(tw!))[0].state).toBe("stopped"));
    expect((await kids(tw))[0].finishedAt).toBeTruthy();
    expect((await tw.client.getThread(child.id)).busy).toBe(false);
    expect((await tw.client.getLedger!(child.id)).map((e) => [e.from, e.kind])).toEqual([
      ["parent", "brief"],
      ["parent", "stop"],
    ]);
    // a stopped child delivers no result to its parent
    expect((await texts(tw, tw.home)).some((t) => t.startsWith("Sub-agent"))).toBe(false);

    open();
    await say(tw, "message[tester]: carry on");
    await parentSaw(tw, 'Sub-agent "tester" completed');
    expect((await kids(tw))[0].state).toBe("done");
  });

  it("the operator stops a child from the console: the parent is told", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const agents = scriptedAgents({ gate });
    tw = await boot(agents);
    await say(tw, "spawn: SLOW work");
    await vi.waitFor(() => expect(agents.calls.some((c) => c.child)).toBe(true));
    const [child] = await kids(tw);
    await tw.client.abort(child.id);
    await parentSaw(tw, 'Sub-agent "tester" was stopped by the operator');
    expect((await kids(tw))[0].state).toBe("stopped");
    expect((await tw.client.getLedger!(child.id)).map((e) => [e.from, e.kind])).toEqual([
      ["parent", "brief"],
      ["owner", "stop"],
    ]);
    open();
  });
});

describe("a child that spawns", () => {
  it("is refused (it is not even offered the tool, and the manager refuses a call that gets through)", async () => {
    const agents = scriptedAgents();
    tw = await boot(agents);
    // the child's request has no spawn tools (above); the manager still refuses a call from a child's conversation
    await say(tw, "spawn: plain");
    await parentSaw(tw, 'Sub-agent "tester" completed');
    const manager = (tw.wolf.server as unknown as { subagents: { spawn(c: string, p: unknown): Promise<{ text: string; isError?: boolean }> } }).subagents;
    const [child] = await kids(tw);
    const conv = (await tw.wolf.engine.conversations.get(String(await conversationOf(tw, child))))!;
    const r = await manager.spawn(conv.id, { agent: "tester", task: "nested" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("cannot spawn");
    expect(await kids(tw, child.id)).toEqual([]);
  });
});

/** The conversation id behind a subagent thread (from the registry file). */
async function conversationOf(w: TestWolf, child: ThreadSummary): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const reg = JSON.parse(readFileSync(join(w.wolf.config.den, "wolfd", "subagents.json"), "utf8")) as { children: Array<{ id: string; conversationId: string }> };
  return reg.children.find((c) => c.id === child.id)!.conversationId;
}

describe("restart", () => {
  it("children are re-attached; one that was running finishes and still delivers to its parent", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagents-restart-"));
    roots.push(root);
    let never!: () => void;
    const hold = new Promise<void>((r) => (never = r));
    const first = scriptedAgents({ gate: hold });
    tw = await boot(first, root);
    await say(tw, "spawn: SLOW across a restart");
    await vi.waitFor(() => expect(first.calls.some((c) => c.child)).toBe(true));
    const [child] = await kids(tw);
    expect(child.state).toBe("running");
    await tw.stop();
    tw = undefined;
    never();

    // a new process over the same den: the child's turn resumes (the model answers now), the result reaches the parent
    const second = scriptedAgents();
    tw = await boot(second, root);
    await parentSaw(tw, 'Sub-agent "tester" completed', 1);
    const after = await kids(tw);
    expect(after.map((c) => [c.id, c.state, c.parentThreadId])).toEqual([[child.id, "done", tw.home]]);
    expect((await texts(tw, tw.home)).join("\n")).toContain("child slow done");
    expect((await tw.client.getLedger!(child.id)).map((e) => e.kind)).toEqual(["brief", "result"]);
    // it kept its own configuration (not home's): still no spawn tools, still its profile's prompt
    const childCall = second.calls.find((c) => c.child)!;
    expect(childCall.request).not.toContain("subagent_message");
    expect(childCall.request).toContain("You are a test agent");

    // and it can still be resumed afterwards
    await say(tw, "message[tester]: after the restart");
    await parentSaw(tw, 'Sub-agent "tester" completed', 2);
  });

  it("a finished child and its ledger are still there", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagents-restart-"));
    roots.push(root);
    tw = await boot(scriptedAgents(), root);
    await say(tw, "spawn: quick");
    await parentSaw(tw, 'Sub-agent "tester" completed');
    const [child] = await kids(tw);
    await tw.stop();
    tw = undefined;

    tw = await boot(scriptedAgents(), root);
    const [again] = await kids(tw);
    expect(again).toMatchObject({ id: child.id, state: "done", title: "tester", parentThreadId: tw.home });
    expect((await tw.client.getLedger!(child.id)).map((e) => e.kind)).toEqual(["brief", "result"]);
    expect((await texts(tw, child.id))[0]).toBe("quick");
  });
});

describe("wolf activity", () => {
  it("announces the child and its state changes as thread-updated", async () => {
    const agents = scriptedAgents();
    tw = await boot(agents);
    const seen: WolfEvent[] = [];
    const stop = new AbortController();
    void (async () => {
      for await (const ev of tw!.client.watchActivity!("testwolf", { signal: stop.signal })) seen.push(ev);
    })().catch(() => {});
    await say(tw, "spawn: quick");
    await parentSaw(tw, 'Sub-agent "tester" completed');
    stop.abort();
    const updates = seen.filter((e): e is Extract<WolfEvent, { type: "thread-updated" }> => e.type === "thread-updated").map((e) => e.thread);
    expect(updates[0]).toMatchObject({ kind: "subagent", state: "running", parentThreadId: tw.home });
    expect(updates.at(-1)).toMatchObject({ state: "done" });
  });
});

describe("a steer-triggered turn is as visible as a submitted one", () => {
  it("emits the busy/idle thread-status and the same stream frames a console subscriber follows", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    tw = await boot(scriptedAgents({ gate }));
    const seen: WolfEvent[] = [];
    const stop = new AbortController();
    void (async () => {
      for await (const ev of tw!.client.watchActivity!("testwolf", { signal: stop.signal })) seen.push(ev);
    })().catch(() => {});
    const status = () => seen.filter((e) => e.type === "thread-status" && e.threadId === tw!.home).map((e) => (e as Extract<WolfEvent, { type: "thread-status" }>).status);
    await say(tw, "spawn: SLOW work");
    await vi.waitFor(() => expect(status().at(-1)).toBe("idle"), { timeout: 4000 });
    const before = status().filter((s) => s === "busy").length;

    // the child finishes later: its result arrives as a steer that starts a new parent turn (nobody submitted it)
    open();
    await vi.waitFor(() => expect(status().filter((s) => s === "busy")).toHaveLength(before + 1), { timeout: 4000 });
    await parentSaw(tw, 'Sub-agent "tester" completed');
    await vi.waitFor(() => expect(status().at(-1)).toBe("idle"));
    stop.abort();

    // a console attaching on that busy reads the turn from its first event to its end
    const events = [];
    for await (const ev of tw.client.watch(tw.home)) events.push(ev);
    expect(events[0]?.type).toBe("turn-start");
    expect(events.at(-1)?.type).toBe("turn-end");
    expect(events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("")).toBe("parent saw the result");
  });
});

// ------------------------------------------------------------------ robustness

type Mgr = {
  spawn(c: string, p: unknown): Promise<{ text: string; isError?: boolean }>;
  persist(): void;
  opts: { retryBaseMs?: number; createOwned: (...a: never[]) => Promise<never>; releaseOwner: (id: string) => Promise<void> };
  port: { thread(id: string): { submit: (...a: never[]) => Promise<unknown> } | undefined };
  releaseParent(id: string): Promise<void>;
};
const mgr = (w: TestWolf) => (w.wolf.server as unknown as { subagents: Mgr }).subagents;
const wolfdFile = (w: TestWolf, f: string) => join(w.wolf.config.den, "wolfd", f);
type Reg = { children: Array<Record<string, unknown> & { id: string; outbox: Array<{ n: number; id: string; text: string }> }> };
const readReg = (w: TestWolf): Reg => JSON.parse(readFileSync(wolfdFile(w, "subagents.json"), "utf8"));
const newRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "subagents-robust-"));
  roots.push(root);
  return root;
};
const aside = (w: TestWolf, dir: string, prefix: string) => readdirSync(join(w.wolf.config.den, "wolfd", dir)).filter((f) => f.includes(prefix));

/** Boot, spawn one finished child, stop. Returns its thread id. */
async function finishedChild(root: string, text = "spawn: first"): Promise<{ child: string; marker: string }> {
  tw = await boot(scriptedAgents(), root);
  await say(tw, text);
  await parentSaw(tw, 'Sub-agent "tester" completed');
  const [c] = await kids(tw);
  const marker = /\[delivery ([^\]]+)\]/.exec((await texts(tw, tw.home)).join("\n"))![1];
  await tw.stop();
  tw = undefined;
  return { child: c.id, marker };
}

describe("persistence robustness", () => {
  it("a corrupt subagents.json is moved aside and the wolf boots without children", async () => {
    const root = newRoot();
    await finishedChild(root);
    const den = join(root, "den");
    void den;
    tw = await boot(scriptedAgents(), root);
    await tw.stop();
    tw = undefined;
    // corrupt it (the first boot above re-saved nothing, so write over the real file)
    const probe = await boot(scriptedAgents(), root);
    writeFileSync(wolfdFile(probe, "subagents.json"), "{ not json");
    await probe.stop();
    tw = await boot(scriptedAgents(), root);
    expect(await kids(tw)).toEqual([]);
    expect(aside(tw, ".", "subagents.json.corrupt")).toHaveLength(1);
  });

  it("bad child records are skipped, good ones survive, missing fields default", async () => {
    const root = newRoot();
    const { child } = await finishedChild(root);
    const probe = await boot(scriptedAgents(), root);
    const reg = readReg(probe);
    const good = { ...reg.children[0] } as Record<string, unknown>;
    delete good.outbox;
    delete good.tokens;
    writeFileSync(wolfdFile(probe, "subagents.json"), JSON.stringify({ children: [good, { id: "x" }, null, { ...good, id: "y/1", state: "levitating" }] }));
    await probe.stop();
    tw = await boot(scriptedAgents(), root);
    const list = await kids(tw);
    expect(list.map((c) => c.id)).toEqual([child]);
    expect(list[0].tokens).toBe(0);
  });

  it("a corrupt ledger is moved aside; the route answers an empty ledger", async () => {
    const root = newRoot();
    const { child } = await finishedChild(root);
    tw = await boot(scriptedAgents(), root);
    const f = join(tw.wolf.config.den, "wolfd", "ledgers", `${child.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
    const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
    writeFileSync(f, `${lines[0]}\nGARBAGE\n${lines[1]}\n`);
    expect(await tw.client.getLedger!(child)).toEqual([]);
    expect(aside(tw, "ledgers", ".corrupt-")).toHaveLength(1);
    // a torn last line (a crash mid-append) just loses that line
    writeFileSync(f, `${lines[0]}\n{"id":2,"at":`);
    expect((await tw.client.getLedger!(child)).map((e) => e.kind)).toEqual(["brief"]);
  });
});

describe("delivery", () => {
  it("restart with a non-empty outbox: an entry the parent already holds is only removed; a new one arrives once", async () => {
    const root = newRoot();
    const { child, marker } = await finishedChild(root);
    const probe = await boot(scriptedAgents(), root);
    const reg = readReg(probe);
    // crash between the steer and the outbox removal: the entry is still there, and marked sending
    reg.children[0].outbox = [
      { n: 50, id: marker, text: "duplicate of the delivered result" } as never,
      { n: 51, id: "fresh.51", text: 'Sub-agent "tester" completed (0s).\n\nsecond result' },
    ];
    writeFileSync(wolfdFile(probe, "subagents.json"), JSON.stringify(reg));
    await probe.stop();
    tw = await boot(scriptedAgents(), root);
    await parentSaw(tw, "Sub-agent", 2);
    const all = (await texts(tw, tw.home)).join("\n");
    expect(all).not.toContain("duplicate of the delivered result");
    expect(all.split(`[delivery ${marker}]`)).toHaveLength(2);
    expect(all.split("[delivery fresh.51]")).toHaveLength(2);
    expect(readReg(tw).children.find((c) => c.id === child)!.outbox).toEqual([]);
  });

  it("finishing is one write: a done child always has its delivery queued (held parent)", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    tw = await boot(scriptedAgents({ gate }));
    const snaps: Array<{ state: string; outbox: number }> = [];
    const m = mgr(tw);
    const persist = m.persist.bind(m);
    m.persist = () => {
      persist();
      for (const c of readReg(tw!).children) snaps.push({ state: String(c.state), outbox: c.outbox.length });
    };
    await say(tw, "spawn: SLOW work");
    await say(tw, "card"); // the parent is idle with an open card: nothing is delivered
    open();
    await vi.waitFor(async () => expect((await kids(tw!))[0].state).toBe("done"));
    expect(snaps.some((x) => x.state === "done")).toBe(true);
    for (const x of snaps.filter((y) => y.state === "done")) expect(x.outbox).toBe(1);
    expect(readReg(tw).children[0].outbox).toHaveLength(1);
  });

  it("a result for an idle parent with an open card is held, then flushed when its next turn starts", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    tw = await boot(scriptedAgents({ gate }));
    await say(tw, "spawn: SLOW work");
    await say(tw, "card");
    const [card] = (await tw.client.getThread(tw.home)).pendingCards!;
    open();
    await vi.waitFor(async () => expect((await kids(tw!))[0].state).toBe("done"));
    await new Promise((r) => setTimeout(r, 200));
    expect((await texts(tw, tw.home)).some((t) => t.startsWith("Sub-agent"))).toBe(false);
    expect((await tw.client.getThread(tw.home)).pendingCards).toHaveLength(1);
    await tw.client.answerCard!(tw.home, card.callId, { answer: { value: "yes" } });
    await parentSaw(tw, 'Sub-agent "tester" completed');
    expect(readReg(tw).children[0].outbox).toEqual([]);
  });

  it("a result queued while the parent's turn runs, which ends with a card, is held (the card is not superseded) and delivered once after the answer", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let openParent!: () => void;
    const parentGate = new Promise<void>((r) => (openParent = r));
    tw = await boot(scriptedAgents({ gate, parentGate }));
    await say(tw, "spawn: SLOW work");
    await tw.client.submit(tw.home, "slowcard", { whenBusy: "reject" }); // the parent's turn is running
    open();
    await vi.waitFor(async () => expect((await kids(tw!))[0].state).toBe("done"));
    expect(readReg(tw).children[0].outbox).toHaveLength(1);
    expect((await texts(tw, tw.home)).some((t) => t.startsWith("Sub-agent"))).toBe(false); // not steered into the running turn
    openParent();
    await vi.waitFor(async () => expect((await tw!.client.getThread(tw!.home)).pendingCards).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    const [card] = (await tw.client.getThread(tw.home)).pendingCards!;
    expect((await texts(tw, tw.home)).some((t) => t.startsWith("Sub-agent"))).toBe(false);
    expect((await tw.client.getThread(tw.home)).pendingCards).toHaveLength(1);
    await tw.client.answerCard!(tw.home, card.callId, { answer: { value: "yes" } });
    await parentSaw(tw, 'Sub-agent "tester" completed');
    await new Promise((r) => setTimeout(r, 200));
    expect((await texts(tw, tw.home)).filter((t) => t.startsWith("Sub-agent"))).toHaveLength(1);
    expect(readReg(tw).children[0].outbox).toEqual([]);
  });

  it("a restart while a result is held behind a card delivers it once, after the answer", async () => {
    const root = newRoot();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    tw = await boot(scriptedAgents({ gate }), root);
    await say(tw, "spawn: SLOW work");
    await say(tw, "card");
    open();
    await vi.waitFor(async () => expect((await kids(tw!))[0].state).toBe("done"));
    expect(readReg(tw).children[0].outbox).toHaveLength(1);
    await tw.stop();
    tw = await boot(scriptedAgents(), root);
    await new Promise((r) => setTimeout(r, 300));
    expect((await texts(tw, tw.home)).some((t) => t.startsWith("Sub-agent"))).toBe(false);
    const [card] = (await tw.client.getThread(tw.home)).pendingCards!;
    await tw.client.answerCard!(tw.home, card.callId, { answer: { value: "yes" } });
    await parentSaw(tw, 'Sub-agent "tester" completed');
    await new Promise((r) => setTimeout(r, 200));
    expect((await texts(tw, tw.home)).filter((t) => t.startsWith("Sub-agent"))).toHaveLength(1);
    expect(readReg(tw).children[0].outbox).toEqual([]);
  });

  it("a delivery that fails is retried with backoff and arrives once", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    tw = await boot(scriptedAgents({ gate }));
    mgr(tw).opts.retryBaseMs = 20;
    await say(tw, "spawn: SLOW work");
    const parent = mgr(tw).port.thread(tw.home)!;
    const real = parent.submit.bind(parent);
    let failures = 0;
    parent.submit = async (...a: never[]) => {
      if (failures < 2) {
        failures++;
        throw new Error("transient");
      }
      return real(...a);
    };
    open();
    await parentSaw(tw, 'Sub-agent "tester" completed');
    expect(failures).toBe(2);
    expect((await texts(tw, tw.home)).filter((t) => t.startsWith("Sub-agent"))).toHaveLength(1);
  });

  it("entries for a parent that is gone are dropped, with a ledger note", async () => {
    const root = newRoot();
    const { child } = await finishedChild(root);
    const probe = await boot(scriptedAgents(), root);
    const reg = readReg(probe);
    reg.children[0].parentThreadId = "testwolf/ghost";
    reg.children[0].outbox = [{ n: 9, id: "x.9", text: "lost" }];
    writeFileSync(wolfdFile(probe, "subagents.json"), JSON.stringify(reg));
    await probe.stop();
    tw = await boot(scriptedAgents(), root);
    await vi.waitFor(() => expect(readReg(tw!).children[0].outbox).toEqual([]));
    expect((await tw.client.getLedger!(child)).some((e) => e.kind === "error" && e.text.includes("undeliverable"))).toBe(true);
  });
});

describe("resume crash window", () => {
  it("a resume whose submit never landed does not redeliver the previous answer", async () => {
    const root = newRoot();
    const { child } = await finishedChild(root);
    const probe = await boot(scriptedAgents(), root);
    const reg = readReg(probe);
    const count = (await probe.client.getThread(child)).messages.length;
    reg.children[0].resuming = { at: count }; // persisted, then the process died before the submit
    writeFileSync(wolfdFile(probe, "subagents.json"), JSON.stringify(reg));
    await probe.stop();
    tw = await boot(scriptedAgents(), root);
    await new Promise((r) => setTimeout(r, 300));
    const [c] = await kids(tw);
    expect(c.state).toBe("done");
    expect((await texts(tw, tw.home)).filter((t) => t.startsWith("Sub-agent"))).toHaveLength(1);
    expect(readReg(tw).children[0].resuming).toBeUndefined();
  });

  it("a resume that landed and finished before the crash delivers its (new) answer", async () => {
    const root = newRoot();
    const { child } = await finishedChild(root);
    // run the resume for real, then pretend the process died before the result was recorded
    tw = await boot(scriptedAgents(), root);
    await say(tw, "message[tester]: again");
    await parentSaw(tw, 'Sub-agent "tester" completed', 2);
    const messages = (await tw.client.getThread(child)).messages.length;
    await tw.stop();
    tw = undefined;
    const probe = await boot(scriptedAgents(), root);
    const reg = readReg(probe);
    reg.children[0].resuming = { at: messages - 2 };
    reg.children[0].state = "running";
    writeFileSync(wolfdFile(probe, "subagents.json"), JSON.stringify(reg));
    await probe.stop();
    tw = await boot(scriptedAgents(), root);
    await parentSaw(tw, 'Sub-agent "tester" completed', 3);
  });
});

describe("races", () => {
  it("a turn that finishes before the resume submit returns is not overwritten with running", async () => {
    tw = await boot(scriptedAgents());
    await say(tw, "spawn: first");
    await parentSaw(tw, 'Sub-agent "tester" completed');
    const [c] = await kids(tw);
    const child = mgr(tw).port.thread(c.id)!;
    const real = child.submit.bind(child);
    child.submit = async (...a: never[]) => {
      const ack = await real(...a);
      await vi.waitFor(async () => expect((await kids(tw!))[0].state).toBe("done"));
      return ack;
    };
    await tw.client.submit(c.id, "quick", { whenBusy: "reject" });
    await parentSaw(tw, 'Sub-agent "tester" completed', 2);
    expect((await kids(tw))[0].state).toBe("done");
    expect(readReg(tw).children[0].resuming).toBeUndefined();
  });

  it("an operator resume right after done is not killed by the owner release", async () => {
    tw = await boot(scriptedAgents());
    await say(tw, "spawn: first");
    await vi.waitFor(async () => expect((await kids(tw!))[0].state).toBe("done"));
    const [c] = await kids(tw);
    await tw.client.submit(c.id, "right away", { whenBusy: "reject" });
    await parentSaw(tw, 'Sub-agent "tester" completed', 2);
    expect((await texts(tw, c.id)).at(-1)).toBe("CHILD_RESULT(right away)");
  });

  it("a registered parent that is not attached keeps its outbox", async () => {
    const root = newRoot();
    await finishedChild(root);
    const probe = await boot(scriptedAgents(), root);
    const reg = readReg(probe);
    reg.children[0].outbox = [{ n: 9, id: "k.9", text: "keep me" }];
    writeFileSync(wolfdFile(probe, "subagents.json"), JSON.stringify(reg));
    writeFileSync(wolfdFile(probe, "threads.json"), JSON.stringify({ threads: [{ id: "testwolf/feature-work-x-1", conversationId: "999", kind: "feature", workItemId: "work-x-1", title: "f" }] }));
    reg.children[0].parentThreadId = "testwolf/feature-work-x-1";
    writeFileSync(wolfdFile(probe, "subagents.json"), JSON.stringify(reg));
    await probe.stop();
    tw = await boot(scriptedAgents(), root);
    await new Promise((r) => setTimeout(r, 300));
    expect(readReg(tw).children[0].outbox).toHaveLength(1);
  });
});

describe("pi-durable contract", () => {
  it("a conversation whose owner task has ended still runs resumed turns (settle releases the owner on this)", async () => {
    tw = await boot(scriptedAgents());
    const m = tw.wolf.engine.conversations;
    const owned = await m.createOwned("1", { tools: [] });
    await m.releaseOwner(owned.taskId);
    await new Promise((r) => setTimeout(r, 200));
    await owned.conversation.submit({ input: "after release", whenBusy: "reject" });
    await vi.waitFor(async () => {
      const w = await owned.conversation.watch();
      const n = w.snapshot.entries.length;
      await w.stop();
      expect(n).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("owner task lifecycle", () => {
  it("lives while the child is active, ends when it is done, and a resume still works", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    tw = await boot(scriptedAgents({ gate }));
    await say(tw, "spawn: SLOW work");
    await vi.waitFor(() => expect(readReg(tw!).children).toHaveLength(1));
    expect(readReg(tw).children[0].ownerTaskId).not.toBe("");
    open();
    await parentSaw(tw, 'Sub-agent "tester" completed');
    await vi.waitFor(() => expect(readReg(tw!).children[0].ownerTaskId).toBe(""));
    await say(tw, "message[tester]: more");
    await parentSaw(tw, 'Sub-agent "tester" completed', 2);
  });

  it("a stop ends the owner task; releasing a parent stops its children and ends their owners", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    tw = await boot(scriptedAgents({ gate }));
    await say(tw, "spawn: SLOW work");
    await vi.waitFor(() => expect(readReg(tw!).children).toHaveLength(1));
    await mgr(tw).releaseParent(tw.home);
    expect((await kids(tw))[0].state).toBe("stopped");
    expect(readReg(tw).children[0].ownerTaskId).toBe("");
    open();
  });

  it("a spawn that cannot start is undone: no record, no thread, owner ended", async () => {
    tw = await boot(scriptedAgents());
    const m = mgr(tw);
    const released: string[] = [];
    const realCreate = m.opts.createOwned;
    const realRelease = m.opts.releaseOwner;
    m.opts.releaseOwner = async (id) => {
      released.push(id);
      return realRelease(id);
    };
    m.opts.createOwned = (async (...a: never[]) => {
      const o = (await realCreate(...a)) as unknown as { conversation: { submit: unknown } };
      o.conversation.submit = async () => {
        throw new Error("no capacity");
      };
      return o as never;
    }) as never;
    await say(tw, "spawn: doomed");
    const results = (await tw.client.getThread(tw.home)).messages.flatMap((m) => m.tools ?? []).map((t) => t.result);
    expect(results.join("\n")).toContain("could not start");
    expect(await kids(tw)).toEqual([]);
    expect((await tw.client.listThreads("testwolf")).map((t) => t.kind)).toEqual(["home"]);
    expect(released).toHaveLength(1);
    expect(existsSync(wolfdFile(tw, "subagents.json")) ? readReg(tw).children : []).toEqual([]);
  });
});

describe("isolation of the tool set", () => {
  it("a parent's abort leaves its children running", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    tw = await boot(scriptedAgents({ gate }));
    await say(tw, "spawn: SLOW work");
    await vi.waitFor(async () => expect((await kids(tw!))[0].state).toBe("running"));
    await tw.client.abort(tw.home);
    await new Promise((r) => setTimeout(r, 200));
    const [c] = await kids(tw);
    expect(c.state).toBe("running");
    expect((await tw.client.getThread(c.id)).busy).toBe(true);
    open();
    await parentSaw(tw, 'Sub-agent "tester" completed');
  });

  it("a profile that lists the spawn tools does not hand them to its child", async () => {
    const agents = scriptedAgents();
    tw = await boot(agents);
    writeFileSync(join(tw.root, "agent", "agents", "tester.md"), profile("read, subagent, subagent_message, subagents_list, subagent_stop, grep"));
    await say(tw, "spawn: plain");
    await parentSaw(tw, 'Sub-agent "tester" completed');
    const childCall = agents.calls.find((c) => c.child)!;
    for (const t of ["subagent_message", "subagents_list", "subagent_stop", '"subagent"']) expect(childCall.request).not.toContain(t);
  });
});
