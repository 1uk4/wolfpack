/**
 * Subagent concurrency caps and the queue, on real wolves (startTestWolf: real sqlite + pi-durable, scripted model):
 * the per-wolf cap, the per-host cap (two wolves sharing a slot dir), FIFO order, queue positions, restart with a
 * queued child, stale-slot recovery.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary, WolfEvent } from "@wolfpack/protocol";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "./scripted-model.js";
import { SlotPool } from "./subagent-slots.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

const wolves: TestWolf[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const w of wolves.splice(0)) await w.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "subagents-caps-"));
  dirs.push(d);
  return d;
};

/** A child whose brief says `SLOW-x` waits for gate x (or its cancellation); any other child answers at once. */
function agents(gates: Record<string, Promise<void>> = {}) {
  const started: string[] = [];
  const step: FauxResponseStep = async (ctx, options) => {
    const system = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
    const child = system.includes("You are the sub-agent");
    const last = ctx.messages[ctx.messages.length - 1];
    const text = typeof last.content === "string" ? last.content : (last.content as Array<{ type: string; text?: string }>).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    const tool = (name: string, args: Record<string, string>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    if (!child) {
      if (last.role === "toolResult") return fauxAssistantMessage(`ok:${last.toolName}`);
      const spawn = /^spawn\[(\w+)\]: (.*)$/s.exec(text);
      if (spawn) return tool("subagent", { agent: "tester", task: spawn[2], name: spawn[1] });
      const msg = /^message\[(\w+)\]: (.*)$/s.exec(text);
      if (msg) return tool("subagent_message", { name: msg[1], message: msg[2] });
      const stop = /^stop\[(\w+)\]$/.exec(text);
      if (stop) return tool("subagent_stop", { name: stop[1] });
      return fauxAssistantMessage("parent noted");
    }
    if (last.role === "toolResult") return fauxAssistantMessage("child finished");
    const first = /^(\S+)/.exec(text)?.[1] ?? text;
    started.push(first);
    const gate = /SLOW-(\w+)/.exec(text)?.[1];
    if (gate) {
      const signal = options?.signal;
      await Promise.race([gates[gate], new Promise<void>((r) => signal?.addEventListener("abort", () => r()))]);
      if (signal?.aborted) return fauxAssistantMessage("", { stopReason: "aborted" });
    }
    return fauxAssistantMessage(`DONE(${first})`);
  };
  return { step, started };
}
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

async function boot(a: { step: FauxResponseStep }, o: { yaml?: string; env?: Record<string, string>; name?: string; root?: string; slots?: string } = {}): Promise<TestWolf> {
  const w = await startTestWolf({
    script: Array.from({ length: 60 }, () => a.step),
    ...(o.name ? { name: o.name } : {}),
    ...(o.root ? { root: o.root } : {}),
    yaml: o.yaml ?? "",
    env: { WOLFPACK_SUBAGENT_SLOT_POLL_MS: "50", ...(o.slots ? { WOLFPACK_SUBAGENT_SLOTS: o.slots } : {}), ...(o.env ?? {}) },
  });
  const dir = join(w.root, "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tester.md"), "---\nname: tester\ndescription: A scripted test agent\nmodel: fast\ntools: read, grep\n---\n\nYou are a test agent.\n");
  wolves.push(w);
  return w;
}

const say = async (w: TestWolf, text: string) => {
  await w.client.submit(w.home, text, { whenBusy: "reject" });
  for await (const _ of w.client.watch(w.home));
};
const kids = (w: TestWolf) => w.client.listChildren!(w.home);
const byName = async (w: TestWolf) => Object.fromEntries((await kids(w)).map((c) => [c.title, c])) as Record<string, ThreadSummary>;
const view = async (w: TestWolf) => Object.entries(await byName(w)).map(([n, c]) => `${n}:${c.state}${c.queuePosition ? `#${c.queuePosition}` : ""}`).sort();
const settled = (w: TestWolf, expected: string[]) => vi.waitFor(async () => expect(await view(w)).toEqual([...expected].sort()), { timeout: 8000 });
const parentIdle = (w: TestWolf) => vi.waitFor(async () => expect((await w.client.getThread(w.home)).busy).toBe(false), { timeout: 8000 });
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
const slotFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []);

