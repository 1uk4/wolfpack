import { describe, it, expect } from "vitest";
import { buildWorkCompactPrompt, parseWorkCompactOutput, buildWorkLogPrompt, parseWorkDistillOutput, parseWorkLogOutput } from "./work-log.js";

describe("parseWorkLogOutput", () => {
  it("reads a valid answer", () => {
    const out = '{"lines":[{"kind":"decision","text":"Use X because Y","from":["o1"]}]}';
    expect(parseWorkLogOutput(out)).toEqual([{ kind: "decision", text: "Use X because Y", from: ["o1"] }]);
  });

  it("reads an answer inside a fenced block", () => {
    const out = '```json\n{"lines":[{"kind":"finding","text":"A is B","from":["o2"]}]}\n```';
    expect(parseWorkLogOutput(out)).toEqual([{ kind: "finding", text: "A is B", from: ["o2"] }]);
  });

  it("drops an entry with an invalid kind or over-long text, keeps the rest", () => {
    const out = JSON.stringify({
      lines: [
        { kind: "narration", text: "ran a browser check", from: ["o1"] },
        { kind: "change", text: "x".repeat(241), from: [] },
        { kind: "problem", text: "P, fixed by F", from: ["o3"] },
      ],
    });
    expect(parseWorkLogOutput(out)).toEqual([{ kind: "problem", text: "P, fixed by F", from: ["o3"] }]);
  });

  it("keeps at most 6 lines", () => {
    const lines = Array.from({ length: 9 }, (_, i) => ({ kind: "change", text: `c${i}`, from: [] }));
    expect(parseWorkLogOutput(JSON.stringify({ lines })).map((l) => l.text)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
  });

  it("accepts an empty array and returns nothing for unusable text", () => {
    expect(parseWorkLogOutput('{"lines":[]}')).toEqual([]);
    expect(parseWorkLogOutput("sorry, no")).toEqual([]);
  });
});

describe("parseWorkDistillOutput", () => {
  it("reads a valid answer", () => {
    expect(parseWorkDistillOutput('{"lines":[{"group":"Problems & fixes","text":"P, fixed by F"}]}')).toEqual([
      { group: "Problems & fixes", text: "P, fixed by F" },
    ]);
  });

  it("reads a fenced answer", () => {
    expect(parseWorkDistillOutput('```\n{"lines":[{"group":"Changes","text":"C"}]}\n```')).toEqual([{ group: "Changes", text: "C" }]);
  });

  it("drops an invalid group", () => {
    const out = '{"lines":[{"group":"Status","text":"deployed"},{"group":"Findings","text":"F"}]}';
    expect(parseWorkDistillOutput(out)).toEqual([{ group: "Findings", text: "F" }]);
  });

  it("keeps at most 5 lines", () => {
    const lines = Array.from({ length: 8 }, (_, i) => ({ group: "Changes", text: `c${i}` }));
    expect(parseWorkDistillOutput(JSON.stringify({ lines })).map((l) => l.text)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
  });

  it("accepts an empty array", () => {
    expect(parseWorkDistillOutput('{"lines":[]}')).toEqual([]);
  });
});

describe("buildWorkLogPrompt", () => {
  it("numbers observations from o1 and sends only the last 8 recent lines", () => {
    const recent = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const p = buildWorkLogPrompt({ title: "T", observations: ["first", "second"], recentLines: recent });
    expect(p).toContain("[o1] first\n[o2] second");
    expect(p).not.toContain("line1\n");
    expect(p).toContain("- line2\n");
    expect(p).toContain("- line9");
  });
});

describe("parseWorkCompactOutput", () => {
  it("reads a valid answer, keeping which input lines each line merges", () => {
    const out = '{"lines":[{"kind":"decision","text":"Use X because Y","from":["l1","l3"]}]}';
    expect(parseWorkCompactOutput(out)).toEqual([{ kind: "decision", text: "Use X because Y", from: ["l1", "l3"] }]);
  });

  it("drops garbage, unknown kinds, over-long text and lines that cite nothing", () => {
    expect(parseWorkCompactOutput("sorry, no")).toEqual([]);
    const out = JSON.stringify({
      lines: [
        { kind: "narration", text: "ran a check", from: ["l1"] },
        { kind: "change", text: "x".repeat(241), from: ["l2"] },
        { kind: "change", text: "cites nothing", from: ["nope"] },
        { kind: "problem", text: "P, fixed by F", from: ["l4", "bogus"] },
      ],
    });
    expect(parseWorkCompactOutput(out)).toEqual([{ kind: "problem", text: "P, fixed by F", from: ["l4"] }]);
  });
});

describe("buildWorkCompactPrompt", () => {
  it("numbers the lines l1… and states the target size", () => {
    const p = buildWorkCompactPrompt({ lines: [{ kind: "change", text: "a" }, { kind: "finding", text: "b" }], targetChars: 2000 });
    expect(p).toContain("[l1] (change) a");
    expect(p).toContain("[l2] (finding) b");
    expect(p).toContain("2000");
  });
});
