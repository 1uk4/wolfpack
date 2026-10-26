/** Real pi-durable turns over /v1 with a scripted model (no LLM): the afterResponse generation hook fires. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
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

  it("memory routes say the extension is not loaded (versus inert) when it is absent", async () => {
    tw = await startTestWolf({ script: [] });
    const res = await fetch(`${tw.url}/v1/wolves/testwolf/memory/consolidate`, { method: "POST", headers: { "X-Protocol-Version": "1" } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("memory_unavailable");
    expect(body.message).toMatch(/memory is off: the memory extension is not loaded/);
  });
});
