import { describe, expect, it } from "vitest";
import { BusyError, type ConsoleClient, type ThreadEvent } from "./index.js";

export async function collect(it: AsyncIterable<ThreadEvent>): Promise<ThreadEvent[]> {
  const out: ThreadEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

export async function homeThread(c: ConsoleClient): Promise<string> {
  const [wolf] = await c.listWolves();
  const [thread] = await c.listThreads(wolf.id);
  return thread.id;
}

/**
 * Behaviour tests against the ConsoleClient interface only. Run against every
 * implementation (mock, HTTP-over-stub) so they stay interchangeable.
 */
export function runBehaviours(label: string, make: () => ConsoleClient): void {
describe(`ConsoleClient (${label})`, () => {
  it("lists the wolf and its home thread", async () => {
    const c = make();
    const [wolf] = await c.listWolves();
    expect(wolf).toMatchObject({ id: "1uk4", host: "local", status: "online" });
    const threads = await c.listThreads(wolf.id);
    expect(threads).toHaveLength(1);
    expect(threads[0].kind).toBe("home");
  });

  it("submit returns without waiting for the turn", async () => {
    const c = make();
    const id = await homeThread(c);
    const ack = await c.submit(id, "hi");
    expect(ack.disposition).toBe("started");
    expect((await c.getThread(id)).busy).toBe(true);
    await collect(c.watch(id));
    const t = await c.getThread(id);
    expect(t.busy).toBe(false);
    expect(t.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("streams the full scripted turn in order with increasing ids", async () => {
    const c = make();
    const id = await homeThread(c);
    await c.submit(id, "read the readme");
    const events = await collect(c.watch(id));

    const ids = events.map((e) => e.id);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn-start");
    expect(types.at(-1)).toBe("turn-end");
    expect((events.at(-1) as Extract<ThreadEvent, { type: "turn-end" }>).reason).toBe("complete");

    const first = (t: string) => types.indexOf(t as ThreadEvent["type"]);
    const last = (t: string) => types.lastIndexOf(t as ThreadEvent["type"]);
    expect(first("thinking-delta")).toBeGreaterThan(first("turn-start"));
    expect(last("thinking-delta")).toBeLessThan(first("text-delta"));
    expect(first("tool-start")).toBeGreaterThan(first("text-delta"));
    expect(types.filter((t) => t === "tool-start")).toHaveLength(1);
    expect(types.filter((t) => t === "tool-end")).toHaveLength(1);
    expect(first("tool-start")).toBeLessThan(first("tool-update"));
    expect(last("tool-update")).toBeLessThan(first("tool-end"));
    // text continues after the tool call
    expect(last("text-delta")).toBeGreaterThan(first("tool-end"));
  });

  it("resumes from a mid-turn event id: replay then live", async () => {
    const c = make();
    const id = await homeThread(c);
    await c.submit(id, "go");
    const full = await collect(c.watch(id));

    const mid = full[Math.floor(full.length / 2)];
    // Resume after the turn finished (pure replay).
    const replay = await collect(c.watch(id, { from: mid.id }));
    expect(replay.map((e) => e.id)).toEqual(full.filter((e) => e.id > mid.id).map((e) => e.id));

    // Resume while the turn is still running (replay + live).
    await c.submit(id, "again");
    const seen: ThreadEvent[] = [];
    let resumed: ThreadEvent[] = [];
    const startOfSecond = (await c.getThread(id)).lastEventId;
    for await (const e of c.watch(id, { from: startOfSecond - 1 })) {
      seen.push(e);
      if (seen.length === 3) {
        resumed = await collect(c.watch(id, { from: e.id }));
        break;
      }
    }
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed[0].id).toBe(seen[2].id + 1);
    expect(resumed.at(-1)?.type).toBe("turn-end");
    const ids = resumed.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("abort terminates the stream with turn-end", async () => {
    const c = make();
    const id = await homeThread(c);
    await c.submit(id, "go");
    const events: ThreadEvent[] = [];
    for await (const e of c.watch(id)) {
      events.push(e);
      if (events.length === 2) await c.abort(id);
    }
    const end = events.at(-1)!;
    expect(end.type).toBe("turn-end");
    expect((end as Extract<ThreadEvent, { type: "turn-end" }>).reason).toBe("aborted");
    expect((await c.getThread(id)).busy).toBe(false);
    // thread is usable again
    await expect(c.submit(id, "next")).resolves.toMatchObject({ disposition: "started" });
  });

  it("whenBusy=reject rejects a second submit mid-turn", async () => {
    const c = make();
    const id = await homeThread(c);
    await c.submit(id, "one");
    await expect(c.submit(id, "two", { whenBusy: "reject" })).rejects.toBeInstanceOf(BusyError);
    await expect(c.submit(id, "three")).rejects.toBeInstanceOf(BusyError);
    await collect(c.watch(id));
  });

  it("whenBusy=followUp runs a second turn after the first", async () => {
    const c = make();
    const id = await homeThread(c);
    await c.submit(id, "one");
    const ack = await c.submit(id, "two", { whenBusy: "followUp" });
    expect(ack.disposition).toBe("queued");
    const first = await collect(c.watch(id));
    expect(first.at(-1)?.type).toBe("turn-end");
    const second = await collect(c.watch(id, { from: first.at(-1)!.id }));
    expect(second[0].type).toBe("turn-start");
    expect(second.at(-1)?.type).toBe("turn-end");
  });
});
}
