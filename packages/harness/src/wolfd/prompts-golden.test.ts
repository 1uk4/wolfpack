/**
 * Golden snapshots of the main-wolf prompt (system A) and of what a subagent receives (system G), work-wolfpack-rruLly7:
 * a safety net for the prompt cleanup. Memory/work/KB prompts are in packages/{engine,memory,kb}; the per-request
 * extension sections and the tool descriptions are in extensions/wolfpack-memory/prompts-golden.test.ts.
 *
 * A. The system prompt as wolfd composes it (every block, the joined instructions), the strings wolfd injects into the
 *    conversation (task notice, ask answers, superseded notes, continue prompt, empty-ack nudge, error messages) and
 *    the compaction summarizer prompts of pi-durable.
 * G. Every shipped subagent profile with the standards it gets appended (what a child's instructions start with), the
 *    child's own wrapper (with and without a worktree), the standalone prompts (grilling, to-spec, to-tickets, orchestrator rules).
 *
 * Fixtures: fixtures/prompts/A-main-wolf/ and G-subagents/. Temp paths are replaced by <TMP>.
 *
 * A failure means a prompt's text changed. If that was deliberate, review the diff and rewrite the fixtures:
 *
 *   UPDATE_PROMPT_GOLDEN=1 wolfpack test run packages/harness/src/wolfd/prompts-golden.test.ts
 *
 * then commit the changed fixtures. A prompt deleted on purpose: delete its fixture file with it.
 * (The subagent result/steer wrappers in subagents.ts are inline strings inside a private method; they are not snapshotted here.)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { discoverAgents, PROMPTS, resolvePrompt } from "@wolfpack/agents";
import { expectGolden } from "@wolfpack/engine/dist/golden.js";
import { CONTINUE_PROMPT, DROPPED_CALL_MESSAGE, EMPTY_ACK_MESSAGE, EMPTY_ACK_NUDGE, NO_TERMINAL_MESSAGE } from "../providers/dropped-call.js";
import { answerText, supersededNotes } from "./cards.js";
import { composeProjectContext } from "./context.js";
import { piDurableCompactionPrompts } from "./prompt-catalog.js";
import { describeChange } from "./task-notice.js";
import { childInstructions } from "./subagents.js";

const dir = join(__dirname, "fixtures", "prompts");
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "golden-wolfd-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
/** The temp dir varies per run (and may be a symlink target): pin it. */
const pin = (text: string) => text.split(tmp).join("<TMP>").split(tmp.replace(/^\/private/, "")).join("<TMP>");
const put = (rel: string, text: string) => {
  const p = join(tmp, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

describe("A main wolf prompt", () => {
  it("every system block and the joined instructions, for a wolf with identity, workspace rules and a skill", () => {
    put("wolf/agent/AGENTS.md", "IDENTITY FIXTURE: I am the wolf.");
    put("ws/AGENTS.md", "WORKSPACE AGENTS FIXTURE");
    put("ws/CLAUDE.md", "WORKSPACE CLAUDE FIXTURE");
    put("den/skills/demo/SKILL.md", "---\nname: demo\ndescription: A demo skill\n---\n\nSkill body.\n");
    put("ops.md", "ops");
    process.env.WOLFPACK_OPS_REF = join(tmp, "ops.md");
    try {
      const ctx = composeProjectContext({ name: "fixture-wolf", domains: ["alpha", "beta"], cwd: join(tmp, "ws"), den: join(tmp, "den"), home: tmp, wolfHome: join(tmp, "wolf") });
      const blocks = ctx.blocks.map((b) => `===== BLOCK ${b.id} (${b.label}; source: ${b.source}) =====\n${b.text}`).join("\n\n");
      expectGolden(dir, "A-main-wolf/system-blocks.txt", pin(blocks));
      expectGolden(dir, "A-main-wolf/system-instructions.txt", pin(ctx.instructions));
    } finally {
      delete process.env.WOLFPACK_OPS_REF;
    }
  });

  it("strings wolfd injects: continue prompt, empty-ack nudge, error messages, task notice, superseded notes", () => {
    const snap = (stage: string, shipped: number, stages: string, record: string) => ({ workId: "work-x-F1", stage, children: { total: 3, shipped, stages }, record });
    const out = [
      `## CONTINUE_PROMPT\n${CONTINUE_PROMPT}`,
      `## EMPTY_ACK_NUDGE\n${EMPTY_ACK_NUDGE}`,
      `## DROPPED_CALL_MESSAGE\n${DROPPED_CALL_MESSAGE}`,
      `## EMPTY_ACK_MESSAGE\n${EMPTY_ACK_MESSAGE}`,
      `## NO_TERMINAL_MESSAGE\n${NO_TERMINAL_MESSAGE}`,
      `## task notice: stage and counts moved, Record updated\n${describeChange(snap("in_build", 1, "a", "r1"), snap("shipped", 2, "b", "r2"))}`,
      `## task notice: only the feature's tasks changed\n${describeChange(snap("in_build", 1, "a", "r1"), snap("in_build", 1, "b", "r1"))}`,
      `## superseded notes (plain and paged with detail)\n${supersededNotes([{ tool: "ask", callId: "call-1" }, { tool: "ask", callId: "call-2", detail: "Q1 => a;  Q2 => skipped", paged: true }])}`,
    ].join("\n\n");
    expectGolden(dir, "A-main-wolf/injected-strings.txt", out);
  });

  it("ask answers as the model reads them: paged questionnaire, single card, skipped card", () => {
    const paged = {
      tool: "ask",
      paged: true,
      fields: [
        { id: "mode", kind: "single", label: "Mode?", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], allowOther: false },
        { id: "why", kind: "free-text", label: "Why?", optional: true },
      ],
      steps: [{ title: "P1", fields: ["mode"] }, { title: "P2", fields: ["why"] }],
    } as never;
    const single = { tool: "show_decision", fields: [{ id: "pick", kind: "free-text", label: "Pick one" }] } as never;
    const out = [
      "## paged, with a note and a revise note\n" + answerText([{ callId: "c1", card: paged, answers: { mode: { value: "yes" } }, note: { text: "mind it", attachments: ["i1"] }, reviseNote: "its pages changed" }]),
      "## single card\n" + answerText([{ callId: "c2", card: single, answers: { pick: { value: "A" } } }]),
      "## skipped card\n" + answerText([{ callId: "c3", card: single, answers: {}, skipped: true }]),
    ].join("\n\n");
    expectGolden(dir, "A-main-wolf/ask-answers.txt", out);
  });

  it("compaction summarizer prompts of the installed pi-durable", () => {
    const pd = piDurableCompactionPrompts();
    expectGolden(dir, "A-main-wolf/compaction-pi-durable.txt", `## system (${pd.file})\n${pd.system}\n\n## instructions\n${pd.instructions}`.replace(/@\d+\.\d+\.\d+[^ \n]*/g, "@<version>"));
  });
});

describe("G subagent prompts", () => {
  it("every shipped profile as a child gets it: body plus its standards", () => {
    const agents = discoverAgents({ cwd: join(tmp, "none"), agentDir: join(tmp, "none") });
    const out = agents.map((a) => `===== AGENT ${a.name} (tools: ${Array.isArray(a.tools) ? a.tools.join(", ") : String(a.tools ?? "-")}; model: ${a.model ?? "-"}; standards: ${(a.standards ?? []).join(", ") || "-"}) =====\n${a.description}\n\n${a.body}`).join("\n\n");
    expectGolden(dir, "G-subagents/profiles-with-standards.txt", out);
  });

  it("the child wrapper: with and without a worktree", () => {
    const def = { name: "worker", description: "d", body: "PROFILE BODY" } as never;
    const ws = { path: "/w/feat-x--worker", branch: "feat/x-worker", repo: { mainDir: "/r/main", toplevel: "/r/main" } } as never;
    const out = [
      "## no worktree\n" + childInstructions(def, "worker-1"),
      "## worktree of a feature\n" + childInstructions(def, "worker-1", { ws, offLimits: ["/r/main", "/w/feat-x"] }),
    ].join("\n\n");
    expectGolden(dir, "G-subagents/child-wrapper.txt", out);
  });

  it("standalone prompts and standards from the registry: grilling, to-spec, to-tickets, orchestrator rules, every standard", () => {
    const ids = PROMPTS.map((p) => p.id).filter((id) => /^(grilling|to-spec|to-tickets|orchestrator-rules|standard\.)/.test(id));
    const out = ids.map((id) => `===== ${id} =====\n${resolvePrompt(id).text}`).join("\n\n");
    expectGolden(dir, "G-subagents/registry-prompts.txt", out);
  });
});
