import { describe, expect, it } from "vitest";
import createCrawlExtension from "./unified-crawl.js";
import { buildCrawlDirective, canInterview } from "./crawl-interview.js";

describe("crawl interview capability gating", () => {
  const g = { draftOnly: false, hasUI: false, idle: true, askCards: false };

  it("wolfd (askCards) interviews without any UI", () => {
    expect(canInterview({ ...g, askCards: true })).toBe(true);
    expect(canInterview({ ...g, askCards: true, idle: false })).toBe(true);
  });

  it("no UI and no cards stays the deterministic fallback", () => {
    expect(canInterview(g)).toBe(false);
  });

  it("pi keeps its rule: an idle TUI interviews, a busy one does not", () => {
    expect(canInterview({ ...g, hasUI: true })).toBe(true);
    expect(canInterview({ ...g, hasUI: true, idle: false })).toBe(false);
  });

  it("--draft / draft=true always wins", () => {
    expect(canInterview({ ...g, hasUI: true, draftOnly: true })).toBe(false);
    expect(canInterview({ ...g, askCards: true, draftOnly: true })).toBe(false);
  });
});

describe("crawl_start by capability", () => {
  const ctx = (capabilities?: { askCards?: boolean }) => ({ wolfDen: "/nonexistent-den", wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env: {}, ...(capabilities ? { capabilities } : {}) });
  const start = (c: ReturnType<typeof ctx>, args: object) => {
    const tool = createCrawlExtension({}, c).tools!.find((t) => t.name === "crawl_start")!;
    return tool.execute(args, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;
  };

  it("with askCards it returns the cards questionnaire", async () => {
    const r = await start(ctx({ askCards: true }), {});
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("`questions` list");
    expect(r.content[0].text).toContain('id "source"'); // no path given: the card asks for it
  });

  it("without the capability and without a path it refuses instead of interviewing", async () => {
    const r = await start(ctx(), {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("needs `path`");
  });
});

describe("crawl directive", () => {
  const base = { cwd: "/cwd", domains: ["wolfpack", "snapjack"], defaultDomain: "wolfpack", hints: [] as string[] };

  it("pi/TUI wording is the one-question-per-call directive", () => {
    const d = buildCrawlDirective({ ...base, src: "/src", cards: false });
    expect(d).toContain("Ask exactly ONE question per tool call");
    expect(d).toContain("Offer options: wolfpack, snapjack.");
    expect(d).not.toContain("`questions`");
  });

  it("cards wording batches the questions and uses confirm", () => {
    const d = buildCrawlDirective({ ...base, src: "/src", cards: true, hints: ["domain=snapjack"] });
    expect(d).toContain("ONE ask_user_question call whose `questions` list");
    expect(d).toContain('kind "confirm"');
    expect(d).toContain("include / exclude");
    expect(d).toContain("domain=snapjack");
    expect(d).not.toContain('id "source"');
  });
});
