/** The `ask` questionnaire end to end over /v1: real pi-durable turns, scripted model, real wolfd server and client. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError, ProtocolError } from "@wolfpack/client";
import { fauxAssistantMessage, fauxToolCall } from "./scripted-model.js";
import { startTestWolf, type TestWolf, type TestWolfOptions } from "./test-wolf.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const drain = async (w: TestWolf) => {
  for await (const _ of w.client.watch(w.home));
};
const lastUserText = (context: { messages: { role: string; content: unknown }[] }): string => {
  const u = context.messages.filter((m) => m.role === "user").at(-1);
  return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content);
};
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

const threePages = (extra: Record<string, unknown> = {}): any => ({
  pages: [
    { title: "One", questions: [{ id: "name", ask: "Name?", kind: "free", required: true, context: "ctx name", ...extra }] },
    { title: "Two", questions: [{ id: "pick", ask: "Pick", kind: "single", noOther: true, choices: [{ label: "A", value: "a", tradeoff: "fast" }] }] },
    { title: "Three", questions: [{ id: "size", ask: "Size", kind: "slider", min: 0, max: 10, step: 1 }, { id: "why", ask: "Why", kind: "free" }] },
  ],
});

/** A wolf whose first turn raises a three-page ask, followed by `rest`. */
async function askWolf(rest: TestWolfOptions["script"], args: any = threePages(), extensions?: TestWolfOptions["hooks"]) {
  tw = await startTestWolf({ script: [toolUse(fauxToolCall("ask", args)), ...rest], ...(extensions ? { hooks: extensions } : {}) });
  await tw.submit("start");
  const detail = await tw.client.getThread(tw.home);
  return { w: tw, callId: detail.pendingCards![0].callId };
}
const toolResults = async (w: TestWolf, name: string) => (await w.client.getThread(w.home)).messages.flatMap((m) => m.tools ?? []).filter((t) => t.name === name);

