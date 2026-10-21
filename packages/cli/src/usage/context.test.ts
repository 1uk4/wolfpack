import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "@wolfpack/engine";
import { aggregate } from "./aggregate.js";
import { collectUsage } from "./collect.js";
import { collectContext } from "./context-read.js";
import { resultChars } from "./context.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-context-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TS = "2026-10-20T12:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };

const call = (id: string, name: string, ts = TS) => ({
  type: "message",
  id,
  timestamp: ts,
  message: { role: "assistant", provider: "anthropic", model: "claude-opus-4-8", usage, timestamp: 1, content: [{ type: "toolCall", id, name, arguments: {} }] },
});
const result = (id: string, tool: string, text: string, ts = TS) => ({
  type: "message",
  id: `r${id}`,
  timestamp: ts,
  message: { role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text }] },
});

function write(file: string, lines: object[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** One local wolf: a main session, a subagent session (registry + script), and an old call. */
function fixture(): string {
  const root = path.join(tmp, "wolves");
  const wolf = path.join(root, "local", "me");
  fs.mkdirSync(wolf, { recursive: true });
  fs.writeFileSync(path.join(wolf, "wolf.yaml"), "name: me\n");
  const sessions = path.join(wolf, "agent", "sessions", "--proj--");
  const main = path.join(sessions, "main.jsonl");
  const sub = path.join(sessions, "sub.jsonl");
  const bare = path.join(sessions, "bare.jsonl");
  const sid = (id: string) => ({ type: "session", id, timestamp: TS });
  write(main, [
    sid("main"),
    call("c1", "bash"),
    result("c1", "bash", "x".repeat(300)),
    call("c2", "read"),
    result("c2", "read", "y".repeat(100)),
    call("c3", "subagent"),
    result("c3", "subagent", "ok"),
    call("c4", "bash", OLD),
    result("c4", "bash", "z".repeat(5000), OLD),
  ]);
  write(sub, [sid("sub"), call("s1", "bash"), result("s1", "bash", "w".repeat(1000))]);
  write(bare, [sid("bare"), call("b1", "read"), result("b1", "read", "q".repeat(10))]);
  const run = path.join(sessions, "artifacts", "run1");
  fs.mkdirSync(path.join(run, "subagent-scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(run, "subagent-registry.json"),
    JSON.stringify({ a: { sessionFile: sub }, b: { sessionFile: bare } }),
  );
  fs.writeFileSync(
    path.join(run, "subagent-scripts", "a-1.sh"),
    `#!/bin/bash\n# Session: ${sub}\ncd /x && PI_SUBAGENT_NAME='a' PI_SUBAGENT_AGENT='scout' pi\n`,
  );
  return root;
}

describe("usage by use", () => {
  it("names the subagent's agent when a launch script knows it, else plain subagent", async () => {
    const root = fixture();
    const { events } = await collectUsage({ wolvesRoot: root, hosts: [] });
    const uses = Object.fromEntries(aggregate(events as UsageEvent[], "use").rows.map((r) => [r.key, r.calls]));
    expect(uses).toEqual({ main: 4, "subagent:scout": 1, subagent: 1 });
  });
});

describe("main-context share", () => {
  it("counts text chars in tool results", () => {
    expect(resultChars([{ type: "text", text: "abc" }, { type: "image" }])).toBe(3);
    expect(resultChars("hello")).toBe(5);
    expect(resultChars(undefined)).toBe(0);
  });

  it("splits main from subagent sessions, per tool, within the window", async () => {
    const root = fixture();
    const r = await collectContext({ wolvesRoot: root, hosts: [] }, new Date("2026-10-01T00:00:00Z"));
    expect(r.main.sessions).toBe(1);
    expect(r.main.toolCalls).toBe(3);
    expect(r.main.spawns).toBe(1);
    expect(r.main.resultChars).toBe(402);
    expect(r.main.tools[0]).toMatchObject({ tool: "bash", calls: 1, chars: 300, charShare: 74.6 });
    expect(r.subagent.sessions).toBe(2);
    expect(r.subagent.toolCalls).toBe(2);
    expect(r.subagent.resultChars).toBe(1010);
  });

  it("includes older calls without a window", async () => {
    const r = await collectContext({ wolvesRoot: fixture(), hosts: [] });
    expect(r.main.toolCalls).toBe(4);
    expect(r.main.resultChars).toBe(5402);
  });
});
