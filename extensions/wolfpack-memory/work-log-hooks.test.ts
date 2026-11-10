import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "@wolfpack/engine";
import createTasksExtension from "./unified-tasks.js";

// Durable ship/archive/unbind hooks of `memory.workLog: append`: an in-memory Work API behind fetch, a scripted engine, a temp den.
type Item = Record<string, any>;
let items: Map<string, Item>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
let urls: string[];
async function fetchImpl(url: string | URL, init: RequestInit = {}) {
  const u = new URL(String(url));
  urls.push(`${init.method} ${u.pathname}${u.search}`);
  const m = decodeURIComponent(u.pathname.replace(/^\/work\/?/, ""));
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (init.method === "GET" && m === "") {
    const ids = u.searchParams.get("ids")?.split(",");
    const partOf = u.searchParams.get("partOf");
    return json({ items: [...items.values()].filter((i) => (!ids || ids.includes(i.id)) && (!partOf || i.partOf === partOf)) });
  }
  const it = items.get(m);
  if (!it) return json({ error: "not found" }, 404);
  if (init.method === "GET") return json({ item: it, body: it.body });
  if (init.method === "PATCH") {
    if (body.op === "recordAppend") {
      const rows = (body.lines as Array<{ at: string; src: string; kind: string; text: string; ids: string[] }>).map((l) => `- 10:00 [${l.src}\u00b7${l.kind}] ${l.text} <!-- src:${l.ids.join(",")} -->`);
      const head = body.group ? `\n\n### ${body.group}\n\n` : "\n";
      it.body = `${it.body ?? "## Record\n"}${head}${rows.join("\n")}`;
      return json({ item: it });
    }
    if (body.stage) it.stage = body.stage;
    if (typeof body.body === "string") it.body = body.body;
    if (body.section?.name === "Record") it.body = `## Record\n\n${body.section.text}`;
    return json({ item: it });
  }
  return json({ error: "unsupported" }, 400);
}

let den: string;
let steps: string[];
const engine = {
  call: async (step: string) => {
    steps.push(step);
    if (step === "workLog") return { lines: [{ kind: "change", text: "did the thing", from: ["o1"] }] };
    return { lines: [{ group: "Changes", text: "Task did the thing" }] };
  },
  usage: { summarize: () => ({}) },
} as unknown as Engine;

const make = (workLog?: "append") =>
  createTasksExtension({ engine: () => engine, ...(workLog ? { workLog } : {}) }, { wolfDen: den, wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: {}, capabilities: {} } as never);
const stage = (ext: ReturnType<typeof make>, id: string, to: string) =>
  ext.tools!.find((t) => t.name === "task_stage")!.execute({ id, to }, { cwd: den, wolfDen: den, wolfName: "1uk4", conversationId: 1 } as never);

beforeEach(() => {
  den = mkdtempSync(join(tmpdir(), "wlh-"));
  steps = [];
  urls = [];
  items = new Map();
  items.set("work-w-F", { id: "work-w-F", kind: "feature", title: "F", stage: "in_build", domain: "w", container: false, log: [], body: "## Record\n", partOf: null });
  items.set("work-w-T", { id: "work-w-T", kind: "task", title: "T", stage: "in_build", domain: "w", container: false, log: [], body: "## Record\n", partOf: "work-w-F" });
  mkdirSync(join(den, ".memory", "pool"), { recursive: true });
  writeFileSync(join(den, ".memory", "pool", "observations.jsonl"), JSON.stringify({ timestamp: "2026-11-09T10:00:00Z", recordedAt: "2026-11-09T10:00:00Z", content: "did the thing", work: "work-w-T", feature: "work-w-F" }) + "\n");
  vi.stubEnv("PI_SUBAGENT_AGENT", "");
  vi.stubEnv("WORK_ENDPOINT", "http://127.0.0.1:1");
  vi.stubEnv("WORK_TOKEN", "t");
  vi.stubGlobal("fetch", fetchImpl);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(den, { recursive: true, force: true });
});