describe("per-wolf cap", () => {
  it("runs 2, queues the rest in FIFO order with positions, and starts them as slots free", async () => {
    const g = { a: gate(), b: gate(), c: gate(), d: gate() };
    const ag = agents({ a: g.a.p, b: g.b.p, c: g.c.p, d: g.d.p });
    const w = await boot(ag, { yaml: "subagents:\n  maxRunning: 2\n", slots: tmp() });
    const seen: WolfEvent[] = [];
    const stop = new AbortController();
    void (async () => {
      for await (const ev of w.client.watchActivity!("testwolf", { signal: stop.signal })) seen.push(ev);
    })().catch(() => {});

    for (const n of ["a", "b", "c", "d"]) {
      await say(w, `spawn[${n}]: SLOW-${n}`);
      await parentIdle(w);
    }
    await settled(w, ["a:running", "b:running", "c:queued#1", "d:queued#2"]);
    expect(ag.started).toEqual(["SLOW-a", "SLOW-b"]); // the queued ones were not started

    // the queued child's thread is there, with the brief not yet sent
    const c = (await byName(w)).c;
    expect((await w.client.getThread(c.id)).messages).toEqual([]);

    g.a.open(); // a frees its slot: c (first in) starts, d moves up
    await settled(w, ["a:done", "b:running", "c:running", "d:queued#1"]);
    expect(ag.started).toEqual(["SLOW-a", "SLOW-b", "SLOW-c"]);
    g.b.open();
    await settled(w, ["a:done", "b:done", "c:running", "d:running"]);
    expect(ag.started).toEqual(["SLOW-a", "SLOW-b", "SLOW-c", "SLOW-d"]);
    g.c.open();
    g.d.open();
    await settled(w, ["a:done", "b:done", "c:done", "d:done"]);

    stop.abort();
    const updates = seen.filter((e): e is Extract<WolfEvent, { type: "thread-updated" }> => e.type === "thread-updated").map((e) => e.thread);
    const positions = (title: string) => updates.filter((t) => t.title === title && t.state === "queued").map((t) => t.queuePosition).filter((p, i, all) => p !== all[i - 1]);
    expect(positions("c")).toEqual([1]);
    expect(positions("d")).toEqual([2, 1]); // updated as the queue moved
    // each delivered its result to the parent
    await vi.waitFor(async () => expect((await w.client.getThread(w.home)).messages.filter((m) => m.text.includes("completed")).length).toBe(4), { timeout: 8000 });
  });

  it("the default is 3 per wolf", async () => {
    const g = gate();
    const w = await boot(agents({ a: g.p, b: g.p, c: g.p, d: g.p }), { slots: tmp() });
    for (const n of ["a", "b", "c", "d"]) {
      await say(w, `spawn[${n}]: SLOW-${n}`);
      await parentIdle(w);
    }
    await settled(w, ["a:running", "b:running", "c:running", "d:queued#1"]);
    g.open();
  });

  it("a finished child's slot is free again, a stop frees one, and a stopped queued child leaves the queue", async () => {
    const g = { a: gate(), b: gate(), c: gate() };
    const ag = agents({ a: g.a.p, b: g.b.p, c: g.c.p });
    const w = await boot(ag, { yaml: "subagents:\n  maxRunning: 1\n", slots: tmp() });
    for (const n of ["a", "b", "c"]) {
      await say(w, `spawn[${n}]: SLOW-${n}`);
      await parentIdle(w);
    }
    await settled(w, ["a:running", "b:queued#1", "c:queued#2"]);
    await say(w, "stop[b]"); // a queued child is stopped: c moves up
    await parentIdle(w);
    await settled(w, ["a:running", "b:stopped", "c:queued#1"]);
    await say(w, "stop[a]"); // stopping the runner starts c
    await settled(w, ["a:stopped", "b:stopped", "c:running"]);
    expect(ag.started).toEqual(["SLOW-a", "SLOW-c"]);
    g.c.open();
    await settled(w, ["a:stopped", "b:stopped", "c:done"]);
  });

  it("a message to a queued child waits with it; a resume of a finished child queues when the wolf is full", async () => {
    const g = { a: gate(), b: gate() };
    const ag = agents({ a: g.a.p, b: g.b.p });
    const w = await boot(ag, { yaml: "subagents:\n  maxRunning: 1\n", slots: tmp() });
    await say(w, "spawn[a]: quick");
    await vi.waitFor(async () => expect(await view(w)).toEqual(["a:done"]), { timeout: 8000 });
    await say(w, "spawn[b]: SLOW-b");
    await parentIdle(w);
    await settled(w, ["a:done", "b:running"]);
    await say(w, "message[a]: again"); // a resumes: no slot, so it queues
    await parentIdle(w);
    await settled(w, ["a:queued#1", "b:running"]);
    g.b.open();
    await settled(w, ["a:done", "b:done"]);
    expect(ag.started).toEqual(["quick", "SLOW-b", "again"]);
  });
});

