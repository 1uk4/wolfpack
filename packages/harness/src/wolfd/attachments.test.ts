/** Image attachments over /v1 on a real pi-durable wolf with a scripted model: upload -> submit with ref -> the model sees the image. */
import { existsSync, readFileSync, rmSync } from "node:fs";
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

describe("attachments in history and the GET route", () => {
  const getUrl = (t: TestWolf, thread: string, id: string) => `${t.url}/v1/threads/${encodeURIComponent(thread)}/attachments/${encodeURIComponent(id)}`;

  it("upload -> submit -> getThread carries attachments; GET returns the bytes with the stored mime and nosniff", async () => {
    tw = await startTestWolf({ script: [fauxAssistantMessage("nice")] });
    const att = await tw.client.uploadAttachment(tw.home, PNG, { mimeType: "image/png", name: "shot.png" });
    await tw.client.submit(tw.home, "what is this?", { attachments: [{ id: att.id }] });
    for await (const _ of tw.client.watch(tw.home)) void _;

    const detail = await tw.client.getThread(tw.home);
    const user = detail.messages.find((m) => m.role === "user")!;
    expect(user.attachments).toEqual([{ id: att.id, name: "shot.png", mimeType: "image/png", size: PNG.length }]);
    expect(user.text).toContain("[Attached image:"); // model-facing text unchanged
    expect(detail.messages.find((m) => m.role === "assistant")!.attachments).toBeUndefined();

    const res = await fetch(getUrl(tw, tw.home, att.id), { headers: { "X-Protocol-Version": "1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(await tw.client.getAttachment(tw.home, att.id)).toEqual({ bytes: PNG, mimeType: "image/png" });
  });

  it("steering a running turn with an attachment: the steered history message carries it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    tw = await startTestWolf({
      script: [
        async () => {
          await gate;
          return fauxAssistantMessage("first");
        },
        fauxAssistantMessage("second"),
      ],
    });
    const att = await tw.client.uploadAttachment(tw.home, PNG, { mimeType: "image/png", name: "steer.png" });
    await tw.client.submit(tw.home, "start");
    const ack = await tw.client.submit(tw.home, "look at this", { whenBusy: "steer", attachments: [{ id: att.id }] });
    expect(ack.disposition).toBe("steered");
    release();
    for await (const _ of tw.client.watch(tw.home)) void _;
    const users = (await tw.client.getThread(tw.home)).messages.filter((m) => m.role === "user");
    const steered = users.find((m) => m.text.startsWith("look at this"))!;
    expect(steered.attachments).toEqual([{ id: att.id, name: "steer.png", mimeType: "image/png", size: PNG.length }]);
    expect(users.find((m) => m.text === "start")!.attachments).toBeUndefined();
  });

  it("durable refs: names survive a restart of the cache, the sidecar maps messageId, old threads fall back to the text lines", async () => {
    tw = await startTestWolf({ script: [fauxAssistantMessage("ok")] });
    const att = await tw.client.uploadAttachment(tw.home, PNG, { mimeType: "image/png", name: "keep.png" });
    const ack = await tw.client.submit(tw.home, "x", { attachments: [{ id: att.id }] });
    for await (const _ of tw.client.watch(tw.home)) void _;
    const refsFile = join(tw.wolf.config.den, "attachments", "testwolf", "home", "refs.json");
    const refs = JSON.parse(readFileSync(refsFile, "utf8"));
    expect(refs.byId[att.id].name).toBe("keep.png");
    expect(refs.byMessage[ack.messageId]).toEqual([att.id]);
    // Old thread: no sidecar, cache cold -> parse the line, name is the stored file name.
    const { attachmentsInText, forgetRefsCache } = await import("./attachments.js");
    rmSync(refsFile);
    forgetRefsCache();
    const den = tw.wolf.config.den;
    const text = `x\n\n[Attached image: /moved/den/${att.id}.png]`;
    expect(attachmentsInText(den, tw.home, text)).toEqual([{ id: att.id, name: `${att.id}.png`, mimeType: "image/png", size: PNG.length }]);
  });

  it("refuses a bad, unknown or traversal id and an unknown thread as 404 not_found", async () => {
    tw = await startTestWolf({ script: [] });
    const att = await tw.client.uploadAttachment(tw.home, PNG, { mimeType: "image/png" });
    for (const id of ["nope", "../../etc/passwd", "..\\..\\x", `${att.id}.png`, `${att.id}/../${att.id}`, "00000000-0000-4000-8000-000000000000"]) {
      const res = await fetch(getUrl(tw, tw.home, id));
      expect(res.status, id).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("not_found");
    }
    expect((await fetch(getUrl(tw, "testwolf/nope", att.id))).status).toBe(404);
    // A raw (unencoded) traversal path never reaches the file system either.
    const raw = await fetch(`${tw.url}/v1/threads/${encodeURIComponent(tw.home)}/attachments/%2e%2e%2f%2e%2e%2fhome`);
    expect(raw.status).toBe(404);
  });

  it("a forged path line in the user's own text yields no attachment", async () => {
    tw = await startTestWolf({ script: [fauxAssistantMessage("ok")] });
    await tw.client.submit(tw.home, "[Attached image: /etc/passwd]\n[Attached image: /tmp/00000000-0000-4000-8000-000000000000.png]");
    for await (const _ of tw.client.watch(tw.home)) void _;
    const user = (await tw.client.getThread(tw.home)).messages.find((m) => m.role === "user")!;
    expect(user.attachments).toBeUndefined();
  });

  it("after the cleanup hook the GET answers 404 and history lists no attachment", async () => {
    tw = await startTestWolf({ script: [fauxAssistantMessage("ok")] });
    const att = await tw.client.uploadAttachment(tw.home, PNG, { mimeType: "image/png" });
    await tw.client.submit(tw.home, "x", { attachments: [{ id: att.id }] });
    for await (const _ of tw.client.watch(tw.home)) void _;
    removeThreadAttachments(tw.wolf.config.den, tw.home);
    expect((await fetch(getUrl(tw, tw.home, att.id))).status).toBe(404);
    expect((await tw.client.getThread(tw.home)).messages.find((m) => m.role === "user")!.attachments).toBeUndefined();
  });
});

