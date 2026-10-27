/** Image attachments over /v1 on a real pi-durable wolf with a scripted model: upload -> submit with ref -> the model sees the image. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACHMENT_MAX_BYTES } from "@wolfpack/protocol";
import { fauxAssistantMessage } from "./scripted-model.js";
import { removeThreadAttachments } from "./attachments.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4]);

type Part = { type: string; text?: string; data?: string; mimeType?: string };

describe("image attachments", () => {
  it("upload -> submit with a ref: the user message holds the image part and the path", async () => {
    let seen: { role: string; content: string | Part[] }[] = [];
    tw = await startTestWolf({
      script: [
        (ctx) => {
          seen = ctx.messages as never;
          return fauxAssistantMessage("nice screenshot");
        },
      ],
    });
    const att = await tw.client.uploadAttachment(tw.home, PNG, { mimeType: "image/png", name: "shot.png" });
    expect(att).toMatchObject({ name: "shot.png", mimeType: "image/png", size: PNG.length });
    const path = join(tw.wolf.config.den, "attachments", "testwolf", "home", `${att.id}.png`);
    expect(existsSync(path)).toBe(true);
    expect(new Uint8Array(readFileSync(path))).toEqual(PNG);

    await tw.client.submit(tw.home, "what is this?", { whenBusy: "reject", attachments: [{ id: att.id }] });
    const events: unknown[] = [];
    for await (const e of tw.client.watch(tw.home)) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });

    const user = seen.find((m) => m.role === "user")!;
    const parts = user.content as Part[];
    expect(parts).toEqual([
      { type: "text", text: `what is this?\n\n[Attached image: ${path}]` },
      { type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" },
    ]);

    // History replays the text (with the path); the image part stays in the engine's entry.
    const detail = await tw.client.getThread(tw.home);
    expect(detail.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", `what is this?\n\n[Attached image: ${path}]`],
      ["assistant", "nice screenshot"],
    ]);
    const w = await tw.wolf.conversation.watch();
    const stored = w.snapshot.entries.find((e) => e.kind === "pi.user")!.model![0] as { content: Part[] };
    await w.stop();
    expect(stored.content.some((p) => p.type === "image")).toBe(true);
  });

  it("accepts an image-only submit (empty text)", async () => {
    let seen: { role: string; content: string | Part[] }[] = [];
    tw = await startTestWolf({ script: [(ctx) => ((seen = ctx.messages as never), fauxAssistantMessage("ok"))] });
    const att = await tw.client.uploadAttachment(tw.home, PNG, { mimeType: "image/png" });
    await tw.client.submit(tw.home, "", { attachments: [{ id: att.id }] });
    for await (const _ of tw.client.watch(tw.home)) void _;
    const parts = seen.find((m) => m.role === "user")!.content as Part[];
    expect(parts.map((p) => p.type)).toEqual(["text", "image"]);
  });

  it("refuses non-images, mislabelled bytes, oversize files and unknown refs", async () => {
    tw = await startTestWolf({ script: [] });
    await expect(tw.client.uploadAttachment(tw.home, new TextEncoder().encode("hi"), { mimeType: "text/plain" })).rejects.toThrow(/images only/);
    await expect(tw.client.uploadAttachment(tw.home, new TextEncoder().encode("not a png at all"), { mimeType: "image/png" })).rejects.toThrow(/not a valid image\/png/);
    const big = new Uint8Array(ATTACHMENT_MAX_BYTES + 1);
    big.set(PNG);
    await expect(tw.client.uploadAttachment(tw.home, big, { mimeType: "image/png" })).rejects.toThrow(/too large/);
    await expect(tw.client.submit(tw.home, "x", { attachments: [{ id: "00000000-0000-4000-8000-000000000000" }] })).rejects.toThrow(/unknown attachment/);
    await expect(tw.client.submit(tw.home, "x", { attachments: [{ id: "../../etc/passwd" }] })).rejects.toThrow(/unknown attachment/);
    await expect(tw.client.uploadAttachment("testwolf/nope", PNG, { mimeType: "image/png" })).rejects.toThrow();
    expect(tw.scripted.faux.state.callCount).toBe(0);
  });

  it("the cleanup hook drops a thread's attachments", async () => {
    tw = await startTestWolf({ script: [] });
    const att = await tw.client.uploadAttachment(tw.home, PNG, { mimeType: "image/png" });
    const path = join(tw.wolf.config.den, "attachments", "testwolf", "home", `${att.id}.png`);
    expect(existsSync(path)).toBe(true);
    removeThreadAttachments(tw.wolf.config.den, tw.home);
    expect(existsSync(path)).toBe(false);
  });
});
