/** GET /v1/threads/:id paging on a real wolfd: default unchanged, newest page, older pages, bad limit. */
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

describe("thread transcript paging", () => {
  it("serves the newest page, older pages by cursor, and the whole transcript without params", async () => {
    const turns = 5;
    tw = await startTestWolf({ script: Array.from({ length: turns }, (_, i) => fauxAssistantMessage(`reply ${i}`)) });
    for (let i = 0; i < turns; i++) {
      await tw.client.submit(tw.home, `q ${i}`, { whenBusy: "reject" });
      for await (const _ of tw.client.watch(tw.home));
    }
    const all = await tw.client.getThread(tw.home);
    expect(all.messages).toHaveLength(10);
    expect(all.hasMore).toBeUndefined();
    expect(all.cursor).toBeUndefined();

    const newest = await tw.client.getThread(tw.home, { limit: 4 });
    expect(newest.messages.map((m) => m.id)).toEqual(all.messages.slice(-4).map((m) => m.id));
    expect(newest).toMatchObject({ hasMore: true, cursor: all.messages[6]!.id });

    const mid = await tw.client.getThread(tw.home, { limit: 4, before: newest.cursor });
    expect(mid.messages.map((m) => m.id)).toEqual(all.messages.slice(2, 6).map((m) => m.id));
    expect(mid.hasMore).toBe(true);

    const oldest = await tw.client.getThread(tw.home, { limit: 4, before: mid.cursor });
    expect(oldest.messages.map((m) => m.id)).toEqual(all.messages.slice(0, 2).map((m) => m.id));
    expect(oldest.hasMore).toBe(false);

    // A page at least as big as the transcript holds everything.
    expect((await tw.client.getThread(tw.home, { limit: 50 })).messages).toHaveLength(10);
  });

  it("rejects a non-positive limit and a bare `before`", async () => {
    tw = await startTestWolf({ script: [] });
    await expect(tw.client.getThread(tw.home, { limit: 0 })).rejects.toThrow();
    await expect(tw.client.getThread(tw.home, { before: "entry-1" })).rejects.toThrow();
  });

  it("a pending card's message is in the newest page and pendingCards is whole, however small the limit", async () => {
    tw = await startTestWolf({
      script: [fauxAssistantMessage("earlier"), fauxAssistantMessage([fauxToolCall("ask_user_question", { question: "Which branch?" })], { stopReason: "toolUse" })],
    });
    await tw.client.submit(tw.home, "first", { whenBusy: "reject" });
    for await (const _ of tw.client.watch(tw.home));
    await tw.client.submit(tw.home, "ask me", { whenBusy: "reject" });
    for await (const _ of tw.client.watch(tw.home));
    const page = await tw.client.getThread(tw.home, { limit: 1 });
    expect(page.pendingCards).toHaveLength(1);
    expect(page.messages.some((m) => m.tools?.some((t) => t.callId === page.pendingCards![0]!.callId))).toBe(true);
    expect(page.hasMore).toBe(true);
  });
});
