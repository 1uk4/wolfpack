/**
 * Golden snapshots of the engine-owned LLM prompts (work-wolfpack-rruLly7): a safety net for the prompt cleanup.
 * Every system prompt exported by prompts.ts, config/prompts/memory.ts and work-tidy.ts, plus the user-prompt builders of
 * the work-log steps (rendered from fixed inputs), is compared byte for byte with a fixture under fixtures/prompts/<system>/.
 *
 * Systems: B live memory, C work memory, D den-to-KB distill and graduation, E hub KB sweep and reorg.
 * (A, G and the memory/kb user prompts have their own golden tests; F, the crawl, is out of scope.)
 *
 * A failure means a prompt's text changed. If that was deliberate, review the diff and rewrite the fixtures:
 *
 *   UPDATE_PROMPT_GOLDEN=1 wolfpack test run packages/engine/src/prompts-golden.test.ts
 *
 * then commit the changed fixtures. A prompt deleted on purpose: delete its test line and its fixture file together.
 * The first test also fails when an exported *_SYSTEM constant has no snapshot here, so a new prompt cannot slip in unseen.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectGolden } from "./golden.js";
import * as engine from "./index.js";

const dir = join(__dirname, "fixtures", "prompts");

/** constant name -> system folder. Dead prompts (no live call site) are marked in the fixture name only by this list. */
const SYSTEM_PROMPTS: Record<string, "B-live-memory" | "C-work-memory" | "D-distill-graduation" | "E-hub-kb"> = {
  OBSERVER_SYSTEM: "B-live-memory",
  OBSERVER_GENERAL_FLAG: "B-live-memory",
  CONSOLIDATE_SYSTEM: "B-live-memory",
  WORK_RECORD_SYSTEM: "C-work-memory",
  WORK_LOG_SYSTEM: "C-work-memory",
  WORK_COMPACT_SYSTEM: "C-work-memory",
  WORK_DISTILL_SYSTEM: "C-work-memory",
  WORK_TIDY_SYSTEM: "C-work-memory",
  DISTILL_SYSTEM: "D-distill-graduation",
  DISTILL_GRADUATION: "D-distill-graduation",
  DISTILL_GRADUATION_STANDING: "D-distill-graduation",
  SECTION_PICK_SYSTEM: "E-hub-kb",
  SECTION_SUMMARY_SYSTEM: "E-hub-kb",
  LABEL_SECTION_SYSTEM: "E-hub-kb",
  SPLIT_SECTION_SYSTEM: "E-hub-kb",
  MATCH_SUBJECT_SYSTEM: "E-hub-kb",
  CONFIRM_SUBJECT_SYSTEM: "E-hub-kb",
  PRODUCE_SYSTEM: "E-hub-kb",
};

describe("engine prompt snapshots", () => {
  it("every exported system prompt has a snapshot entry (crawl prompts excluded: system F)", () => {
    const exported = Object.entries(engine)
      .filter(([k, v]) => typeof v === "string" && /(_SYSTEM|^DISTILL_GRADUATION\w*|_FLAG)$/.test(k) && !k.startsWith("CRAWL_"))
      .map(([k]) => k)
      .sort();
    expect(exported).toEqual(Object.keys(SYSTEM_PROMPTS).sort());
  });

  for (const [name, folder] of Object.entries(SYSTEM_PROMPTS)) {
    it(`${folder}/${name} text is unchanged`, () => {
      expectGolden(dir, `${folder}/${name}.txt`, (engine as unknown as Record<string, string>)[name]!);
    });
  }

  it("C-work-memory user prompts render the same from fixed inputs", () => {
    const out = [
      "## buildWorkLogPrompt\n" +
        engine.buildWorkLogPrompt({ title: "Fix  the login\nbug", observations: ["Decided to use sessions", "Found a race in refresh"], recentLines: ["Earlier line one", "Earlier line two"] }),
      "## buildWorkCompactPrompt\n" + engine.buildWorkCompactPrompt({ targetChars: 1200, lines: [{ kind: "decision", text: "Use sessions" }, { kind: "problem", text: "Race in refresh" }] }),
      "## buildWorkDistillPrompt\n" +
        engine.buildWorkDistillPrompt({ taskId: "work-d-T1", title: "Login fix", log: ["Used sessions"], outcomes: ["Login works"], recordHeadings: ["Decisions", "Changes"], recordBullets: ["b1", "b2"] }),
      "## buildWorkTidyPrompt\n" +
        engine.buildWorkTidyPrompt({ title: "Login feature", outcomes: ["Login works"], lines: [{ group: "Decisions", text: "Use sessions" }, { group: "Changes", text: "Added a cookie" }] }),
    ].join("\n\n");
    expectGolden(dir, "C-work-memory/user-prompt-builders.txt", out);
  });
});
