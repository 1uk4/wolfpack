/**
 * Bridge release measurement: two subagent-like conversations (each ends its first round parked on a tool call, the
 * state a finished child's query lingers in) on ONE provider; counts `claude` children and their RSS
 *   running (both parked) -> after release("a"/"b") vs. after nothing (idle TTL only).
 * Run: node spikes/bridge-release/run.ts   (subscription login, ANTHROPIC_API_KEY unset; 4 haiku calls)
 */
import { execFileSync } from "node:child_process";
import { createClaudeBridgeProvider } from "pi-claude-bridge/core";
import { NO_TOOL_SEARCH } from "../../packages/harness/src/wolfd/models.ts";

delete process.env.ANTHROPIC_API_KEY;

/** claude children of this process: count and RSS (MB). */
function claudeChildren(): { procs: number; mb: number } {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" }).trim().split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)!).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] }));
  const mine = new Set([process.pid]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (mine.has(r.ppid) && !mine.has(r.pid)) { mine.add(r.pid); grew = true; } }
  const kids = rows.filter((r) => r.pid !== process.pid && mine.has(r.pid) && /stream-json/.test(r.cmd));
  return { procs: kids.length, mb: Math.round(kids.reduce((a, r) => a + r.rss, 0) / 1024) };
}

const tool = { name: "echo", description: "Echo text back", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };

async function scenario(label: string, release: boolean) {
  const provider = createClaudeBridgeProvider({ cwd: process.cwd(), env: { ...process.env, ...NO_TOOL_SEARCH }, sweepOrphans: false });
  const model = (await (provider as any).getModels()).find((m: any) => m.id === "claude-haiku-5-5");
  const base = claudeChildren();
  const call = async (sessionId: string) => {
    const ctx = { systemPrompt: "Call the echo tool once with text 'hi', then stop.", tools: [tool], messages: [{ role: "user", content: "go", timestamp: Date.now() }] };
    for await (const ev of (provider as any).streamSimple(model, ctx, { sessionId })) if (ev.type === "error") console.error("error:", ev.error?.errorMessage);
  };
  await Promise.all([call("a"), call("b")]);
  const parked = claudeChildren();
  const live = provider.liveQueries;
  if (release) { provider.release("a"); provider.release("b"); }
  await new Promise((r) => setTimeout(r, 2500)); // let the children exit
  const after = claudeChildren();
  console.log(JSON.stringify({ label, baseline: base, parked, liveQueriesParked: live, afterWait: after, liveQueriesAfter: provider.liveQueries }));
  provider.shutdown();
  await new Promise((r) => setTimeout(r, 6000));
  console.log(JSON.stringify({ label, afterShutdown: claudeChildren() }));
}

await scenario("no release", false);
await scenario("release", true);
process.exit(0);
