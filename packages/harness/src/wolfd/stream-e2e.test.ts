/**
 * End to end: ScriptedEngine -> WolfServer -> HttpConsoleClient.watch -> console SSE handler -> ThreadEventAdapter.
 * The view must finish with the full stored text, even when the provider restreamed or diverged.
 */
import { afterEach, describe, expect, it } from "vitest";
import { HttpConsoleClient } from "@wolfpack/client";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";

const servers: WolfServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

// The adapter and handlers live in the console app (outside this package's rootDir): load them dynamically.
const consoleSrc = "../../../../apps/console/src";
const load = (p: string) => import(/* @vite-ignore */ `${consoleSrc}/${p}`);

async function runThroughView(engine: ScriptedEngine): Promise<{ viewText: string; stored: string }> {
  const server = new WolfServer({ name: "w", conversation: engine });
  servers.push(server);
  await server.attach();
  const url = await server.listen();
  const client = new HttpConsoleClient({ baseUrl: url, retryDelayMs: 5 });
  const [{ ThreadEventAdapter }, { createThreadApi }] = await Promise.all([load("core/thread-adapter.ts"), load("server/thread-api.ts")]);
  const thread = (await client.listThreads("w"))[0];
  await client.submit(thread.id, "hi");
  const slug = thread.id.startsWith("w/") ? thread.id.slice(2) : thread.id;
  const res: Response = await createThreadApi(() => client).stream({ wolf: "w", slug }, new Request("http://t/stream"));
  const adapter = new ThreadEventAdapter();
  const messages: string[] = [];
  for (const chunk of (await res.text()).split("\n\n").filter(Boolean)) {
    const data = chunk.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
    if (data === "[DONE]") continue;
    for (const w of adapter.apply(JSON.parse(data))) {
      if (w.type === "message_end") messages.push((w.message as any).content.map((b: any) => b.text ?? "").join(""));
    }
  }
  const detail = await client.getThread(thread.id);
  return { viewText: messages.join(""), stored: detail.messages.filter((m) => m.role === "assistant").map((m) => m.text).join("") };
}

describe("live view end to end", () => {
  it("a restreamed head and an unstreamed tail: the view ends with the full stored text", async () => {
    const engine = new ScriptedEngine({ delayMs: 10, script: [{ kind: "text", text: "MIDDLE-" }] });
    engine.restreamNext("HEAD-", "TAIL");
    const { viewText, stored } = await runThroughView(engine);
    expect(stored).toBe("HEAD-MIDDLE-TAIL");
    expect(viewText).toBe(stored);
  });

  it("a diverged final: the snapshot frame replaces the stale text in the view", async () => {
    const engine = new ScriptedEngine({ delayMs: 10, script: [{ kind: "text", text: "abandoned partial" }] });
    engine.divergeNextFinal("the real answer");
    const { viewText, stored } = await runThroughView(engine);
    expect(stored).toBe("the real answer");
    expect(viewText).toBe(stored);
  });
});