describe("per-host cap", () => {
  it("two wolves share the host cap through the slot dir; a slot freed in one starts the other's queued child", async () => {
    const slots = tmp();
    const ga = { a1: gate(), a2: gate() };
    const gb = { b1: gate() };
    const wa = await boot(agents({ a1: ga.a1.p, a2: ga.a2.p }), { name: "wolfa", slots, env: { WOLFPACK_SUBAGENT_HOST_MAX: "2" } });
    const bAgents = agents({ b1: gb.b1.p });
    const wb = await boot(bAgents, { name: "wolfb", slots, env: { WOLFPACK_SUBAGENT_HOST_MAX: "2" } });
    for (const n of ["a1", "a2"]) {
      await say(wa, `spawn[${n}]: SLOW-${n}`);
      await parentIdle(wa);
    }
    await settled(wa, ["a1:running", "a2:running"]);
    expect(slotFiles(slots).sort()).toEqual(["wolfa~" + (await byName(wa)).a1.id.replace(/[^A-Za-z0-9_-]/g, "_") + ".json", "wolfa~" + (await byName(wa)).a2.id.replace(/[^A-Za-z0-9_-]/g, "_") + ".json"].sort());

    await say(wb, "spawn[b1]: SLOW-b1"); // wolf b is far under its own cap (3) but the host is full
    await parentIdle(wb);
    await settled(wb, ["b1:queued#1"]);
    expect(bAgents.started).toEqual([]);

    ga.a1.open(); // wolf a gives a host slot back
    await settled(wb, ["b1:running"]);
    expect(bAgents.started).toEqual(["SLOW-b1"]);
    gb.b1.open();
    ga.a2.open();
    await settled(wb, ["b1:done"]);
    await settled(wa, ["a1:done", "a2:done"]);
    await vi.waitFor(() => expect(slotFiles(slots)).toEqual([]), { timeout: 8000 }); // every slot given back
  });
});

describe("restart", () => {
  it("a queued child survives a restart, keeps its place and starts once a slot is free; the running one still reports", async () => {
    const root = tmp();
    const slots = tmp();
    const yaml = "subagents:\n  maxRunning: 1\n";
    const first = gate();
    const w1 = await boot(agents({ a: first.p, b: first.p, c: first.p }), { root, yaml, slots });
    for (const n of ["a", "b", "c"]) {
      await say(w1, `spawn[${n}]: SLOW-${n}`);
      await parentIdle(w1);
    }
    await settled(w1, ["a:running", "b:queued#1", "c:queued#2"]);
    await w1.stop();
    wolves.length = 0;
    expect(slotFiles(slots)).toEqual([]); // a clean shutdown gives the slots back

    const open = gate();
    open.open();
    const ag2 = agents({ a: open.p, b: open.p, c: open.p });
    const w2 = await boot(ag2, { root, yaml, slots });
    await settled(w2, ["a:done", "b:done", "c:done"]);
    expect(ag2.started).toEqual(["SLOW-a", "SLOW-b", "SLOW-c"]); // the queue kept its order
    await vi.waitFor(async () => expect((await w2.client.getThread(w2.home)).messages.filter((m) => m.text.includes("completed")).length).toBe(3), { timeout: 8000 });
  });

  it("a restart holding the queue stays queued while the host is full, with its position", async () => {
    const root = tmp();
    const slots = tmp();
    const yaml = "subagents:\n  maxRunning: 1\n";
    const g = gate();
    const w1 = await boot(agents({ a: g.p, b: g.p }), { root, yaml, slots });
    for (const n of ["a", "b"]) {
      await say(w1, `spawn[${n}]: SLOW-${n}`);
      await parentIdle(w1);
    }
    await w1.stop();
    wolves.length = 0;
    // another wolfd on the host fills the whole host (cap 1)
    mkdirSync(slots, { recursive: true });
    writeFileSync(join(slots, "other~x.json"), JSON.stringify({ pid: process.pid, wolf: "other", child: "x" }));
    const h = gate();
    const ag = agents({ a: h.p, b: h.p });
    const w2 = await boot(ag, { root, yaml, slots, env: { WOLFPACK_SUBAGENT_HOST_MAX: "1" } });
    // a was running, so it still holds its slot (over the host cap); b waits
    await settled(w2, ["a:running", "b:queued#1"]);
    h.open();
    await settled(w2, ["a:done", "b:queued#1"]); // the other wolfd still fills the host
    rmSync(join(slots, "other~x.json"));
    await settled(w2, ["a:done", "b:done"]);
  });
});

