import { describe, it, expect } from "vitest";
import { extractJSON } from "./json-extract.js";

describe("extractJSON", () => {
  it("parses pure JSON", () => {
    expect(extractJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips matched ```json fences", () => {
    expect(extractJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("strips matched bare ``` fences", () => {
    expect(extractJSON('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers from an UNMATCHED opening fence (truncated response)", () => {
    // The real-world Sonnet 5.5 regression: ```json then JSON, then stream ended.
    const truncated = '```json\n{"title":"T","summary":"s","body":"x"}';
    expect(extractJSON(truncated)).toEqual({
      title: "T",
      summary: "s",
      body: "x",
    });
  });

  it("recovers from an UNMATCHED trailing fence", () => {
    const trailing = '{"a":1}\n```';
    expect(extractJSON(trailing)).toEqual({ a: 1 });
  });

  it("falls back to brace-matching when embedded in prose", () => {
    const chatty = 'Here you go:\n\n{"a":[1,2,3]}\n\nHope that helps!';
    expect(extractJSON(chatty)).toEqual({ a: [1, 2, 3] });
  });

  it("brace-matching ignores braces inside strings", () => {
    const trick = '{"body":"text with { braces } and \\"quotes\\""}';
    expect(extractJSON(trick)).toEqual({
      body: 'text with { braces } and "quotes"',
    });
  });

  it("brace-matching tolerates backslash escapes in strings", () => {
    const escaped = '{"path":"C:\\\\Users\\\\x","note":"ok"}';
    expect(extractJSON(escaped)).toEqual({ path: "C:\\Users\\x", note: "ok" });
  });

  it("returns null when nothing parses", () => {
    expect(extractJSON("not json at all")).toBeNull();
  });

  it("handles arrays at top level", () => {
    expect(extractJSON("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("handles arrays wrapped in fences", () => {
    expect(extractJSON('```json\n[{"a":1},{"a":2}]\n```')).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  it("prefers matched fences over partial brace scan", () => {
    // Even though the inner JSON has early braces in strings, fence-match wins.
    const fenced = '```json\n{"body":"{opening brace in string}"}\n```';
    expect(extractJSON(fenced)).toEqual({
      body: "{opening brace in string}",
    });
  });
});
