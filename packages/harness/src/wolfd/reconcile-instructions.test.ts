/** A changed persona (AGENTS.md) on restart drops the conversation's provider session, so a snapshotted prompt cannot outlive it. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

const live: TestWolf[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((w) => w.stop()));
});

const agent = (name: string) => `---\nname: ${name}\ndescription: ${name} agent\nmodel: fast\ntools: read\n---\n\nbody ${name}\n`;
const putAgents = (root: string, names: string[]) => {
  const dir = join(root, "agent", "agents");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const n of names) writeFileSync(join(dir, `${n}.md`), agent(n));
};
const drain = async (w: TestWolf, id: string) => {
  for await (const _ of w.client.watch(id));
};

describe("reconcile on instructions change", () => {
  it("releases the home provider session only when the instructions differ", async () => {
    const released: string[] = [];
    const modelRelease = (id: string) => void released.push(id);
    const first = await startTestWolf({ script: [fauxAssistantMessage([fauxText("one")])], modelRelease });
    const root = first.root;
    await first.submit("hello");
    const sessionId = await first.wolf.engine.conversations.providerSessionId(first.wolf.conversation.id);
    expect(sessionId).toBeTruthy();
    await first.wolf.close();
    writeFileSync(join(root, "work", "AGENTS.md"), "persona A");

    const second = await startTestWolf({ script: [], root, modelRelease });
    expect(released).toContain(sessionId);
    const n = released.length;
    await second.wolf.close();

    const third = await startTestWolf({ script: [], root, modelRelease });
    live.push(third);
    expect(released.length).toBe(n);
  });

  it("releases a feature thread's provider session when it is reopened with changed instructions", async () => {
    const released: string[] = [];
    const modelRelease = (id: string) => void released.push(id);
    const first = await startTestWolf({ script: [fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])], modelRelease });
    const root = first.root;
    const feat = await first.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-feat0001" });
    await first.client.submit(feat.id, "hello", { whenBusy: "reject" });
    await drain(first, feat.id);
    const saved = JSON.parse(readFileSync(join(root, "den", "wolfd", "threads.json"), "utf8")).threads[0] as { conversationId: string };
    const sessionId = await first.wolf.engine.conversations.providerSessionId(saved.conversationId);
    expect(sessionId).toBeTruthy();
    await first.wolf.close();
    writeFileSync(join(root, "work", "AGENTS.md"), "persona B");

    const second = await startTestWolf({ script: [], root, modelRelease });
    live.push(second);
    await second.client.getThread(feat.id);
    expect(released).toContain(sessionId);
  });

  it("a roster whose files were recreated in another order changes nothing and drops nothing", async () => {
    const released: string[] = [];
    const modelRelease = (id: string) => void released.push(id);
    const root = mkdtempSync(join(tmpdir(), "test-wolf-"));
    putAgents(root, ["alpha", "bravo", "charlie"]);
    const first = await startTestWolf({ script: [fauxAssistantMessage([fauxText("one")])], root, modelRelease });
    await first.submit("hello");
    await first.wolf.close();
    putAgents(root, ["charlie", "bravo", "alpha"]);
    const second = await startTestWolf({ script: [], root, modelRelease });
    live.push(second);
    expect(released).toEqual([]);
    await second.stop();
    live.pop();
    rmSync(root, { recursive: true, force: true });
  });
});
