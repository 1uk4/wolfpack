/**
 * task_done's ship gate over /v1: a real wolfd turn (pi-durable, scripted model) with the durable task tools against a
 * sandboxed in-memory Work server (a local http server: nothing touches the live ledger).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CardAnswers } from "@wolfpack/protocol";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { fauxAssistantMessage, fauxToolCall } from "../../packages/harness/src/wolfd/scripted-model.js";
import { startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import createTasksExtension, { type TasksConfig } from "./unified-tasks.js";

type Item = Record<string, any>;
let items: Map<string, Item>;
let server: Server;
let endpoint: string;
let n: number;
let tw: TestWolf | undefined;

const add = (o: Item) => {
  const id = `work-${++n}`;
  items.set(id, { id, stage: "approved", log: [], container: false, assignee: "1uk4", domain: "wolfpack", body: null, partOf: null, ...o });
  return items.get(id)!;
};

beforeEach(async () => {
  items = new Map();
  n = 0;
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
      if (req.method === "GET" && id === "") {
        const partOf = u.searchParams.get("partOf");
        return send({ items: [...items.values()].filter((i) => !partOf || i.partOf === partOf) });
      }
      const it = items.get(id);
      if (!it) return send({ error: "not found" }, 404);
      if (req.method === "GET") return send({ item: it, body: it.body });
      if (req.method === "PATCH") {
        if (body.stage) it.stage = body.stage;
        if (body.note) it.log.push({ at: "now", text: body.note });
        if (typeof body.body === "string") it.body = body.body;
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
  await new Promise((r) => server.close(r));
});

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const drain = async (w: TestWolf) => {
  for await (const _ of w.client.watch(w.home));
};
const lastUserText = (context: { messages: { role: string; content: unknown }[] }): string => {
  const u = context.messages.filter((m) => m.role === "user").at(-1);
  return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content);
};
const toolText = (context: { messages: { role: string; content: unknown }[] }): string => {
  const t = context.messages.filter((m) => m.role === "toolResult").at(-1);
  return JSON.stringify(t?.content ?? "");
};

/** A wolf with the durable task tools wired as wolfd loads them: adapted, card tools registered with the card guard. */
const wolf = (script: Parameters<typeof startTestWolf>[0]["script"], tasks: TasksConfig = {}, env: Record<string, string> = {}) =>
  startTestWolf({
    script,
    hooks: {
      extensions: (rt) => [
        adaptToDurable(
          createTasksExtension(tasks, { wolfDen: rt.den, wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: {}, env: { ...rt.env, WORK_ENDPOINT: endpoint, WORK_TOKEN: "t", ...env } } as never),
          { wolfDen: rt.den, wolfName: "1uk4", onCardTool: rt.onCardTool },
        ),
      ],
    },
  });

const answer = (w: TestWolf, callId: string, confirm: boolean) => w.client.answerCard!(w.home, callId, { confirm: { value: confirm } } as CardAnswers);

