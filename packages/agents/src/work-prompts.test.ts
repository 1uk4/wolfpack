import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePrompt, writePromptOverride } from "./prompts.js";
import { newWorkPrompt } from "./work-prompts.js";

const golden = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "work-prompts-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("new-work prompt", () => {
  it("is byte-identical to the text the terminal work console always sent, with and without domains", () => {
    const domains = [{ name: "wolfpack", description: "the platform" }, { name: "personal" }];
    expect(newWorkPrompt(domains)).toBe(golden("new-work-prompt.golden.txt"));
    expect(newWorkPrompt()).toBe(golden("new-work-prompt-nodomains.golden.txt"));
    expect(newWorkPrompt(domains, home)).toBe(golden("new-work-prompt.golden.txt"));
  });

  it("registers all four prompts as editable, and a wolf's override of one stage flows into the assembled prompt", () => {
    for (const id of ["new-work", "grilling", "to-spec", "to-tickets"]) expect(resolvePrompt(id, home)).toMatchObject({ source: "default" });
    writePromptOverride(home, "to-spec", "MY SPEC $& PROTOCOL {{grilling}}");
    writePromptOverride(home, "new-work", "Domains:\n{{domains}}\n[{{grilling}}]\n[{{toSpec}}]\n[{{toTickets}}]");
    const text = newWorkPrompt([{ name: "a", description: "d" }], home);
    expect(text.startsWith("Domains:\n- **a** — d\n[")).toBe(true);
    expect(text).toContain("[MY SPEC $& PROTOCOL {{grilling}}]");
    expect(newWorkPrompt([], undefined)).toBe(golden("new-work-prompt-nodomains.golden.txt"));
  });
});