describe("ask questionnaire over /v1", () => {
  it("rejects a wrong page number, a missing required question, a double submit and the whole-card route", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one")]);
    await expect(w.client.answerCardPage!(w.home, callId, 1, { pick: { value: "a" } })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(w.client.answerCardPage!(w.home, callId, 0, {})).rejects.toMatchObject({ code: "invalid_request" }); // "name" is required
    await expect(w.client.answerCard!(w.home, callId, { name: { value: "x" } })).rejects.toMatchObject({ code: "invalid_request" }); // old route
    const ack = await w.client.answerCardPage!(w.home, callId, 0, { name: { value: "Ada" } });
    expect(ack.disposition).toBe("started");
    await drain(w);
    await expect(w.client.answerCardPage!(w.home, callId, 0, { name: { value: "Ada" } })).rejects.toMatchObject({ code: "conflict" });
    const err = await w.client.answerCardPage!(w.home, callId, 0, { name: { value: "Ada" } }).catch((e) => e);
    expect(err).toBeInstanceOf(ProtocolError);
  });

  it("the final page closes the card and the transcript carries the page answers", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("done")]);
    await w.client.answerCardPage!(w.home, callId, 0, { name: { value: "Ada" } });
    await drain(w);
    let call = (await toolResults(w, "ask"))[0];
    expect(call).toMatchObject({ pagesDone: 1, pageAnswers: { name: { value: "Ada" } } });
    expect(call.closed).toBeUndefined();
    await w.client.answerCardPage!(w.home, callId, 1, { pick: { value: "a" } });
    await drain(w);
    await w.client.answerCardPage!(w.home, callId, 2, { size: { value: 7 } });
    await drain(w);
    expect((await w.client.getThread(w.home)).pendingCards).toBeUndefined();
    call = (await toolResults(w, "ask"))[0];
    expect(call).toMatchObject({ closed: "answered", pagesDone: 3, pageAnswers: { name: { value: "Ada" }, pick: { value: "a" }, size: { value: 7 } } });
  });

  it("refuses a state-changing tool mid-questionnaire, allows reads and ask_revise, and lifts the hold after the last page", async () => {
    const file = "held.txt";
    const ids = { call: "" };
    const { w, callId } = await askWolf([
      toolUse(fauxToolCall("write", { path: file, content: "x" })), // page 1 answered: refused
      toolUse(fauxToolCall("read", { path: "nothing-here.txt" })), // allowed (fails as a missing file, not as a hold)
      () => toolUse(fauxToolCall("ask_revise", { callId: ids.call, pages: [{ title: "Two b", questions: [{ id: "pick2", ask: "Pick", kind: "free" }] }] })),
      toolUse(fauxToolCall("write", { path: file, content: "y" })), // last page answered: allowed
      fauxAssistantMessage("done"),
    ]);
    ids.call = callId;
    await w.client.answerCardPage!(w.home, callId, 0, { name: { value: "Ada" } });
    await drain(w);
    const writes = await toolResults(w, "write");
    expect(writes[0].isError).toBe(true);
    expect(writes[0].result).toMatch(/questionnaire in progress: page 2 of 3 pending; end your turn with text, or call ask_revise/);
    expect(existsSync(join(w.root, "work", file))).toBe(false);
    expect((await toolResults(w, "read"))[0].result).not.toMatch(/questionnaire in progress/);
    expect((await toolResults(w, "ask_revise"))[0].isError).toBe(false);
    const open = (await w.client.getThread(w.home)).pendingCards![0];
    expect(open.card.steps!.map((s) => s.title)).toEqual(["One", "Two b"]);
    await w.client.answerCardPage!(w.home, callId, 1, { pick2: { value: "ok" } });
    await drain(w);
    expect((await toolResults(w, "write")).at(-1)!.isError).toBe(false);
    expect(existsSync(join(w.root, "work", file))).toBe(true);
  });

  it("does not refuse a render tool between pages, and an ask_revise call is not a second pending card", async () => {
    const render = defineExtension({
      name: "fake-render",
      tools: [defineTool({ name: "render_svg", description: "r", parameters: { type: "object" as const, properties: {}, required: [] }, async execute() { return { output: [{ type: "text" as const, text: "rendered" }] }; } })],
    });
    const ids = { call: "" };
    const { w, callId } = await askWolf(
      [
        toolUse(fauxToolCall("render_svg", {})),
        () => toolUse(fauxToolCall("ask_revise", { callId: ids.call, pages: [{ title: "Two b", questions: [{ id: "pick2", ask: "Pick", kind: "free" }] }] })),
        fauxAssistantMessage("ok"),
      ],
      threePages(),
      { extensions: [render] },
    );
    ids.call = callId;
    await w.client.answerCardPage!(w.home, callId, 0, { name: { value: "Ada" } });
    await drain(w);
    expect((await toolResults(w, "render_svg"))[0]).toMatchObject({ isError: false, result: "rendered" });
    const revise = (await toolResults(w, "ask_revise"))[0];
    expect(revise.isError).toBe(false);
    const asks = (await w.client.getThread(w.home)).messages.flatMap((m) => m.tools ?? []).filter((t) => t.card && !t.closed);
    expect(asks.map((t) => t.name)).toEqual(["ask"]); // exactly one pending ask card
    expect(revise.card).toBeUndefined();
  });

  it("answers a double-submitted page once: the other request is a conflict", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one")]);
    const go = () => w.client.answerCardPage!(w.home, callId, 0, { name: { value: "Ada" } });
    const results = await Promise.allSettled(Array.from({ length: 8 }, go)); // several, so some land while the first is still in flight
    await drain(w);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(lost.map((l) => l.reason.code)).toEqual(Array(7).fill("conflict"));
  });

  it("still refuses a write tool after a wolfd restart, while read is allowed", async () => {
    const root = mkdtempSync(join(tmpdir(), "ask-restart-"));
    try {
      const first = await startTestWolf({ root, script: [toolUse(fauxToolCall("ask", threePages())), fauxAssistantMessage("one")] });
      await first.submit("start");
      const callId = (await first.client.getThread(first.home)).pendingCards![0].callId;
      await first.client.answerCardPage!(first.home, callId, 0, { name: { value: "Ada" } });
      for await (const _ of first.client.watch(first.home));
      await first.stop();
      tw = await startTestWolf({
        root,
        script: [toolUse(fauxToolCall("write", { path: "restart.txt", content: "x" })), toolUse(fauxToolCall("read", { path: "nothing-here.txt" })), fauxAssistantMessage("ok")],
      });
      await tw.client.answerCardPage!(tw.home, callId, 1, { pick: { value: "a" } });
      await drain(tw);
      const write = (await toolResults(tw, "write"))[0];
      expect(write.isError).toBe(true);
      expect(write.result).toMatch(/questionnaire in progress: page 3 of 3/);
      expect(existsSync(join(root, "work", "restart.txt"))).toBe(false);
      expect((await toolResults(tw, "read"))[0].result).not.toMatch(/questionnaire in progress/);
    } finally {
      await tw?.stop();
      tw = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lifts the hold when a plain message supersedes the set, and tells the agent the partials and the typed draft", async () => {
    let seen = "";
    const args: any = { pages: [threePages().pages[0], { title: "Two", questions: [{ id: "why", ask: "Why", kind: "free" }, { id: "other", ask: "Other", kind: "free" }] }, threePages().pages[2]].map((p, i) => (i === 2 ? { ...p, questions: [{ id: "last", ask: "Last", kind: "free" }] } : p)) };
    const { w, callId } = await askWolf(
      [
        fauxAssistantMessage("one"),
        (context) => {
          seen = lastUserText(context as never);
          return toolUse(fauxToolCall("write", { path: "free.txt", content: "z" }));
        },
        fauxAssistantMessage("ok"),
      ],
      args,
    );
    await w.client.answerCardPage!(w.home, callId, 0, { name: { value: "Ada" } });
    await drain(w);
    await w.client.bindCardText!(w.home, callId, "why", "because");
    await w.client.submit(w.home, "forget the form", { whenBusy: "reject" });
    await drain(w);
    expect(seen).toContain("state when replaced: Name? => Ada; Why => because (typed, not submitted); Other => unanswered; Last => unanswered");
    expect((await toolResults(w, "write"))[0].isError).toBe(false);
    expect(existsSync(join(w.root, "work", "free.txt"))).toBe(true);
    const user = (await w.client.getThread(w.home)).messages.filter((m) => m.role === "user").at(-1)!;
    expect(user.text).toBe("forget the form"); // the note is stripped from what the owner sees
  });

  it("rejects bound text that is off the page, on noOther, on a slider, too long or blank", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
    await w.client.answerCardPage!(w.home, callId, 0, { name: { value: "Ada" } });
    await drain(w);
    await w.client.answerCardPage!(w.home, callId, 1, { pick: { value: "a" } });
    await drain(w);
    const bind = (qid: string, text: string) => w.client.bindCardText!(w.home, callId, qid, text);
    await expect(bind("name", "again")).rejects.toMatchObject({ code: "invalid_request" }); // page 0, not current
    await expect(bind("size", "5")).rejects.toMatchObject({ code: "invalid_request" }); // slider
    await expect(bind("why", "   ")).rejects.toMatchObject({ code: "invalid_request" }); // blank
    await expect(bind("why", "x".repeat(4001))).rejects.toMatchObject({ code: "invalid_request" }); // too long
    await expect(bind("why", "fine")).resolves.toBeUndefined();
    expect((await w.client.getThread(w.home)).pendingCards![0].draft).toEqual({ why: { value: "fine" } });
  });
});

