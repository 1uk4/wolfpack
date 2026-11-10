import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
type Part = { type: string; text?: string; mimeType?: string; data?: string };
/** The last user message of a model call as content parts. */
const lastUserParts = (context: unknown): Part[] => {
  const u = (context as { messages: { role: string; content: unknown }[] }).messages.filter((m) => m.role === "user").at(-1);
  return typeof u?.content === "string" ? [{ type: "text", text: u.content }] : (u?.content as Part[]);
};
const textOf = (parts: Part[]) => parts.map((p) => p.text ?? "").join("\n");
const imagesOf = (parts: Part[]) => parts.filter((p) => p.type === "image").map((p) => p.data);

const png = (n: number) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(32, n)]);
const OPTS = [
  { label: "A", value: "a", tradeoff: "fast" },
  { label: "B", value: "b", tradeoff: "slow" },
];
const threePages = (): any => ({
  pages: [
    { title: "One", questions: [{ id: "name", ask: "Name?", kind: "free", required: true }] },
    {
      title: "Two",
      questions: [
        { id: "why", ask: "Why", kind: "free" },
        { id: "tags", ask: "Tags", kind: "multi", choices: OPTS, max: 1 },
        { id: "pick", ask: "Pick", kind: "single", choices: OPTS },
        { id: "strict", ask: "Strict", kind: "single", noOther: true, choices: OPTS },
        { id: "size", ask: "Size", kind: "slider", min: 0, max: 10, step: 1 },
        { id: "ok", ask: "Ok?", kind: "confirm" },
      ],
    },
    { title: "Three", questions: [{ id: "last", ask: "Last", kind: "free" }] },
  ],
});

async function askWolf(rest: TestWolfOptions["script"]) {
  tw = await startTestWolf({ script: [toolUse(fauxToolCall("ask", threePages())), ...rest] });
  await tw.submit("start");
  const detail = await tw.client.getThread(tw.home);
  return { w: tw, callId: detail.pendingCards![0].callId };
}
const upload = (w: TestWolf, n = 1, thread = w.home) => w.client.uploadAttachment(thread, png(n), { mimeType: "image/png", name: `shot${n}.png` });
const draftOf = async (w: TestWolf) => (await w.client.getThread(w.home)).pendingCards![0].draft;
/** Go to page 1 of the questionnaire. */
const toPageTwo = async (w: TestWolf, callId: string) => {
  await w.client.saveCardPage!(w.home, callId, 0, { name: { value: "Ada" } });
};

