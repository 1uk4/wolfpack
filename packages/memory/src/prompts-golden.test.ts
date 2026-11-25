/**
 * Golden snapshots of the memory package's LLM prompts (work-wolfpack-rruLly7), a safety net for the prompt cleanup.
 * Systems: B live memory (observer, consolidate), C work memory (record, task summary, stage context), D distill and graduation.
 * Static templates are compared as exported; the assembled prompts (system + user text) are captured at the engine.call
 * seam with a stub engine, from fixed inputs and a pinned clock. Fixtures live in fixtures/prompts/<system>/.
 * (The engine-owned system prompts and work-log builders are in packages/engine/src/prompts-golden.test.ts; F, the crawl, is out of scope.)
 *
 * A failure means a prompt's text changed. If that was deliberate, review the diff and rewrite the fixtures:
 *
 *   UPDATE_PROMPT_GOLDEN=1 wolfpack test run packages/memory/src/prompts-golden.test.ts
 *
 * then commit the changed fixtures.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { expectGolden } from "@wolfpack/engine/dist/golden.js";
import {
  ACTIVE_WORK_CONTEXT_HEADER,
  BREAKDOWN_SUGGESTION_SYSTEM,
  LIVE_OBSERVER_USER_PROMPT,
  PACK_ALREADY_KNOWS_RUNNING_DIGEST_TEMPLATE,
  SESSION_CONSOLIDATION_USER_PROMPT,
  STAGE_CONTEXT,
  SUCCESS_CRITERIA_LINE,
  TASK_SUMMARY_SYSTEM,
} from "./config/prompts/index.js";
import { distillTopic } from "./distill.js";
import { observe } from "./observer/index.js";
import { createOrchestrator } from "./orchestrator.js";
import type { AgentRuntime, LedgerEntry } from "./runtime.js";
import { addWorkNote, addWorkObservation, getWorkSession, onWorkBound, summarizeTask } from "./work-memory.js";
import { consolidateWorkRecords, InMemoryWorkRecordStore } from "./work-record.js";

const dir = join(__dirname, "fixtures", "prompts");

interface Call {
  step: string;
  system: string;
  prompt: string;
}
/** A stub engine that records every call, then answers with `reply(step, n)` (n counts calls from 0). */
function recorder(reply: (step: string, n: number) => unknown): { engine: Engine; calls: Call[] } {
  const calls: Call[] = [];
  const engine = {
    call: async (step: string, _schema: unknown, args: { system: string; prompt: string }) => {
      calls.push({ step, system: args.system, prompt: args.prompt });
      return reply(step, calls.length - 1);
    },
  } as unknown as Engine;
  return { engine, calls };
}
const render = (calls: Call[]) => calls.map((c, i) => `===== CALL ${i + 1}: ${c.step} / SYSTEM =====\n${c.system}\n\n===== CALL ${i + 1}: ${c.step} / PROMPT =====\n${c.prompt}`).join("\n\n");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-20T09:30:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("B live memory prompts", () => {
  it("static user templates are unchanged", () => {
    expectGolden(dir, "B-live-memory/LIVE_OBSERVER_USER_PROMPT.txt", LIVE_OBSERVER_USER_PROMPT);
    expectGolden(dir, "B-live-memory/SESSION_CONSOLIDATION_USER_PROMPT.txt", SESSION_CONSOLIDATION_USER_PROMPT);
    expectGolden(dir, "B-live-memory/PACK_ALREADY_KNOWS_RUNNING_DIGEST_TEMPLATE.txt", PACK_ALREADY_KNOWS_RUNNING_DIGEST_TEMPLATE);
  });

  it("observer: plain, with the general flag, and with a domain-classification suffix", async () => {
    const { engine, calls } = recorder(() => ({ observations: [] }));
    await observe({ engine, chunkText: "User: use sessions.\nAssistant: ok." });
    await observe({ engine, chunkText: "User: use sessions.\nAssistant: ok.", generalFlag: true });
    await observe({ engine, chunkText: "User: use sessions.\nAssistant: ok.", domainContext: "DOMAINS:\n- alpha: first\n- beta: second" });
    expectGolden(dir, "B-live-memory/observer-calls.txt", render(calls));
  });

  it("session consolidate: first pass, then a pass that sees a session topic, with the multi-domain suffix", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "golden-orch-"));
    try {
      const ledger: LedgerEntry[] = [];
      const runtime: AgentRuntime = { name: "test", cwd, sessionId: "sess-1", getNewChunks: () => [], appendLedger: (e) => ledger.push(e), readLedger: () => ledger, on: () => () => {} };
      let obsN = 0;
      const { engine, calls } = recorder((step, n) => {
        if (step === "classify") return { observations: [{ timestamp: `2026-11-20 10:0${obsN++}`, content: `We decided on sessions, part ${obsN}`, domain: "alpha" }] };
        return { actions: n === 1 ? [{ sessionTopicId: "sessions", action: "create", result: { id: "sessions", title: "Sessions", summary: "Use sessions", body: "Sessions it is.", domain: "alpha" }, reasoning: "new" }] : [] };
      });
      const orch = createOrchestrator(engine, runtime, { domains: ["alpha", "beta"], consolidateAtPoolTokens: 1e9, denRoot: join(cwd, "den") });
      await orch.processChunks([{ id: "c1", text: "chunk one", tokenCount: 10, timestamp: "2026-11-20 10:00" }]);
      await orch.consolidateNow();
      await orch.processChunks([{ id: "c2", text: "chunk two", tokenCount: 10, timestamp: "2026-11-20 10:05" }]);
      await orch.consolidateNow();
      expectGolden(dir, "B-live-memory/consolidate-calls.txt", render(calls.filter((c) => c.step === "consolidate")));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("C work memory prompts", () => {
  it("static work-context texts are unchanged", () => {
    expectGolden(dir, "C-work-memory/TASK_SUMMARY_SYSTEM.txt", TASK_SUMMARY_SYSTEM);
    expectGolden(dir, "C-work-memory/BREAKDOWN_SUGGESTION_SYSTEM.txt", BREAKDOWN_SUGGESTION_SYSTEM); // dead: no caller
    expectGolden(dir, "C-work-memory/ACTIVE_WORK_CONTEXT_HEADER.txt", ACTIVE_WORK_CONTEXT_HEADER);
    expectGolden(dir, "C-work-memory/SUCCESS_CRITERIA_LINE.txt", SUCCESS_CRITERIA_LINE);
    expectGolden(dir, "C-work-memory/STAGE_CONTEXT.txt", Object.entries(STAGE_CONTEXT).map(([k, v]) => `## ${k}\n${v}`).join("\n\n"));
  });

  it("workRecord (fold) prompt, with a plan, a current record and a too-long retry", async () => {
    const store = new InMemoryWorkRecordStore({
      "work-x-F1": { id: "work-x-F1", title: "Login feature", kind: "feature", stage: "in_build", successCriteria: "Users can log in", body: "## Plan\nUse sessions.\n\n## Record\n### Decisions\n- Use cookies <!-- src:o0 -->\n" },
    });
    const long = (n: number) => ({ decisions: Array.from({ length: n }, (_, i) => ({ decision: `Decision number ${i} ` + "x".repeat(80), why: "because" })), changes: [], findings: [], problems: [] });
    const { engine, calls } = recorder((_s, n) => (n === 0 ? long(80) : { decisions: [{ decision: "Use sessions", why: "simple" }], changes: [], findings: [], problems: [] }));
    await consolidateWorkRecords({ engine, store, observations: [{ id: "obs1", timestamp: "2026-11-20 10:00", content: "Decided to use sessions", work: "work-x-F1" }, { id: "obs2", content: "Found a race in refresh", work: "work-x-F1" }] });
    expectGolden(dir, "C-work-memory/workRecord-calls.txt", render(calls));
  });

  it("task summary prompt (task_done) with a session of observations and notes", async () => {
    onWorkBound("work-x-T1" as never, "wolf-a" as never, "2026-11-20T08:00:00Z");
    addWorkObservation("work-x-T1" as never, "2026-11-20T08:10:00Z", "Observed a race");
    addWorkNote("work-x-T1" as never, "2026-11-20T08:20:00Z", "Remember the cookie flag");
    const { engine, calls } = recorder(() => ({ summary: "s", implementation: "i" }));
    await summarizeTask(engine, { task: { id: "work-x-T1", title: "Fix login", successCriteria: "Login works", area: "auth" } as never, taskBody: "Plan: use sessions", session: getWorkSession("work-x-T1" as never) ?? null });
    expectGolden(dir, "C-work-memory/taskSummary-call.txt", render(calls));
  });
});

describe("D distill and graduation prompts", () => {
  const output = (c: Array<Record<string, unknown>>) => ({ contributions: c });
  const good = { slug: "sessions", title: "Sessions for login", summary: "Login uses server sessions.", body: "Login uses server sessions with a cookie." };
  const input = { id: "den-topic-1", title: "Login sessions", summary: "How login works", body: "We use sessions.", domain: "wolfpack", date: "2026-11-20", previous: [{ slug: "old", title: "Old entry" }], existing: [{ id: "kb-1", title: "Auth", summary: "Auth overview" }] };

  it("distill: plain, then a retry carrying CHECK FAILURES", async () => {
    // A work id in a plain contribution is a hard lint finding, which forces the single retry.
    const { engine, calls } = recorder((_s, n) => output([n === 0 ? { ...good, body: "See work-wolfpack-Abc1234 for details." } : good]));
    await distillTopic(engine, input);
    expectGolden(dir, "D-distill-graduation/distill-calls.txt", render(calls));
  });

  it("graduation: finished work item with an initiative, totals and the missing-initiative retry", async () => {
    const { engine, calls } = recorder((_s, n) => output(n === 0 ? [good] : [good, { ...good, slug: "initiative", title: "Login initiative", initiative: true }]));
    await distillTopic(engine, { ...input, id: "grad-1", body: "GRADUATION OF work-wolfpack-Abc1234: the plan and the Record.", graduation: { workId: "work-wolfpack-Abc1234", initiativeTopicId: "init-1", initiativeTitle: "Login initiative", totals: [{ key: "Tests", value: "12 passed" }] } });
    expectGolden(dir, "D-distill-graduation/graduation-calls.txt", render(calls));
  });

  it("graduation: standing feature adds the STANDING block and the missing-feature retry", async () => {
    const { engine, calls } = recorder((_s, n) => output(n === 0 ? [good] : [good, { ...good, slug: "feature", title: "Login feature", feature: true }]));
    await distillTopic(engine, { ...input, id: "grad-2", body: "GRADUATION OF work-wolfpack-Def5678.", graduation: { workId: "work-wolfpack-Def5678", standingFeature: { title: "Login feature" } } });
    expectGolden(dir, "D-distill-graduation/graduation-standing-calls.txt", render(calls));
  });
});