describe("ask diagrams", () => {
  const diagram = "viz-flow-1731000000000.png";

  it("serves a published diagram by id and refuses everything else", async () => {
    tw = await startTestWolf({ script: [fauxAssistantMessage("hi")] });
    mkdirSync(join(tw.wolf.config.den, "viz"), { recursive: true });
    writeFileSync(join(tw.wolf.config.den, "viz", diagram), PNG);
    writeFileSync(join(tw.wolf.config.den, "secret.png"), PNG);
    const got = await tw.client.getDiagram!(tw.home, diagram);
    expect(got.mimeType).toBe("image/png");
    expect(Buffer.from(got.bytes)).toEqual(PNG);
    for (const bad of ["viz-nope-1731000000001.png", "..%2Fsecret.png", "%2Fetc%2Fpasswd", "http%3A%2F%2Fx%2Fa.png", "secret.png"]) {
      await expect(tw.client.getDiagram!(tw.home, decodeURIComponent(bad))).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("serves a diagram from the WOLFPACK_VIZ_DIR of the server's env, not the process env", async () => {
    const viz = mkdtempSync(join(tmpdir(), "viz-env-"));
    try {
      writeFileSync(join(viz, diagram), PNG);
      tw = await startTestWolf({ script: [fauxAssistantMessage("hi")], env: { WOLFPACK_VIZ_DIR: viz } });
      const got = await tw.client.getDiagram!(tw.home, diagram);
      expect(Buffer.from(got.bytes)).toEqual(PNG);
    } finally {
      rmSync(viz, { recursive: true, force: true });
    }
  });

  it("refuses a png in the viz dir that is not named like a published diagram", async () => {
    tw = await startTestWolf({ script: [fauxAssistantMessage("hi")] });
    mkdirSync(join(tw.wolf.config.den, "viz"), { recursive: true });
    writeFileSync(join(tw.wolf.config.den, "viz", "secret.png"), PNG);
    await expect(tw.client.getDiagram!(tw.home, "secret.png")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a validly named symlink in the viz dir that points outside it", async () => {
    tw = await startTestWolf({ script: [fauxAssistantMessage("hi")] });
    mkdirSync(join(tw.wolf.config.den, "viz"), { recursive: true });
    writeFileSync(join(tw.wolf.config.den, "outside.png"), PNG);
    symlinkSync(join(tw.wolf.config.den, "outside.png"), join(tw.wolf.config.den, "viz", diagram));
    await expect(tw.client.getDiagram!(tw.home, diagram)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("ask rejects an unpublished id, a path, a URL and .. so the agent sees the error; a published id is accepted", async () => {
    const bads = ["viz-nope-1731000000001.png", "/etc/passwd", "../secret.png", "https://x.test/a.png"];
    tw = await startTestWolf({
      script: [
        ...bads.map((d) => toolUse(fauxToolCall("ask", threePages({ diagram: d })))),
        toolUse(fauxToolCall("ask", threePages({ diagram: diagram }))),
        fauxAssistantMessage("end"),
      ],
    });
    mkdirSync(join(tw.wolf.config.den, "viz"), { recursive: true });
    writeFileSync(join(tw.wolf.config.den, "viz", diagram), PNG);
    await tw.submit("go");
    const results = await toolResults(tw, "ask");
    expect(results.slice(0, 4).map((r) => r.isError)).toEqual([true, true, true, true]);
    expect(results[0].result).toMatch(/not a published diagram/);
    expect(results[4].isError).toBe(false);
    const card = (await tw.client.getThread(tw.home)).pendingCards![0].card;
    expect(card.fields[0]).toMatchObject({ diagram });
  });
});

describe("ask_revise errors reach the agent", () => {
  it("an unknown call id and an answered question id are error results", async () => {
    const ids = { call: "" };
    const { w, callId } = await askWolf([
      toolUse(fauxToolCall("ask_revise", { callId: "nope", pages: [{ title: "x", questions: [{ id: "n1", ask: "q", kind: "free" }] }] })),
      () => toolUse(fauxToolCall("ask_revise", { callId: ids.call, pages: [{ title: "x", questions: [{ id: "name", ask: "q", kind: "free" }] }] })),
      fauxAssistantMessage("ok"),
    ]);
    ids.call = callId;
    await w.client.answerCardPage!(w.home, callId, 0, { name: { value: "Ada" } });
    await drain(w);
    const rev = await toolResults(w, "ask_revise");
    expect(rev.map((r) => r.isError)).toEqual([true, true]);
    expect(rev[0].result).toMatch(/no open questionnaire/);
    expect(rev[1].result).toMatch(/"name" is used twice/);
    expect((await w.client.getThread(w.home)).pendingCards![0].card.steps).toHaveLength(3); // unchanged
  });
});
