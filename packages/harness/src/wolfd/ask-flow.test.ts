/** The `ask` questionnaire end to end over /v1: real pi-durable turns, scripted model, real wolfd server and client. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError } from "@wolfpack/client";
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
  const a0 = { name: { value: "Ada" } };

  it("saving a page delivers nothing to the model; submit delivers one result with every page and the note", async () => {
    let seen = "";
    const { w, callId } = await askWolf([(context) => { seen = lastUserText(context as never); return fauxAssistantMessage("done"); }]);
    await w.client.saveCardPage!(w.home, callId, 0, a0);
    await w.client.saveCardPage!(w.home, callId, 1, { pick: { value: "a" } });
    await w.client.putCardNote!(w.home, callId, { text: "mind the budget" });
    const open = (await w.client.getThread(w.home)).pendingCards![0];
    expect(open).toMatchObject({ pageIndex: 2, reached: 2, pageAnswers: { ...a0, pick: { value: "a" } }, note: { text: "mind the budget" } });
    expect(seen).toBe(""); // nothing reached the model yet
    const ack = await w.client.submitCard!(w.home, callId, { answers: { size: { value: 7 } } });
    expect(ack.disposition).toBe("started");
    await drain(w);
    expect(seen).toContain("- Q1 Name?: Ada");
    expect(seen).toContain("- Q2 Pick:");
    expect(seen).toContain("- Q3 Size: 7");
    expect(seen).toContain("Note from the user: mind the budget");
    expect(seen).toContain("The questionnaire is complete: you may proceed.");
    expect((await w.client.getThread(w.home)).pendingCards).toBeUndefined();
    expect((await toolResults(w, "ask"))[0]).toMatchObject({ closed: "answered" });
  });

  it("refuses a bad page, a bad goto, the whole-card route and a missing required question at submit", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one")]);
    await expect(w.client.saveCardPage!(w.home, callId, 5, {})).rejects.toMatchObject({ code: "invalid_request" });
    await expect(w.client.saveCardPage!(w.home, callId, 0, {}, { goto: 9 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(w.client.answerCard!(w.home, callId, { name: { value: "x" } })).rejects.toMatchObject({ code: "invalid_request" });
    await w.client.saveCardPage!(w.home, callId, 0, {}); // required answers are not enforced when saving
    await expect(w.client.submitCard!(w.home, callId, {})).rejects.toThrow(/Q1 "Name\?"/);
  });

  it("Back returns the saved answers and reached never goes down", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one")]);
    await w.client.saveCardPage!(w.home, callId, 0, a0);
    await w.client.saveCardPage!(w.home, callId, 1, { pick: { value: "a" } }, { goto: 2 });
    await w.client.saveCardPage!(w.home, callId, 2, {}, { goto: 0 }); // Back to the start
    const p = (await w.client.getThread(w.home)).pendingCards![0];
    expect(p).toMatchObject({ pageIndex: 0, reached: 2, pageAnswers: { ...a0, pick: { value: "a" } } });
  });

  it("answers a double-submitted questionnaire once: the other request is a conflict", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one")]);
    const go = () => w.client.submitCard!(w.home, callId, { answers: a0 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, go)); // several, so some land while the first is still in flight
    await drain(w);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // Those that land while the first is in flight are a conflict; later ones find the card closed (not found).
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
  });

  it("a plain message supersedes the set and tells the agent the partials of every page and the typed draft", async () => {
    let seen = "";
    const args: any = { pages: [threePages().pages[0], { title: "Two", questions: [{ id: "why", ask: "Why", kind: "free" }, { id: "other", ask: "Other", kind: "free" }] }, { title: "Three", questions: [{ id: "last", ask: "Last", kind: "free" }] }] };
    const { w, callId } = await askWolf(
      [
        (context) => {
          seen = lastUserText(context as never);
          return toolUse(fauxToolCall("write", { path: "free.txt", content: "z" }));
        },
        fauxAssistantMessage("ok"),
      ],
      args,
    );
    await w.client.saveCardPage!(w.home, callId, 0, a0);
    await w.client.bindCardText!(w.home, callId, "why", "because");
    await w.client.submit(w.home, "forget the form", { whenBusy: "reject" });
    await drain(w);
    expect(seen).toContain("Page 1 of 3 (One): Name? => Ada | Page 2 of 3 (Two): Why => because (typed, not submitted); Other => unanswered | Page 3 of 3 (Three): Last => unanswered");
    expect((await toolResults(w, "write"))[0].isError).toBe(false);
    const user = (await w.client.getThread(w.home)).messages.filter((m) => m.role === "user").at(-1)!;
    expect(user.text).toBe("forget the form"); // the note is stripped from what the owner sees
    await expect(w.client.submitCard!(w.home, callId, { answers: a0 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("binds text to a question on any page and rejects a slider, blank or too-long text", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one")]);
    const bind = (qid: string, text: string) => w.client.bindCardText!(w.home, callId, qid, text);
    await expect(bind("size", "5")).rejects.toMatchObject({ code: "invalid_request" }); // slider
    await expect(bind("pick", "mine")).rejects.toMatchObject({ code: "invalid_request" }); // noOther
    await expect(bind("why", "   ")).rejects.toMatchObject({ code: "invalid_request" }); // blank
    await expect(bind("why", "x".repeat(4001))).rejects.toMatchObject({ code: "invalid_request" }); // too long
    await expect(bind("nope", "x")).rejects.toMatchObject({ code: "invalid_request" }); // not on the card
    await expect(bind("why", "fine")).resolves.toBeUndefined(); // page 3 while viewing page 1
    expect((await w.client.getThread(w.home)).pendingCards![0].draft).toEqual({ why: { value: "fine" } });
  });
});

describe("ask multi custom answers", () => {
  it("holds a list of custom answers for a multi question, replaced as a whole, and reports all of them when superseded", async () => {
    let seen = "";
    const args = { pages: [{ title: "One", questions: [{ id: "tags", ask: "Tags", kind: "multi", choices: [{ label: "A", value: "a", tradeoff: "t" }] }] }] };
    const { w, callId } = await askWolf([(context) => { seen = lastUserText(context as never); return fauxAssistantMessage("ok"); }], args);
    const bind = (picked: string[], others: string[]) => w.client.bindCardText!(w.home, callId, "tags", "", undefined, { picked, others });
    await bind(["a"], ["red"]);
    await bind(["a"], ["red", "blue"]);
    expect((await w.client.getThread(w.home)).pendingCards![0].draft).toEqual({ tags: { value: ["a", "red", "blue"], other: ["red", "blue"] } });
    await bind(["a"], ["blue"]); // red unchecked
    expect((await w.client.getThread(w.home)).pendingCards![0].draft).toEqual({ tags: { value: ["a", "blue"], other: ["blue"] } });
    await expect(bind(["zzz"], ["blue"])).rejects.toMatchObject({ code: "invalid_request" }); // not an option
    await expect(bind([], ["a"])).rejects.toMatchObject({ code: "invalid_request" }); // duplicates an option
    await bind(["a"], ["blue", "green"]);
    await w.client.submit(w.home, "never mind", { whenBusy: "reject" });
    await drain(w);
    expect(seen).toContain('other: "blue", other: "green"');
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
  it("an unknown call id is an error result", async () => {
    const { w } = await askWolf([
      toolUse(fauxToolCall("ask_revise", { callId: "nope", pages: [{ title: "x", questions: [{ id: "n1", ask: "q", kind: "free" }] }] })),
      fauxAssistantMessage("ok"),
    ]);
    await w.client.submitCard!(w.home, (await w.client.getThread(w.home)).pendingCards![0].callId, { answers: { name: { value: "Ada" } } });
    await drain(w);
    const rev = await toolResults(w, "ask_revise");
    expect(rev.map((r) => r.isError)).toEqual([true]);
    expect(rev[0].result).toMatch(/no open questionnaire/);
  });
});
