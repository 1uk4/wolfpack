import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { orchestratorRules } from "./orchestrator.js";
import { PROMPT_MAX_BYTES, PromptWriteError, resetPromptOverride, resolvePrompt, writePromptOverride } from "./prompts.js";

let a: string;
let b: string;
beforeEach(() => {
  a = mkdtempSync(join(tmpdir(), "prompts-a-"));
  b = mkdtempSync(join(tmpdir(), "prompts-b-"));
});
afterEach(() => {
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof PromptWriteError ? e.code : String(e);
  }
  return "none";
};

describe("prompt resolver", () => {
  it("an override applies to its own wolf only, and reset restores the repo default", () => {
    const base = resolvePrompt("orchestrator-rules", a);
    expect(base.source).toBe("default");
    writePromptOverride(a, "orchestrator-rules", "Custom for {{opsRef}} / {{paneNote}}");
    expect(resolvePrompt("orchestrator-rules", a)).toMatchObject({ source: "override", text: "Custom for {{opsRef}} / {{paneNote}}" });
    expect(resolvePrompt("orchestrator-rules", b)).toEqual(base);
    expect(orchestratorRules({ opsRef: "/ops.md", surface: "tui", wolfHome: a })).toMatch(/^Custom for \/ops\.md \/ Each agent has its own pane/);
    expect(resetPromptOverride(a, "orchestrator-rules")).toEqual(base);
  });

  it("rejects a stale etag, an oversized text and an unknown or non-editable id; leaves no temp file", () => {
    const first = writePromptOverride(a, "orchestrator-rules", "one");
    writePromptOverride(a, "orchestrator-rules", "two", first.etag); // current etag: accepted
    expect(code(() => writePromptOverride(a, "orchestrator-rules", "three", first.etag))).toBe("stale");
    expect(code(() => writePromptOverride(a, "orchestrator-rules", "x".repeat(PROMPT_MAX_BYTES + 1)))).toBe("too_large");
    expect(code(() => writePromptOverride(a, "nope", "x"))).toBe("unknown");
    expect(readFileSync(join(a, "agent", "prompts", "orchestrator-rules.md"), "utf8")).toBe("two");
    expect(readdirSync(join(a, "agent", "prompts"))).toEqual(["orchestrator-rules.md"]);
    expect(existsSync(join(b, "agent"))).toBe(false);
  });
});
