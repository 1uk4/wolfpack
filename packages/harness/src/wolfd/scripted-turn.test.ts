/** Real pi-durable turns over /v1 with a scripted model (no LLM): the afterResponse generation hook fires. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
