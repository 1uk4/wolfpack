import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { readTopics, writeTopic } from "@wolfpack/memory";
import { rewriteHeldTopic } from "./promote-run.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "held-"));
  dirs.push(root);
  writeTopic(root, { id: "log", title: "Log", summary: "s", updated: "2026-11-13 00:00", body: "did a, then b, then c", sources: ["thread:1"] });
  return root;
}
const engineReplying = (reply: unknown, prompts: string[]) =>
  ({ call: async (_s: string, schema: { parse: (v: unknown) => unknown }, p: { prompt: string }) => { prompts.push(p.prompt); return schema.parse(reply); } }) as unknown as Engine;

describe("rewriteHeldTopic", () => {
  it("rewrites the held topic with the distill findings in the prompt, keeping its id and sources", async () => {
    const root = setup();
    const prompts: string[] = [];
    const engine = engineReplying({ actions: [{ sessionTopicId: "log", action: "merge", reasoning: "r", result: { id: "log", title: "Log", summary: "s", body: "Decision: use X because Y." } }] }, prompts);
    const topic = readTopics(root)[0];
    expect(await rewriteHeldTopic(engine, root, topic, "distill: log-like")).toBe(true);
    expect(prompts[0]).toContain("distill: log-like");
    const after = readTopics(root)[0];
    expect(after.body).toBe("Decision: use X because Y.");
    expect(after.sources).toEqual(["thread:1"]);
    expect(readFileSync(join(root, after.filename), "utf-8")).toContain("id: log");
  });

  it("returns false and leaves the topic when the model fails or answers with another id", async () => {
    const root = setup();
    const failing = { call: async () => { throw new Error("down"); } } as unknown as Engine;
    expect(await rewriteHeldTopic(failing, root, readTopics(root)[0], "why")).toBe(false);
    expect(readTopics(root)[0].body).toBe("did a, then b, then c");
  });
});
