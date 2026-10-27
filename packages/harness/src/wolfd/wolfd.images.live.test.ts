/**
 * LIVE (subscription): an attached image must reach the model on a real transport, as a first message, as a later
 * message in an ongoing thread, and as a `read` tool result. The scripted engine drops image parts, so only this
 * exercises the real conversion. Skipped unless WOLFD_LIVE=1.
 *   WOLFD_LIVE=1 npm test -w @wolfpack/harness -- wolfd.images.live
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpConsoleClient, type ThreadEvent } from "@wolfpack/client";
import { startWolf, type RunningWolf } from "./run.js";

const live = Boolean(process.env.WOLFD_LIVE);

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
/** A solid-colour square PNG. */
function solidPng(size: number, [r, g, b]: [number, number, number], height = size, noise = false): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(Buffer.concat(Array.from({ length: height }, () => (noise ? Buffer.concat([Buffer.from([0]), randomBytes(size * 3)]) : row))));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

describe.skipIf(!live)("wolfd live (subscription): images reach the model", () => {
  let root: string;
  let work: string;
  let wolf: RunningWolf;
  let client: HttpConsoleClient;
  const HOME = "imgwolf/home";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "wolfd-imglive-"));
    const tier = { model: "claude-haiku-5-5", modelSource: "default", provider: "claude-agent-sdk", piModel: "claude-bridge/claude-haiku-5-5" };
    writeFileSync(join(root, "models.json"), JSON.stringify({ location: "local", transport: "subscription", transportSource: "default", tiers: { main: tier, smart: tier, fast: tier }, steps: {}, warnings: [] }));
    work = join(root, "work");
    mkdirSync(work);
    writeFileSync(join(work, "magenta.png"), solidPng(64, [255, 0, 255]));
    writeFileSync(join(work, "big-yellow.png"), solidPng(3000, [255, 255, 0], 2000));
    writeFileSync(join(root, "wolf.yaml"), `name: imgwolf\nworkspace: ${work}\n`);
    const { ANTHROPIC_API_KEY: _absent, ...env } = process.env;
    wolf = await startWolf({ configPath: join(root, "wolf.yaml"), env: { ...env, WOLFPACK_MODELS_FILE: join(root, "models.json") }, home: root });
    client = new HttpConsoleClient({ baseUrl: wolf.url });
  }, 30_000);

  afterAll(async () => {
    await wolf?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const collect = async (it: AsyncIterable<ThreadEvent>) => {
    const out: ThreadEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  };
  const readResults: string[] = [];
  const lastReply = async () => (await client.getThread(HOME)).messages.at(-1)?.text.toLowerCase() ?? "";
  const ask = async (text: string, attach?: Buffer) => {
    const attachments = attach ? [await client.uploadAttachment(HOME, attach, { mimeType: "image/png", name: "shot.png" })] : [];
    await client.submit(HOME, text, { whenBusy: "reject", attachments });
    for (const e of await collect(client.watch(HOME))) if (e.type === "tool-end") readResults.push(String(e.result));
    return lastReply();
  };

  // Tools are forbidden in the attachment cases: the message carries a path note, so a model that cannot see the
  // inline image would otherwise just `read` the file and mask the bug.
  const NO_TOOLS = "Do NOT call any tools. Look only at the image attached to this message. What single colour is it? One word.";

  it("first message: attached image is seen", async () => {
    expect(await ask(NO_TOOLS, solidPng(64, [255, 0, 0]))).toContain("red");
  }, 120_000);

  it("later message in the same thread: attached image is seen", async () => {
    expect(await ask(NO_TOOLS, solidPng(64, [0, 160, 0]))).toContain("green");
  }, 120_000);

  it("a retina-sized attachment is seen", async () => {
    expect(await ask(NO_TOOLS, solidPng(2880, [0, 0, 255], 1800))).toContain("blue");
  }, 120_000);

  it("read tool result: image content is seen", async () => {
    const reply = await ask(`Use the read tool on ${join(work, "magenta.png")} and tell me its single colour in one word.`);
    expect(reply).toMatch(/magenta|pink|fuchsia|purple/);
  }, 120_000);

  it("read tool result: an oversized screenshot is shrunk, not refused", async () => {
    const reply = await ask(`Use the read tool on ${join(work, "big-yellow.png")} and tell me its single colour in one word.`);
    expect(readResults.join("\n")).not.toMatch(/too large|larger than|cannot be prepared/);
    expect(reply).toMatch(/yellow/);
  }, 120_000);
});