describe("bound-task context (task_current)", () => {
  const current = async (ext: ReturnType<typeof make>) => {
    mkdirSync(join(den, "factory", "conversations", "1"), { recursive: true });
    writeFileSync(join(den, "factory", "conversations", "1", "active-task.json"), JSON.stringify({ workId: "work-w-T", domain: "w", boundAt: "now", featureId: "work-w-F" }));
    items.get("work-w-F")!.body = "## Record\n\n### Changes\n\n- 09:00 [x\u00b7change] feature line";
    items.set("work-w-S", { id: "work-w-S", kind: "task", title: "Sibling", stage: "in_build", domain: "w", container: false, log: [], body: "## Record\n\n- 09:30 [x\u00b7change] sibling line", partOf: "work-w-F" });
    urls.length = 0;
    const r = (await ext.tools!.find((t) => t.name === "task_current")!.execute({}, { cwd: den, wolfDen: den, wolfName: "1uk4", conversationId: 1 } as never)) as { content: Array<{ text: string }> };
    return r.content[0]!.text;
  };

  it("fold mode shows the feature Record alone and reads no sibling bodies", async () => {
    const text = await current(make());
    expect(text).toContain("feature line");
    expect(text).not.toContain("Open tasks in this feature");
    expect(urls.filter((u) => u.includes("work-w-S"))).toEqual([]);
  });

  it("append mode adds the open siblings' Record tails", async () => {
    const text = await current(make("append"));
    expect(text).toContain("feature line");
    expect(text).toContain("sibling line");
  });
});

describe("durable memory.workLog: append hooks", () => {
  it("shipping a task flushes its pending log, then distills it into the feature Record", async () => {
    await stage(make("append"), "work-w-T", "shipped");
    expect(items.get("work-w-T")!.stage).toBe("shipped");
    expect(items.get("work-w-T")!.body).toContain("did the thing");
    expect(items.get("work-w-F")!.body).toContain("Task did the thing <!-- src:distilled:work-w-T");
    expect(steps).toEqual(["workLog", "workDistill"]);
    expect(readFileSync(join(den, ".memory", "pool", "observations.jsonl"), "utf8")).toBe("");
  });

  it("archiving a task also flushes then distills", async () => {
    await stage(make("append"), "work-w-T", "archived");
    expect(steps).toEqual(["workLog", "workDistill"]);
    expect(items.get("work-w-F")!.body).toContain("distilled:work-w-T");
  });

  it("shipping a feature runs the final pass once (append mode)", async () => {
    items.get("work-w-T")!.stage = "shipped";
    items.get("work-w-F")!.body = "## Record\n\n### Changes\n\n- 09:00 [x\u00b7change] wired the cache in a long and wordy way <!-- src:distilled:work-w-T -->\n- 09:10 [x\u00b7change] wired the cache again, same thing <!-- src:o2 -->";
    await stage(make("append"), "work-w-F", "shipped");
    expect(items.get("work-w-F")!.stage).toBe("shipped");
    expect(steps.filter((s) => s === "workTidy")).toHaveLength(1);
    expect(items.get("work-w-F")!.body).toContain("final-pass:work-w-F");
  });

  it("fold mode ships a feature with no final pass", async () => {
    items.get("work-w-T")!.stage = "shipped";
    items.get("work-w-F")!.body = "## Record\n\n### Changes\n\n- 09:00 [x\u00b7change] a line <!-- src:o1 -->";
    await stage(make(), "work-w-F", "shipped");
    expect(steps).toEqual([]);
    expect(items.get("work-w-F")!.body).not.toContain("final-pass:");
  });

  it("fold mode ships without any log flush or distill", async () => {
    await stage(make(), "work-w-T", "shipped");
    expect(items.get("work-w-T")!.stage).toBe("shipped");
    expect(steps).toEqual([]);
  });
});