describe("ask answers with images", () => {
  it("holds images alone as a text-less draft per kind (no fake Other entry), and a rebind replaces it", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one")]);
    await toPageTwo(w, callId);
    const [a, b, c] = [await upload(w, 1), await upload(w, 2), await upload(w, 3)];
    await expect(w.client.bindCardText!(w.home, callId, "why", "  ")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(w.client.bindCardText!(w.home, callId, "why", "", ["00000000-0000-4000-8000-000000000000"])).rejects.toMatchObject({ code: "invalid_request" });
    await w.client.bindCardText!(w.home, callId, "why", "", [a.id]);
    await w.client.bindCardText!(w.home, callId, "tags", "", [b.id]);
    await w.client.bindCardText!(w.home, callId, "pick", "", [c.id]);
    expect(await draftOf(w)).toEqual({
      why: { value: "", attachments: [a.id] },
      tags: { value: [], attachments: [b.id] },
      pick: { value: "", attachments: [c.id] },
    });
    await w.client.bindCardText!(w.home, callId, "tags", "mine", [b.id]);
    await w.client.bindCardText!(w.home, callId, "why", "words");
    expect(await draftOf(w)).toMatchObject({ tags: { value: ["mine"], other: ["mine"], attachments: [b.id] }, why: { value: "words" } });
  });

  it("refuses images on a slider, a confirm and a question without Other, and on a direct page answer", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one")]);
    await toPageTwo(w, callId);
    const a = await upload(w);
    for (const qid of ["size", "ok", "strict"]) await expect(w.client.bindCardText!(w.home, callId, qid, "", [a.id])).rejects.toMatchObject({ code: "invalid_request" });
    await expect(w.client.saveCardPage!(w.home, callId, 1, { why: { value: "x", attachments: [a.id] } } as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(await draftOf(w)).toBeUndefined();
  });

  it("refuses an upload that belongs to another thread", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one")]);
    await toPageTwo(w, callId);
    const other = await w.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-feat0001" });
    const foreign = await upload(w, 1, other.id);
    await expect(w.client.bindCardText!(w.home, callId, "why", "", [foreign.id])).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("caps the images of all drafts of a card together, and one bind of more than 8", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one")]);
    await toPageTwo(w, callId);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await upload(w, i + 1)).id);
    await expect(w.client.bindCardText!(w.home, callId, "why", "", [...ids, "00000000-0000-4000-8000-000000000000"])).rejects.toMatchObject({ code: "invalid_request" });
    await w.client.bindCardText!(w.home, callId, "why", "", ids.slice(0, 5));
    await expect(w.client.bindCardText!(w.home, callId, "pick", "", ids.slice(4, 8))).rejects.toThrow(/at most 8 images/);
    await w.client.bindCardText!(w.home, callId, "pick", "", ids.slice(5, 8));
    // A rebind of the same question counts only its new images.
    await expect(w.client.bindCardText!(w.home, callId, "why", "", ids.slice(0, 5))).resolves.toBeUndefined();
  });

  it("delivers each question's images and the note's images once, in one message, each with its own label; picking an option keeps the draft's images", async () => {
    const seen: Part[][] = [];
    const take = (reply: string) => (context: unknown) => (seen.push(lastUserParts(context)), fauxAssistantMessage(reply));
    const { w, callId } = await askWolf([take("one")]);
    const [a, b, c, n] = [png(1), png(2), png(3), png(4)];
    const up = async (k: number) => (await upload(w, k)).id;
    await w.client.bindCardText!(w.home, callId, "name", "Ada", [await up(1)]);
    await w.client.saveCardPage!(w.home, callId, 0, {});
    await w.client.bindCardText!(w.home, callId, "why", "", [await up(2)]);
    await w.client.bindCardText!(w.home, callId, "pick", "", [await up(3)]);
    // The pick answer replaces the draft's value; its image stays attached.
    await w.client.saveCardPage!(w.home, callId, 1, { pick: { value: "a" } });
    await w.client.putCardNote!(w.home, callId, { text: "see", attachments: [await up(4)] });
    await w.client.submitCard!(w.home, callId, {});
    await drain(w);
    expect(seen).toHaveLength(1);
    expect(imagesOf(seen[0])).toEqual([a, b, c, n].map((p) => p.toString("base64")));
    const t = textOf(seen[0]);
    expect(t).toContain('Images the user attached to the answer of "Name?"');
    expect(t).toContain("- Q4 Pick: A (a) [1 image attached below]");
    expect(t).toContain("Note from the user: see [1 image attached below]");
    expect(t.indexOf('answer of "Why"')).toBeLessThan(t.indexOf('answer of "Pick"'));
    expect(t.indexOf('answer of "Pick"')).toBeLessThan(t.indexOf("attached to their note"));
  });

  it("counts the note's images against the same cap of 8 as the images bound to questions", async () => {
    const { w, callId } = await askWolf([fauxAssistantMessage("one")]);
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push((await upload(w, i + 1)).id);
    await w.client.bindCardText!(w.home, callId, "why", "", ids.slice(0, 5));
    await expect(w.client.putCardNote!(w.home, callId, { attachments: ids.slice(5, 9) })).rejects.toThrow(/at most 8 images/);
    await w.client.putCardNote!(w.home, callId, { attachments: ids.slice(5, 8) });
  });

  it("a plain message that supersedes the set carries the drafted images as image parts, labelled by question", async () => {
    let seen: Part[] = [];
    const { w, callId } = await askWolf([(context) => ((seen = lastUserParts(context)), fauxAssistantMessage("ok"))]);
    await toPageTwo(w, callId);
    const att = await upload(w, 7);
    await w.client.bindCardText!(w.home, callId, "why", "see this", [att.id]);
    await w.client.submit(w.home, "never mind", { whenBusy: "reject" });
    await drain(w);
    expect(textOf(seen)).toContain("Why => see this [images attached below] (typed, not submitted)");
    expect(textOf(seen)).toContain('Images the user attached to the unsubmitted answer of "Why"');
    expect(imagesOf(seen)).toEqual([png(7).toString("base64")]);
  });

  it("a superseding message sends a draft image already attached to it once, and stays within the per-message cap, naming what was left out", async () => {
    let seen: Part[] = [];
    const { w, callId } = await askWolf([(context) => ((seen = lastUserParts(context)), fauxAssistantMessage("ok"))]);
    await toPageTwo(w, callId);
    const own: string[] = [];
    for (let i = 1; i <= 7; i++) own.push((await upload(w, i)).id);
    const [d1, d2] = [await upload(w, 11), await upload(w, 12)];
    // `why` drafts one of the message's own images plus d1; `pick` drafts d2.
    await w.client.bindCardText!(w.home, callId, "why", "", [own[0], d1.id]);
    await w.client.bindCardText!(w.home, callId, "pick", "", [d2.id]);
    await w.client.submit(w.home, "never mind", { whenBusy: "reject", attachments: own.map((id) => ({ id })) });
    await drain(w);
    // 7 own (the duplicate not repeated) + d1 fills the cap of 8; d2 is left out and said so.
    expect(imagesOf(seen)).toEqual([...[1, 2, 3, 4, 5, 6, 7, 11].map((n) => png(n).toString("base64"))]);
    expect(textOf(seen)).toContain("1 more image was not sent");
  });

  it("says the image is no longer available when every drafted file of an image-only answer is gone", async () => {
    let seen: Part[] = [];
    const { w, callId } = await askWolf([(context) => ((seen = lastUserParts(context)), fauxAssistantMessage("two"))]);
    await toPageTwo(w, callId);
    const a = await upload(w, 5);
    await w.client.bindCardText!(w.home, callId, "why", "", [a.id]);
    const dir = join(w.wolf.config.den, "attachments", w.home);
    for (const f of readdirSync(dir)) if (f.startsWith(a.id)) rmSync(join(dir, f));
    await w.client.submitCard!(w.home, callId, {});
    await drain(w);
    expect(textOf(seen)).toContain("Why: (image no longer available)");
    expect(textOf(seen)).not.toContain("(no answer)");
    expect(imagesOf(seen)).toEqual([]);
  });
});
