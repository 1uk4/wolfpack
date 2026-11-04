/** A changed persona (AGENTS.md) on restart drops the conversation's provider session, so a snapshotted prompt cannot outlive it. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

const live: TestWolf[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((w) => w.stop()));
});

describe("reconcile on instructions change", () => {
  it("releases the provider session only when the instructions differ", async () => {
    const released: string[] = [];
    const modelRelease = (id: string) => void released.push(id);
    const first = await startTestWolf({ script: [fauxAssistantMessage([fauxText("one")])], modelRelease });
    const root = first.root;
    mkdirSync(join(root, "work"), { recursive: true });
    writeFileSync(join(root, "work", "AGENTS.md"), "persona A");
    await first.submit("hello");
    const sessionId = await first.wolf.engine.conversations.providerSessionId(first.wolf.conversation.id);
    expect(sessionId).toBeTruthy();
    await first.wolf.close();

    // AGENTS.md was added after the first boot: the stored instructions differ -> released
    const second = await startTestWolf({ script: [], root, modelRelease });
    live.push(second);
    expect(released).toContain(sessionId);
    const n = released.length;
    await second.wolf.close();

    // same instructions again -> not released
    const third = await startTestWolf({ script: [], root, modelRelease });
    live.push(third);
    expect(released.length).toBe(n);
  });
});
