/**
 * Offline replacement for the retired wolfd.images.live test: an uploaded image, large or small, reaches the SDK
 * query as a base64 image block with its own bytes and mime type. Real attachment store + inlining + real stateless
 * bridge; only the Anthropic SDK query function is faked and its payload captured.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStatelessStreams } from "pi-claude-bridge-stateless/stateless";
import { inlineAttachments, storeAttachment } from "./attachments.js";

const crc = (b: Buffer) => {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const t = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(t));
  return Buffer.concat([len, t, sum]);
};
function solidPng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 200)]);
  const idat = deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const MODEL = { id: "sonnet", api: "x", provider: "p", name: "s", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1e5, maxTokens: 1e4, reasoning: false } as any;
const END = [
  { type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 1 } } } },
  { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
  { type: "stream_event", event: { type: "message_stop" } },
  { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1, session_id: "s" },
];

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "wolfd-images-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Upload `png`, inline it as the engine would, run one turn and return the image blocks the SDK query received. */
async function imageBlocksSentFor(png: Buffer, n: number) {
  const att = storeAttachment(join(root, "den"), "w/home", png, "image/png", "shot.png");
  const content = inlineAttachments(join(root, "den"), "w/home", "what colour?", [{ id: att.id } as any]);
  const queries: any[] = [];
  const queryFn = (args: any) => { queries.push(args); return (async function* () { for (const m of END) yield m; })(); };
  const streams = createStatelessStreams({ sessionDir: join(root, `cwd${n}`), claudeDir: join(root, `claude${n}`), queryFn } as any);
  const s = (streams as any).streamSimple(MODEL, { messages: [{ role: "system", content: "x" }, { role: "user", content, timestamp: 1 }] }, { sessionId: `s${n}` });
  for await (const _ of s) { /* drain */ }
  await s.result();
  const prompt = queries[0].prompt;
  const out: any[] = [];
  if (typeof prompt !== "string") for await (const m of prompt) out.push(m);
  return out.flatMap((m) => (Array.isArray(m.message?.content) ? m.message.content : [])).filter((b: any) => b.type === "image");
}

describe("an uploaded image reaches the Anthropic SDK query intact", () => {
  it("a small image arrives as a base64 image block with its bytes and mime type", async () => {
    const png = solidPng(64, 64);
    expect(await imageBlocksSentFor(png, 1)).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }]);
  });

  it("a 3000x2000 image arrives whole, not dropped, truncated or replaced by [image]", async () => {
    const png = solidPng(3000, 2000);
    expect(await imageBlocksSentFor(png, 2)).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }]);
  });
});
