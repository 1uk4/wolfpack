/**
 * Subagents on a real wolf (startTestWolf: real sqlite + pi-durable, one scripted model answering every conversation):
 * spawn -> child thread -> result steer to the parent, resume, depth 1, questions to the parent, stop, restart.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
function scriptedAgents(opts: { gate?: Promise<void> } = {}): { step: FauxResponseStep; calls: Call[] } {
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
