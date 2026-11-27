import { describe, expect, it } from "vitest";
import { assertSectionText, demoteHeadings, replaceSection } from "./section-edit.js";

describe("demoteHeadings", () => {
  it("closes an unclosed fence at the end, with the opener's character and length, so it cannot swallow what follows", () => {
    const out = demoteHeadings("## A\n\n````md\n## x");
    expect(out).toBe("#### A\n\n````md\n## x\n````");
    expect(() => assertSectionText(out)).not.toThrow();
    expect(() => replaceSection(`# F\n\n## Record\n\n${out}\n<!-- /rollup:item -->\n\n## Plan\n\np`, "plan", "q")).not.toThrow();
  });

  it("is idempotent and leaves fenced headings alone", () => {
    const once = demoteHeadings("Title\n=====\n\n> ## Q\n\n~~~\n## k\n~~~");
    expect(once).toBe("#### Title\n\n> #### Q\n\n~~~\n## k\n~~~");
    expect(demoteHeadings(once)).toBe(once);
  });
});
