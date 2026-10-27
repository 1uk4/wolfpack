/** Real pi-durable turns over /v1 with a scripted model (no LLM): the afterResponse generation hook fires. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { DEFAULT_STRUCTURED_OUTPUT_GUIDANCE } from "./context.js";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

describe("scripted model turns", () => {
  it("plays a scripted reply into the thread and fires afterResponse", async () => {
    const seen: string[] = [];
    tw = await startTestWolf({
      script: [fauxAssistantMessage("pong")],
      hooks: { afterResponse: ({ message }) => void seen.push(message.content.map((b) => (b.type === "text" ? b.text : "")).join("")) },
    });
    const events = await tw.submit("ping");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });

    const detail = await tw.client.getThread(tw.home);
    expect(detail.busy).toBe(false);
    expect(detail.messages.map((m) => [m.role, m.text])).toEqual([["user", "ping"], ["assistant", "pong"]]);

    expect(seen).toEqual(["pong"]);
    expect(tw.afterResponse).toHaveLength(1);
    expect(tw.afterResponse[0].message.stopReason).toBe("stop");
    expect(tw.scripted.faux.state.callCount).toBe(1);
  });

  it("runs a tool round: afterResponse fires per model response, the tool really executes", async () => {
    tw = await startTestWolf({
      script: [
        fauxAssistantMessage([fauxText("writing"), fauxToolCall("write", { path: "out.txt", content: "hello" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
    });
    const events = await tw.submit("write a file");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });
    expect(tw.afterResponse.map((c) => c.message.stopReason)).toEqual(["toolUse", "stop"]);
    expect(new Set(tw.afterResponse.map((c) => c.conversationId)).size).toBe(1);
    const detail = await tw.client.getThread(tw.home);
    expect(detail.messages.at(-1)).toMatchObject({ role: "assistant", text: "writing\n\ndone" });
    expect(readFileSync(join(tw.wolf.config.capability.workspace, "out.txt"), "utf8")).toBe("hello");
  });

  it("offers the model every loaded extension's tools, not just the coding tools (the provider-bound tool list)", async () => {
    let offered: string[] = [];
    const ext = defineExtension({
      name: "test-ext",
      tools: [
        defineTool({
          name: "task_bind",
          description: "bind",
          parameters: { type: "object" as const, properties: {}, required: [] },
          async execute() {
            return { output: [{ type: "text" as const, text: "ok" }] };
          },
        }),
      ],
    });
    tw = await startTestWolf({
      script: [
        (context) => {
          // Tool declarations travel on the transcript's system messages (`toolsAdded`).
          offered = context.messages.flatMap((m) => ((m as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map((t) => t.name));
          return fauxAssistantMessage("pong");
        },
      ],
      hooks: { extensions: [ext] },
    });
    await tw.submit("ping");
    expect(offered).toEqual(expect.arrayContaining(["bash", "read", "write", "edit", "task_bind"]));
    expect(new Set(offered).size).toBe(offered.length);
  });

  it("wolf.yaml prompts.structuredOutput reaches the model's instructions (default, string, false)", async () => {
    const seen = async (yaml?: string) => {
      let ctx = "";
      tw = await startTestWolf({
        script: [(context) => { ctx = JSON.stringify(context); return fauxAssistantMessage("pong"); }],
        ...(yaml ? { yaml } : {}),
      });
      await tw.submit("ping");
      await tw.stop();
      tw = undefined;
      return ctx;
    };
    // ctx is JSON-stringified, so compare against the escaped default text.
    const defaultText = JSON.stringify(DEFAULT_STRUCTURED_OUTPUT_GUIDANCE).slice(1, -1);
    expect(await seen()).toContain(defaultText);
    const custom = await seen("prompts:\n  structuredOutput: CUSTOM-GUIDE\n");
    expect(custom).toContain("CUSTOM-GUIDE");
    expect(custom).not.toContain(defaultText);
    expect(await seen("prompts:\n  structuredOutput: false\n")).not.toContain("# Structured output");
  });

  it("show_decision twice with one objectId: two object-upsert revs, history holds one object at the latest rev", async () => {
    const d1 = {
      objectId: "db",
      title: "Datastore",
      options: [{ id: "pg", label: "Postgres" }, { id: "sq", label: "SQLite", detail: "embedded" }],
      chosen: "pg",
      rationale: "Concurrent writers.",
    };
    const d2 = { ...d1, chosen: "sq", rationale: "Single writer after all." };
    tw = await startTestWolf({
      script: [
        fauxAssistantMessage([fauxText("Weighing it"), fauxToolCall("show_decision", d1 as never)], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("show_decision", d2 as never)], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
    });
    const events = await tw.submit("pick a datastore");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });
    const upserts = events.filter((e) => e.type === "object-upsert");
    expect(upserts.map((e) => [e.objectId, e.objectType, e.rev])).toEqual([["db", "decision", 1], ["db", "decision", 2]]);
    // The event anchors like the history object: merged text length when the call happened.
    expect(upserts.map((e) => e.textOffset)).toEqual(["Weighing it".length, "Weighing it".length]);
    expect(upserts[1]).toMatchObject({ data: { chosen: "sq", rationale: "Single writer after all." } });
    expect(events.filter((e) => e.type === "tool-end").map((e) => e.result)).toEqual(['Shown decision "db".', 'Shown decision "db".']);

    const detail = await tw.client.getThread(tw.home);
    const objects = detail.messages.flatMap((m) => m.objects ?? []);
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ objectId: "db", type: "decision", rev: 2, data: { chosen: "sq", title: "Datastore" } });
    expect(objects[0].textOffset).toBe("Weighing it".length);
  });

  it("a revision in a later turn bumps the rev and the history object stays in the first message; long data survives uncapped", async () => {
    const long = "because ".repeat(1500); // well over the 1 KiB / 4 KiB caps on tool-call args
    const d = (chosen: string, rationale: string) => ({
      objectId: "db",
      options: [{ id: "pg", label: "Postgres", detail: long }, { id: "sq", label: "SQLite" }],
      chosen,
      rationale,
    });
    tw = await startTestWolf({
      script: [
        fauxAssistantMessage([fauxToolCall("show_decision", d("pg", long) as never)], { stopReason: "toolUse" }),
        fauxAssistantMessage("first"),
        fauxAssistantMessage([fauxToolCall("show_decision", d("sq", "short") as never)], { stopReason: "toolUse" }),
        fauxAssistantMessage("second"),
      ],
    });
    const first = await tw.submit("one");
    expect(first.filter((e) => e.type === "object-upsert").map((e) => e.rev)).toEqual([1]);
    // Full data on the object while the tool call's own args are capped (the reload bug this pins).
    const afterFirst = await tw.client.getThread(tw.home);
    expect((afterFirst.messages.flatMap((m) => m.objects ?? [])[0]!.data as { rationale: string }).rationale).toBe(long);
    expect(afterFirst.messages.flatMap((m) => m.tools ?? []).some((t) => (t.args as { _truncated?: boolean })._truncated)).toBe(true);
    const second = await tw.submit("two");
    expect(second.filter((e) => e.type === "object-upsert").map((e) => e.rev)).toEqual([2]);

    const detail = await tw.client.getThread(tw.home);
    const withObjects = detail.messages.filter((m) => m.objects?.length);
    expect(withObjects).toHaveLength(1);
    expect(withObjects[0]!.id).toBe(detail.messages.find((m) => m.role === "assistant")!.id);
    expect(withObjects[0]!.objects![0]).toMatchObject({ rev: 2, data: { chosen: "sq", rationale: "short" } });

  });

  it("a show_decision whose chosen id is not an option yields no object (and the model gets an error)", async () => {
    tw = await startTestWolf({
      script: [
        fauxAssistantMessage([fauxToolCall("show_decision", { objectId: "x", options: [{ id: "a", label: "A" }], chosen: "zzz", rationale: "r" } as never)], { stopReason: "toolUse" }),
        fauxAssistantMessage("ok"),
      ],
    });
    const events = await tw.submit("decide");
    expect(events.filter((e) => e.type === "object-upsert")).toHaveLength(0);
    expect(events.filter((e) => e.type === "tool-end").map((e) => e.isError)).toEqual([true]);
  });

  it("a show_decision with invalid arguments yields no object", async () => {
    tw = await startTestWolf({
      script: [
        fauxAssistantMessage([fauxToolCall("show_decision", { objectId: "x", options: [], chosen: "a", rationale: "r" } as never)], { stopReason: "toolUse" }),
        fauxAssistantMessage("ok"),
      ],
    });
    const events = await tw.submit("decide");
    expect(events.filter((e) => e.type === "object-upsert")).toHaveLength(0);
    const detail = await tw.client.getThread(tw.home);
    expect(detail.messages.flatMap((m) => m.objects ?? [])).toHaveLength(0);
  });

  it("show_checklist twice with one objectId: items tick, two revs, getThread returns the latest; duplicate ids give a tool error and no object", async () => {
    const items = (a: string, b: string) => [{ id: "a", label: "Write", state: a }, { id: "b", label: "Test", state: b }];
    tw = await startTestWolf({
      script: [
        fauxAssistantMessage([fauxToolCall("show_checklist", { objectId: "cl", title: "Plan", items: items("doing", "todo") } as never)], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("show_checklist", { objectId: "cl", title: "Plan", items: items("done", "doing") } as never)], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("show_checklist", { objectId: "bad", items: [{ id: "a", label: "A", state: "todo" }, { id: "a", label: "B", state: "done" }] } as never)], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
    });
    const events = await tw.submit("do it");
    const upserts = events.filter((e) => e.type === "object-upsert");
    expect(upserts.map((e) => [e.objectId, e.objectType, e.rev])).toEqual([["cl", "checklist", 1], ["cl", "checklist", 2]]);
    expect(events.filter((e) => e.type === "tool-end").map((e) => e.isError)).toEqual([false, false, true]);
    const objects = (await tw.client.getThread(tw.home)).messages.flatMap((m) => m.objects ?? []);
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ objectId: "cl", type: "checklist", rev: 2, data: { items: items("done", "doing") } });
  });

  it("show_graph revised: statuses update, history holds one object at the latest rev", async () => {
    const nodes = (s: string[]) => ["design", "build", "ship"].map((id, i) => ({ id, label: id, kind: "step", status: s[i] }));
    const edges = [{ from: "build", to: "design" }, { from: "ship", to: "build" }];
    const g1 = { objectId: "plan", title: "Plan", nodes: nodes(["doing", "todo", "todo"]), edges };
    const g2 = { ...g1, nodes: nodes(["done", "doing", "todo"]) };
    tw = await startTestWolf({
      script: [
        fauxAssistantMessage([fauxToolCall("show_graph", g1 as never)], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("show_graph", g2 as never)], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
    });
    const events = await tw.submit("plan it");
    expect(events.filter((e) => e.type === "object-upsert").map((e) => [e.objectId, e.objectType, e.rev])).toEqual([["plan", "graph", 1], ["plan", "graph", 2]]);
    expect(events.filter((e) => e.type === "tool-end").map((e) => e.result)).toEqual(['Shown graph "plan".', 'Shown graph "plan".']);
    const objects = (await tw.client.getThread(tw.home)).messages.flatMap((m) => m.objects ?? []);
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ objectId: "plan", type: "graph", rev: 2 });
    expect((objects[0]!.data as { nodes: Array<{ status: string }> }).nodes.map((n) => n.status)).toEqual(["done", "doing", "todo"]);
  });

  it.each([
    ["a dangling edge", [{ from: "b", to: "zzz" }]],
    ["a cycle", [{ from: "a", to: "b" }, { from: "b", to: "a" }]],
    ["a self-loop", [{ from: "a", to: "a" }]],
  ])("show_graph with %s is a tool error and yields no object", async (_n, edges) => {
    const n = (id: string) => ({ id, label: id, kind: "task", status: "todo" });
    tw = await startTestWolf({
      script: [
        fauxAssistantMessage([fauxToolCall("show_graph", { objectId: "g", nodes: [n("a"), n("b")], edges } as never)], { stopReason: "toolUse" }),
        fauxAssistantMessage("ok"),
      ],
    });
    const events = await tw.submit("graph");
    expect(events.filter((e) => e.type === "object-upsert")).toHaveLength(0);
    expect(events.filter((e) => e.type === "tool-end").map((e) => e.isError)).toEqual([true]);
    expect((await tw.client.getThread(tw.home)).messages.flatMap((m) => m.objects ?? [])).toHaveLength(0);
  });

  it("memory routes say the extension is not loaded (versus inert) when it is absent", async () => {
    tw = await startTestWolf({ script: [] });
    const res = await fetch(`${tw.url}/v1/wolves/testwolf/memory/consolidate`, { method: "POST", headers: { "X-Protocol-Version": "1" } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("memory_unavailable");
    expect(body.message).toMatch(/memory is off: the memory extension is not loaded/);
  });
});
