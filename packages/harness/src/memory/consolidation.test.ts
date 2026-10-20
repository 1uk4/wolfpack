import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { contentHash, type KbRoots } from "@wolfpack/kb/shared";
import { writeDenTopic } from "@wolfpack/memory";
import { consolidatePool } from "./consolidation.js";

const WOLF = "w1";
let root: string;
let den: string;
let roots: KbRoots;

function receipt(id: string, body: string): void {
  const dir = join(roots.opsRoot, "receipts", WOLF);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-${contentHash(body).slice(7, 17)}.md`),
    `---\nfrom: ${WOLF}\nden_topic_id: ${id}\noutcome: merge\nprocessed: 2026-10-20 18:00\n---\n\nkb-wolfpack-AAAAAAA\n`,
  );
}

function pool(n: number): void {
  const dir = join(den, ".memory", "pool");
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify({ timestamp: `2026-10-20T10:0${i}:00Z`, content: `observation ${i} `.repeat(60) }),
  );
  writeFileSync(join(dir, "observations.jsonl"), lines.join("\n") + "\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "consolidate-pool-"));
  den = join(root, "den");
  roots = { kbBase: join(root, "kb"), opsRoot: join(root, "ops"), denLocal: join(den, "kb") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("consolidatePool reconcile (pi-durable promote)", () => {
  it("archives absorbed den topics before the LLM sees the den", async () => {
    writeDenTopic(den, { id: "absorbed", title: "Absorbed", summary: "s", updated: "x", body: "absorbed body" });
    receipt("absorbed", "absorbed body");
    writeDenTopic(den, { id: "pending", title: "Pending", summary: "s", updated: "x", body: "pending body" });
    pool(6);

    let prompt = "";
    const engine = {
      call: async (_step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string }) => {
        prompt = opts.prompt;
        return schema.parse({ actions: [] });
      },
    } as unknown as Engine;

    const progress: string[] = [];
    await consolidatePool({ wolfDen: den, wolfName: WOLF, kbRoots: roots, skipClaims: true, engine, onProgress: (m) => progress.push(m) });

    expect(progress).toContain("reconciled: 1 archived, 1 pending");
    expect(readdirSync(join(den, "memory", "archive"))).toEqual(["absorbed.md"]);
    expect(prompt).toContain("pending body");
    expect(prompt).not.toContain("absorbed body");
  });

  it("keeps only subscribed domains as the hint; invented tags fall back to the default", async () => {
    pool(6);
    const engine = {
      call: async (_s: string, schema: { parse: (v: unknown) => unknown }) =>
        schema.parse({ actions: [
          { sessionTopicId: "lift", action: "create", reasoning: "r", result: { id: "lift", title: "Lift", summary: "s", body: "b1", domain: "fitness" } },
          { sessionTopicId: "plan", action: "create", reasoning: "r", result: { id: "plan", title: "Plan", summary: "s", body: "b2", domain: "personal" } },
        ] }),
    } as unknown as Engine;

    await consolidatePool({ wolfDen: den, wolfName: WOLF, kbRoots: roots, defaultDomain: "personal", domains: ["personal"], engine });

    const inbox = join(roots.opsRoot, "inbox", WOLF);
    const hints = readdirSync(inbox).map((f) => /domain_hint: (\S+)/.exec(readFileSync(join(inbox, f), "utf8"))?.[1]);
    expect(hints).toEqual(["personal", "personal"]);
    expect(readFileSync(join(den, "memory", "topics", "lift.md"), "utf8")).toContain("domain: personal");
  });
});

