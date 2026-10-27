import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import createCrawlExtension from "./unified-crawl.js";
import createMemoryExtension from "./unified.js";
import { crawlMode, IDLE_MS, noteToolCalls } from "./crawl-mode.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "crawl-mode-"));
  dirs.push(d);
  return d;
};
let clock = 0;
beforeEach(() => {
  clock = 1_000_000;
  crawlMode.configure({ now: () => clock });
});
afterEach(() => {
  crawlMode.configure();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("crawlMode state (file-backed)", () => {
  it("planning -> end -> reseed is consumed once; end is a no-op unless planning", () => {
    const den = tmp();
    crawlMode.end(den, 1);
    expect(crawlMode.pending(den, 1)).toBe(false);
    crawlMode.begin(den, 1);
    expect(crawlMode.active(den, 1)).toBe(true);
    crawlMode.end(den, 1);
    expect(crawlMode.active(den, 1)).toBe(false);
    expect(crawlMode.pending(den, 1)).toBe(true); // waiting for its re-seed
    expect(crawlMode.takeReseed(den, 1)).toBe(true);
    expect(crawlMode.takeReseed(den, 1)).toBe(false);
    expect(crawlMode.pending(den, 1)).toBe(false);
  });

  it("is per conversation and per den", () => {
    const a = tmp();
    crawlMode.begin(a, 1);
    expect(crawlMode.active(a, 2)).toBe(false);
    expect(crawlMode.active(tmp(), 1)).toBe(false);
  });

  it("idle timeout: planning ends by itself unless a crawl/ask call touched it", () => {
    const den = tmp();
    crawlMode.begin(den, 1);
    clock += IDLE_MS - 1;
    noteToolCalls(den, 1, ["ask_user_question"]); // touch
    clock += IDLE_MS - 1;
    expect(crawlMode.active(den, 1)).toBe(true);
    clock += 2;
    expect(crawlMode.active(den, 1)).toBe(false); // idle: closed
    expect(crawlMode.takeReseed(den, 1)).toBe(true); // and the interview turns get skipped past
    noteToolCalls(den, 1, ["ask_user_question"]); // not planning: a touch does not start it
    expect(crawlMode.pending(den, 1)).toBe(false);
  });
});

describe("failure paths leave no stuck pause", () => {
  // `broken`: the crawl home sits under a regular file, so drafting a plan throws while the source dir is fine.
  const ctxOf = (den: string, broken = false) => {
    const env: NodeJS.ProcessEnv = {};
    if (broken) {
      writeFileSync(join(den, "afile"), "x");
      env.WOLFPACK_CRAWL_HOME = join(den, "afile", "crawls");
    }
    return { wolfDen: den, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env, capabilities: { askCards: true } };
  };
  const run = (den: string, name: string, args: object, broken = false) => {
    const tool = createCrawlExtension({}, ctxOf(den, broken)).tools!.find((t) => t.name === name)!;
    return tool.execute(args, { wolfDen: den, conversationId: 1 } as never) as Promise<{ isError?: boolean }>;
  };

  it("crawl_start draft throwing ends planning", async () => {
    const den = tmp();
    const empty = tmp();
    const r = await run(den, "crawl_start", { path: empty, draft: true }, true);
    expect(r.isError).toBe(true);
    expect(crawlMode.active(den, 1)).toBe(false);
  });

  it("crawl_plan throwing ends planning; a bad path (re-ask) and a failed finalize keep it", async () => {
    const den = tmp();
    const empty = tmp();
    crawlMode.begin(den, 1);
    expect((await run(den, "crawl_plan", { path: join(empty, "missing") })).isError).toBe(true);
    expect(crawlMode.active(den, 1)).toBe(true); // recoverable: the interview re-asks
    expect((await run(den, "crawl_finalize", {})).isError).toBe(true); // no plan yet
    expect(crawlMode.active(den, 1)).toBe(true); // fix and retry, or crawl_cancel / idle timeout
    expect((await run(den, "crawl_plan", { path: empty }, true)).isError).toBe(true);
    expect(crawlMode.active(den, 1)).toBe(false);
  });

  it("crawl_cancel ends planning and says the draft stays on disk", async () => {
    const den = tmp();
    crawlMode.begin(den, 1);
    const r = (await run(den, "crawl_cancel", {})) as { content: { text: string }[] };
    expect(r.content[0].text).toContain("stays on disk");
    expect(crawlMode.active(den, 1)).toBe(false);
  });
});

describe("pre-tool-call race", () => {
  it("the afterResponse hook of a response carrying crawl_start begins planning synchronously, before any classify", async () => {
    const den = tmp();
    mkdirSync(join(den, "kb"), { recursive: true });
    let classified = 0;
    const ext = createMemoryExtension(
      { live: true, engine: { call: async () => { classified++; return { observations: [] }; } } as never },
      { wolfDen: den, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env: {} },
    );
    const reads = { classify: async () => ({ kind: "home" }), messagesSince: async () => [] };
    const hook = ext.hooks!.afterResponse!;
    const msg = { content: [{ type: "text" as const, text: "x".repeat(300) }, { type: "toolCall" as const, name: "crawl_start", arguments: {} }] };
    hook(msg, { wolfDen: den, wolfName: "w", conversationId: 7, conversation: reads } as never);
    expect(crawlMode.active(den, 7)).toBe(true); // set by the time the hook returned
    await new Promise((r) => setTimeout(r, 50));
    expect(classified).toBe(0);
  });
});