describe("stale slots", () => {
  it("a slot whose wolfd died does not count and is swept", async () => {
    const slots = tmp();
    mkdirSync(slots, { recursive: true });
    writeFileSync(join(slots, "ghost~sub_1.json"), JSON.stringify({ pid: deadPid(), wolf: "ghost", child: "sub-1" }));
    writeFileSync(join(slots, "ghost~sub_2.json"), "{torn");
    const utimes = await import("node:fs");
    utimes.utimesSync(join(slots, "ghost~sub_2.json"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const g = gate();
    const w = await boot(agents({ a: g.p }), { slots, env: { WOLFPACK_SUBAGENT_HOST_MAX: "1" } });
    await say(w, "spawn[a]: SLOW-a");
    await parentIdle(w);
    await settled(w, ["a:running"]); // the host cap is 1 and a ghost "held" it
    expect(slotFiles(slots).some((f) => f.startsWith("ghost~"))).toBe(false);
    g.open();
    await settled(w, ["a:done"]);
  });

  it("a stale lock left by a dead process is broken", async () => {
    const slots = tmp();
    mkdirSync(join(slots, ".lock"), { recursive: true });
    const old = new Date(Date.now() - 60_000);
    (await import("node:fs")).utimesSync(join(slots, ".lock"), old, old);
    const w = await boot(agents(), { slots });
    await say(w, "spawn[a]: quick");
    await settled(w, ["a:done"]);
  });

  it("after a crash the wolf's own leftover slots are dropped at boot (one wolfd per wolf)", async () => {
    const root = tmp();
    const slots = tmp();
    const w1 = await boot(agents(), { root, slots, env: { WOLFPACK_SUBAGENT_HOST_MAX: "1" } });
    await w1.stop();
    wolves.length = 0;
    // its previous process died holding a slot (here the pid is still alive, as it is the test process)
    mkdirSync(slots, { recursive: true });
    writeFileSync(join(slots, "testwolf~sub_gone.json"), JSON.stringify({ pid: process.pid, pool: "closed-pool", wolf: "testwolf", child: "sub-gone" }));
    const w2 = await boot(agents(), { root, slots, env: { WOLFPACK_SUBAGENT_HOST_MAX: "1" } });
    await say(w2, "spawn[a]: quick");
    await settled(w2, ["a:done"]);
    expect(slotFiles(slots).some((f) => f.includes("sub_gone"))).toBe(false);
  });
});

const poolOf = (w: TestWolf) => (w.wolf.server as unknown as { subagents: { pool: SlotPool } }).subagents.pool;

describe("slot directory failures", () => {
  it("an unwritable slot dir does not crash wolfd: the child queues, then starts once the dir works", async () => {
    const base = tmp();
    const blocker = join(base, "blocker");
    writeFileSync(blocker, "a file where the directory should be");
    const g = gate();
    const w = await boot(agents({ a: g.p }), { slots: join(blocker, "slots") });
    await say(w, "spawn[a]: SLOW-a");
    await parentIdle(w);
    await settled(w, ["a:queued#1"]);
    await new Promise((r) => setTimeout(r, 200)); // several polls fail: still alive and queued
    await settled(w, ["a:queued#1"]);
    rmSync(blocker);
    await settled(w, ["a:running"]);
    g.open();
    await settled(w, ["a:done"]);
  });
});

describe("slot pool", () => {
  it("concurrent takers racing over a stale lock: exactly hostMax win", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".lock"));
    writeFileSync(join(dir, ".lock", "owner"), "9999999:dead:token");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, ".lock"), old, old);
    const pools = Array.from({ length: 8 }, (_, i) => new SlotPool(dir, 3, `w${i}`));
    const got = await Promise.all(pools.map((p, i) => p.tryAcquire(`c${i}`)));
    expect(got.filter(Boolean)).toHaveLength(3);
    expect(slotFiles(dir)).toHaveLength(3);
    expect(readdirSync(dir).filter((f) => f.startsWith(".lock"))).toEqual([]); // lock and stale remnants gone
    pools.forEach((p) => p.close());
  });

  it("a slot whose pid now belongs to another process (start time differs) is stale", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "old~c.json"), JSON.stringify({ pid: process.pid, start: "Mon Jan  1 00:00:00 1990", wolf: "old", child: "c" }));
    const p = new SlotPool(dir, 1, "me");
    expect(await p.tryAcquire("x")).toBe(true);
    expect(slotFiles(dir)).toEqual(["me~x.json"]);
    p.close();
  });

  it("two live wolfds with the same name: neither drops the other's slots", async () => {
    const slots = tmp();
    const g = gate();
    const a = await boot(agents({ a: g.p }), { name: "twin", slots, env: { WOLFPACK_SUBAGENT_HOST_MAX: "1" } });
    await say(a, "spawn[a]: SLOW-a");
    await settled(a, ["a:running"]);
    const b = await boot(agents(), { name: "twin", slots, env: { WOLFPACK_SUBAGENT_HOST_MAX: "1" } }); // boot runs dropOwn
    expect(slotFiles(slots)).toHaveLength(1); // a's slot survived b's boot
    await say(b, "spawn[b]: quick");
    await parentIdle(b);
    await settled(b, ["b:queued#1"]); // the host (cap 1) is still full
    g.open();
    await settled(b, ["b:done"]);
  });

  it("stop while its slot is being taken: the child stays stopped, never starts, and gives the slot back", async () => {
    const slots = tmp();
    const g = { a: gate(), b: gate() };
    const ag = agents({ a: g.a.p, b: g.b.p });
    const w = await boot(ag, { yaml: "subagents:\n  maxRunning: 1\n", slots });
    await say(w, "spawn[a]: SLOW-a");
    await say(w, "spawn[b]: SLOW-b");
    await parentIdle(w);
    await settled(w, ["a:running", "b:queued#1"]);
    const pool = poolOf(w);
    const orig = pool.tryAcquire.bind(pool);
    const latch = gate();
    pool.tryAcquire = async (id) => {
      await latch.p;
      return orig(id);
    };
    g.a.open();
    await settled(w, ["a:done", "b:queued#1"]);
    await say(w, "stop[b]");
    await settled(w, ["a:done", "b:stopped"]);
    latch.open();
    await new Promise((r) => setTimeout(r, 200));
    expect(ag.started).toEqual(["SLOW-a"]);
    expect(await view(w)).toEqual(["a:done", "b:stopped"]);
    expect(slotFiles(slots)).toEqual([]);
  });

  it("close while a slot is being acquired gives it back", async () => {
    const slots = tmp();
    const g = gate();
    const w = await boot(agents({ a: g.p, b: g.p }), { yaml: "subagents:\n  maxRunning: 1\n", slots });
    await say(w, "spawn[a]: SLOW-a");
    await say(w, "spawn[b]: SLOW-b");
    await parentIdle(w);
    await settled(w, ["a:running", "b:queued#1"]);
    const pool = poolOf(w);
    const orig = pool.tryAcquire.bind(pool);
    const latch = gate();
    pool.tryAcquire = async (id) => {
      await latch.p;
      return orig(id);
    };
    g.open(); // a finishes: the pump starts taking b's slot, held at the latch
    await vi.waitFor(async () => expect(await view(w)).toContain("a:done"), { timeout: 8000 });
    await w.stop();
    wolves.length = 0;
    latch.open();
    await new Promise((r) => setTimeout(r, 200));
    expect(slotFiles(slots)).toEqual([]);
  });
});