describe("durable task_done ship gate (confirm card)", () => {
  it("raises a confirm card without shipping; yes → the model calls task_done again → shipped → idle", async () => {
    const t = add({ kind: "task", title: "Ship me" });
    let seen = "";
    tw = await wolf([
      toolUse(fauxToolCall("task_done", { id: t.id })),
      (context) => {
        seen = lastUserText(context as never);
        return toolUse(fauxToolCall("task_done", { id: t.id, confirm: false }));
      },
      fauxAssistantMessage("shipped"),
    ]);
    await tw.submit("finish up");
    const d0 = await tw.client.getThread(tw.home);
    expect(d0.status).toBe("needs-you");
    expect(d0.pendingCards).toHaveLength(1);
    const card = d0.pendingCards![0].card;
    expect(card.tool).toBe("task_done");
    expect(card.fields[0]).toMatchObject({ id: "confirm", kind: "confirm", label: `Ship "Ship me" (${t.id})?`, confirmLabel: "Ship", rejectLabel: "Not yet" });
    expect((card.fields[0] as { default?: boolean }).default).toBeUndefined();
    expect(items.get(t.id)!.stage).toBe("approved");
    expect(tw.scripted.faux.state.callCount).toBe(1);

    expect((await answer(tw, d0.pendingCards![0].callId, true)).disposition).toBe("started");
    await drain(tw);
    expect(seen).toContain(`answered your task_done question`);
    expect(seen).toContain(`Ship "Ship me" (${t.id})?: yes (Ship)`);
    expect(items.get(t.id)!.stage).toBe("shipped");
    expect((await tw.client.getThread(tw.home)).status).toBe("idle");
  });

  it("the bound task ships through the same gate", async () => {
    const t = add({ kind: "task", title: "Bound one" });
    tw = await wolf([
      toolUse(fauxToolCall("task_bind", { id: t.id })),
      toolUse(fauxToolCall("task_done", {})),
      () => toolUse(fauxToolCall("task_done", { confirm: false })),
      fauxAssistantMessage("done"),
    ]);
    await tw.submit("go");
    const d0 = await tw.client.getThread(tw.home);
    expect(d0.status).toBe("needs-you");
    expect(items.get(t.id)!.stage).toBe("approved");
    await answer(tw, d0.pendingCards![0].callId, true);
    await drain(tw);
    expect(items.get(t.id)!.stage).toBe("shipped");
  });

  it("no → nothing ships and the model is told; a bare confirm:false without a yes raises a card instead of shipping", async () => {
    const t = add({ kind: "task", title: "Hold me" });
    let seen = "";
    tw = await wolf([
      toolUse(fauxToolCall("task_done", { id: t.id })),
      (context) => {
        seen = lastUserText(context as never);
        return toolUse(fauxToolCall("task_done", { id: t.id, confirm: false })); // tries to bypass the no
      },
      fauxAssistantMessage("ok, holding"),
    ]);
    await tw.submit("finish");
    const [p] = (await tw.client.getThread(tw.home)).pendingCards!;
    await answer(tw, p.callId, false);
    await drain(tw);
    expect(seen).toContain("no (Not yet)");
    expect(items.get(t.id)!.stage).toBe("approved");
    const d = await tw.client.getThread(tw.home);
    expect(d.status).toBe("needs-you"); // a fresh question, not a ship
    expect(d.pendingCards).toHaveLength(1);
  });

  it("confirm:false with no question asked never ships (the model cannot skip the gate)", async () => {
    const t = add({ kind: "task", title: "Sneaky" });
    tw = await wolf([toolUse(fauxToolCall("task_done", { id: t.id, confirm: false })), fauxAssistantMessage("unreachable")]);
    await tw.submit("go");
    expect(items.get(t.id)!.stage).toBe("approved");
    expect((await tw.client.getThread(tw.home)).pendingCards).toHaveLength(1);
  });

  it("two task_done calls for the same task while pending raise one card", async () => {
    const t = add({ kind: "task", title: "Twice" });
    tw = await wolf([toolUse(fauxToolCall("task_done", { id: t.id }), fauxToolCall("task_done", { id: t.id })), fauxAssistantMessage("unreachable")]);
    await tw.submit("go");
    const d = await tw.client.getThread(tw.home);
    expect(d.pendingCards).toHaveLength(1);
    expect(d.status).toBe("needs-you");
    expect(tw.scripted.faux.state.callCount).toBe(1); // the duplicate did not let the model run on
    expect(items.get(t.id)!.stage).toBe("approved");
  });

  it("a different task gets its own card", async () => {
    const a = add({ kind: "task", title: "A" });
    const b = add({ kind: "task", title: "B" });
    tw = await wolf([toolUse(fauxToolCall("task_done", { id: a.id }), fauxToolCall("task_done", { id: b.id }))]);
    await tw.submit("go");
    expect((await tw.client.getThread(tw.home)).pendingCards).toHaveLength(2);
  });

  it("auto policy (WOLFPACK_TASK_SHIP=auto) ships at once, no card", async () => {
    const t = add({ kind: "task", title: "Auto env" });
    tw = await wolf([toolUse(fauxToolCall("task_done", { id: t.id })), fauxAssistantMessage("done")], {}, { WOLFPACK_TASK_SHIP: "auto" });
    await tw.submit("go");
    expect(items.get(t.id)!.stage).toBe("shipped");
    const d = await tw.client.getThread(tw.home);
    expect(d.pendingCards ?? []).toHaveLength(0);
    expect(d.status).toBe("idle");
  });

  it("auto policy via tasks.autoShip config ships at once", async () => {
    const t = add({ kind: "task", title: "Auto cfg" });
    tw = await wolf([toolUse(fauxToolCall("task_done", { id: t.id })), fauxAssistantMessage("done")], { autoShip: true });
    await tw.submit("go");
    expect(items.get(t.id)!.stage).toBe("shipped");
  });
});

describe("headless: no conversation behind the tool", () => {
  it("ships without a card (no engine, no one to answer)", async () => {
    const t = add({ kind: "task", title: "Headless" });
    const ext = createTasksExtension({}, { wolfDen: "/tmp/none", wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: {}, env: { WORK_ENDPOINT: endpoint, WORK_TOKEN: "t" } } as never);
    const tool = ext.tools!.find((x) => x.name === "task_done")!;
    const r = await tool.execute({ id: t.id }, { cwd: "/tmp", wolfDen: "/tmp/none", wolfName: "1uk4", conversationId: 1 });
    expect(r.card).toBeUndefined();
    expect(r.content[0].text).toContain(`Shipped: ${t.id}`);
    expect(items.get(t.id)!.stage).toBe("shipped");
  });
});
