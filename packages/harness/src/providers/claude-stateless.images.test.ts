/**
 * Image handling at the claude-stateless queryFn seam (the retired bridge seam suite covered it). Real stateless bridge,
 * fake SDK query. History (earlier user messages, tool results) reaches Claude through the resumable session file the bridge
 * writes; the CURRENT user message is the query prompt.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStatelessStreams } from "pi-claude-bridge-stateless/stateless";

const MODEL = { id: "sonnet", api: "x", provider: "p", name: "s", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1e5, maxTokens: 1e4, reasoning: false } as any;
const IMG = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
const END = [
  { type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 1 } } } },
  { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
  { type: "stream_event", event: { type: "message_stop" } },
  { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1, session_id: "s" },
];

let root: string;
let seq = 0;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "stateless-images-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });

async function round(messages: unknown[]) {
  const sessionDir = join(root, `cwd${++seq}`);
  const claudeDir = join(root, `claude${seq}`);
  const queries: any[] = [];
  const queryFn = (args: any) => { queries.push(args); return (async function* () { for (const m of END) yield m; })(); };
  const streams = createStatelessStreams({ sessionDir, claudeDir, queryFn } as any);
  const s = (streams as any).streamSimple(MODEL, { messages: [{ role: "system", content: "x" }, ...messages] }, { sessionId: `img${seq}` });
  for await (const _ of s) { /* drain */ }
  await s.result();
  const sessionText = (() => { try { return files(claudeDir).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(f, "utf8")).join("\n"); } catch { return ""; } })();
  return { queries, sessionText };
}

const hasImageBlock = (s: string) => /"type":"image"/.test(s) && s.includes("aGVsbG8=");

describe("claude-stateless images reach the SDK as image blocks, not [image]", () => {
  it("an image in an earlier user message is in the resumed session history", async () => {
    const { sessionText } = await round([
      { role: "user", content: [{ type: "text", text: "look" }, IMG], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "seen" }], api: "x", provider: "p", model: "sonnet", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
      { role: "user", content: "and now?", timestamp: 3 },
    ]);
    expect(hasImageBlock(sessionText)).toBe(true);
  });

  it("an image in a tool result is in the session history", async () => {
    const { sessionText } = await round([
      { role: "user", content: "screenshot it", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "toolu_1", name: "shot", arguments: {} }], api: "x", provider: "p", model: "sonnet", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "toolu_1", toolName: "shot", content: [{ type: "text", text: "ok" }, IMG], isError: false, timestamp: 3 },
      { role: "user", content: "describe it", timestamp: 4 },
    ]);
    expect(hasImageBlock(sessionText)).toBe(true);
  });

  // KNOWN UPSTREAM GAP (pi-claude-bridge-stateless @45eb3f33, dist/stateless/plan.js textOf): the current user message becomes
  // the string prompt and its images are flattened to "[image]". Fix in the bridge (send a streaming-input prompt with an
  // image block); then drop `.fails` so this test guards the fix.
  it.fails("an image in the current (last) user message reaches the query prompt as an image block", async () => {
    const { queries } = await round([{ role: "user", content: [{ type: "text", text: "look" }, IMG], timestamp: 1 }]);
    expect(queries).toHaveLength(1);
    const prompt = queries[0].prompt;
    const seen = typeof prompt === "string" ? prompt : JSON.stringify(await (async () => { const out: unknown[] = []; for await (const m of prompt) out.push(m); return out; })());
    expect(seen).not.toContain("[image]");
    expect(hasImageBlock(seen)).toBe(true);
  });
});