describe("attachment edge cases", () => {
  it("refuses a missing content type with a clear message, and caps refs per submit", async () => {
    tw = await startTestWolf({ script: [] });
    const url = `${tw.url}/v1/threads/${encodeURIComponent(tw.home)}/attachments`;
    const res = await fetch(url, { method: "POST", body: PNG, headers: { "Content-Type": "" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/missing Content-Type/);
    const refs = Array.from({ length: 9 }, () => ({ id: "00000000-0000-4000-8000-000000000000" }));
    await expect(tw.client.submit(tw.home, "x", { attachments: refs })).rejects.toThrow();
  });

  it("dedupes repeated refs: one image part per file", async () => {
    let seen: { role: string; content: string | Part[] }[] = [];
    tw = await startTestWolf({ script: [(ctx) => ((seen = ctx.messages as never), fauxAssistantMessage("ok"))] });
    const att = await tw.client.uploadAttachment(tw.home, PNG, { mimeType: "image/png" });
    await tw.client.submit(tw.home, "twice", { attachments: [{ id: att.id }, { id: att.id }] });
    for await (const _ of tw.client.watch(tw.home)) void _;
    const parts = seen.find((m) => m.role === "user")!.content as Part[];
    expect(parts.filter((p) => p.type === "image")).toHaveLength(1);
  });

  it("an over-cap chunked upload (no Content-Length) gets the error response, not a reset", async () => {
    tw = await startTestWolf({ script: [] });
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ >= 12) return c.close();
        c.enqueue(chunk);
      },
    });
    const res = await fetch(`${tw.url}/v1/threads/${encodeURIComponent(tw.home)}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/too large/);
  });

  it("an over-cap Content-Length is refused up front with the error response", async () => {
    tw = await startTestWolf({ script: [] });
    const big = new Uint8Array(ATTACHMENT_MAX_BYTES + 1024);
    const res = await fetch(`${tw.url}/v1/threads/${encodeURIComponent(tw.home)}/attachments`, { method: "POST", headers: { "Content-Type": "image/png" }, body: big });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/too large/);
  });
});
