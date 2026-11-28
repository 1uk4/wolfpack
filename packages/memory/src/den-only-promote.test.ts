import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "@wolfpack/engine";
import { contentHash, type KbRoots } from "@wolfpack/kb/shared";
import { consolidateSession } from "./consolidate.js";
import { writeDenTopic } from "./den.js";
import { denTopicStates, kbOutcome } from "./den-reconcile.js";
import { readDistillRecord } from "./distill.js";
import { writeTopic } from "./session/memory.js";

const WOLF = "w1";
let base: string;
let roots: KbRoots;
let den: string;
let memoryRoot: string;

beforeEach(() => {
  vi.stubEnv("KB_DOMAINS", "");
  base = mkdtempSync(join(tmpdir(), "den-only-"));
  roots = { kbBase: join(base, "kb"), opsRoot: join(base, "ops"), denLocal: join(base, "den", "kb") };
  den = join(base, "den");
  memoryRoot = join(base, "sessions");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

const clean = { slug: "main", title: "Owner merges pull requests", summary: "Only the owner merges.", body: "## Rule\nNever run gh pr merge." };
const engine = { call: async (_s: string, schema: { parse: (v: unknown) => unknown }) => schema.parse({ contributions: [clean] }) } as unknown as Engine;
const inbox = () => (existsSync(join(roots.opsRoot, "inbox", WOLF)) ? readdirSync(join(roots.opsRoot, "inbox", WOLF)) : []);
const promote = (onlyIds: string[]) =>
  consolidateSession({ engine, den: { denRoot: den, wolfName: WOLF }, memoryRoot, sessionId: "durable", kbRoots: roots, defaultDomain: "wolfpack", onlyIds });

describe("promote of a den-only topic (no session copy)", () => {
  it("emits the chosen topic to the KB inbox, and it is recorded once a receipt appears", async () => {
    writeDenTopic(den, { id: "only-den", title: "Only den", summary: "s", updated: "2026-11-01 00:00", body: "den only body" });
    const r = await promote(["only-den"]);
    expect(r.claimsSubmitted).toBe(1);
    expect(inbox()).toHaveLength(1);
    expect(denTopicStates(den, roots, WOLF)[0].status.kind).toBe("awaiting-sweep");

    const out = readDistillRecord(roots, "only-den")!.outputs[0];
    const dir = join(roots.opsRoot, "receipts", WOLF);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${out.id}-${contentHash(out.body.trim()).slice(7, 17)}.md`), `---\nfrom: ${WOLF}\nden_topic_id: only-den\noutcome: create\nprocessed: 2026-11-27 10:00\n---\n\nkb-wolfpack-BBBBBBB\n`);
    expect(kbOutcome(den, roots, WOLF, { id: "only-den" }, ["den only body"])).toEqual({ kind: "create", entryIds: ["kb-wolfpack-BBBBBBB"] });
  });

  it("does not emit a topic with both a den file and a session copy twice", async () => {
    writeTopic(join(memoryRoot, "durable"), { id: "both", title: "Both", summary: "s", updated: "2026-11-01 00:00", body: "same body" });
    writeDenTopic(den, { id: "both", title: "Both", summary: "s", updated: "2026-11-01 00:00", body: "same body" });
    const r = await promote(["both"]);
    expect(r.claimsSubmitted).toBe(1);
    expect(inbox()).toHaveLength(1);
  });

  it("does not emit a den topic held with promotable: false", async () => {
    writeDenTopic(den, { id: "held", title: "Held", summary: "s", updated: "2026-11-01 00:00", body: "log body", promotable: false, promotableReason: "reads as a log" });
    const r = await promote(["held"]);
    expect(r.claimsSubmitted).toBe(0);
    expect(inbox()).toHaveLength(0);
  });
});
