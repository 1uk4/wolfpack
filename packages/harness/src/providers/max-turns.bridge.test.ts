/**
 * Runs the wrapper through the REAL claude-stateless bridge (`pi-claude-bridge-stateless/stateless`, npm alias for
 * 1uk4/pi-claude-bridge @45eb3f33, dist/stateless/provider.js), the package claudeStatelessFactory imports at runtime.
 * NOT `pi-claude-bridge` (durable-core), which is the separate claude-bridge provider with no error_max_turns handling.
 * Only the SDK query is faked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createStatelessStreams } from "pi-claude-bridge-stateless/stateless";
import { withMaxTurnsAsTurnEnd } from "./max-turns.js";
import { withDroppedCallNet } from "./dropped-call.js";

const MODEL = { id: "sonnet", api: "x", provider: "p", name: "s", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1e5, maxTokens: 1e4, reasoning: false } as any;
const TOOLS = [{ name: "add", description: "add", parameters: { type: "object", properties: { a: { type: "number" } } } }];
const PREFIX = "mcp__custom-tools__";
const ev = (event: any) => ({ type: "stream_event", event });
const toolBlock = (name: string) => [
  ev({ type: "message_start", message: { id: "m1", usage: { input_tokens: 2 } } }),
  ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } }),
  ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":1}' } }),
  ev({ type: "content_block_stop", index: 0 }),
  ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
  ev({ type: "message_stop" }),
];
const MAX_TURNS = { type: "result", subtype: "error_max_turns", is_error: true, errors: ["Reached maximum number of turns (1)"], usage: { input_tokens: 2, output_tokens: 9 }, num_turns: 2, session_id: "s" };
const fake = (msgs: any[], throwAfter?: string) => () => (async function* () { for (const m of msgs) yield m; if (throwAfter) throw new Error(throwAfter); })();

let root: string;
let seq = 0;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "max-turns-bridge-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function round(queryFn: any, net?: (line: string) => void) {
  const streams = createStatelessStreams({ sessionDir: join(root, "cwd"), claudeDir: join(root, "claude"), queryFn } as any);
  const simple = net ? withDroppedCallNet((streams as any).streamSimple, net) : (streams as any).streamSimple;
  const s = simple(MODEL, { messages: [{ role: "system", content: "x" }, { role: "user", content: "go", timestamp: 1 }] }, { tools: TOOLS, sessionId: `s${++seq}` });
  const types: string[] = [];
  for await (const e of s) types.push(e.type);
  return { types, msg: await s.result() };
}

describe("withMaxTurnsAsTurnEnd through the real claude-stateless bridge (work-wolfpack-beKfWkW)", () => {
  it("control: a served tool_use + error_max_turns already ends as toolUse without the wrapper", async () => {
    const { msg } = await round(fake([...toolBlock(PREFIX + "add"), MAX_TURNS], "Reached maximum number of turns (1)"));
    expect(msg.stopReason).toBe("toolUse");
  });

  it("reproduces the failure: an unmapped tool_use + error_max_turns is fatal without the wrapper", async () => {
    const { msg } = await round(fake([...toolBlock(PREFIX + "nope"), MAX_TURNS], "Reached maximum number of turns (1)"));
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toMatch(/maximum number of turns/);
  });

  it("the dropped/unmapped tool_use case ends the round cleanly with the wrapper (no fatal error, no CONNECTION_LOST)", async () => {
    const log = vi.fn();
    const { types, msg } = await round(withMaxTurnsAsTurnEnd(fake([...toolBlock(PREFIX + "nope"), MAX_TURNS], "Reached maximum number of turns (1)"), log));
    expect(msg.stopReason).toBe("stop");
    expect(msg.errorMessage).toBeUndefined();
    expect(types.at(-1)).toBe("done");
    expect(msg.content.some((b: any) => b.type === "toolCall")).toBe(false); // the unmapped call is lost: logged below
    expect(log).toHaveBeenCalledOnce();
  });

  it("a served tool_use with the wrapper still ends as toolUse and returns the call to the harness", async () => {
    const { msg } = await round(withMaxTurnsAsTurnEnd(fake([...toolBlock(PREFIX + "add"), MAX_TURNS], "Reached maximum number of turns (1)"), vi.fn()));
    expect(msg.stopReason).toBe("toolUse");
    expect(msg.content.find((b: any) => b.type === "toolCall")).toMatchObject({ id: "toolu_1", name: "add", arguments: { a: 1 } });
  });

  it("logs a secret-free summary of the dropped tool_use at the round end (work-wolfpack-7g4ZFMJ)", async () => {
    const lines: string[] = [];
    const { msg } = await round(withMaxTurnsAsTurnEnd(fake([...toolBlock(PREFIX + "nope"), MAX_TURNS], "Reached maximum number of turns (1)"), vi.fn()), (l) => lines.push(l));
    expect(msg.content.some((b: any) => b.type === "toolCall")).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("blocks=[tool_use]");
    expect(lines[0]).toContain("mcp__custom-tools__nope#toolu_1(a)");
    expect(lines[0]).toContain("stop_reason=tool_use");
  });

  it("stays silent for a served tool round", async () => {
    const lines: string[] = [];
    const { msg } = await round(withMaxTurnsAsTurnEnd(fake([...toolBlock(PREFIX + "add"), MAX_TURNS], "Reached maximum number of turns (1)"), vi.fn()), (l) => lines.push(l));
    expect(msg.stopReason).toBe("toolUse");
    expect(lines).toEqual([]);
  });
});
