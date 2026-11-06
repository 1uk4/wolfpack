import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
  const den = mkdtempSync(join(tmpdir(), "crawl-iv-")); // crawl_start records its planning marker in the den
  afterAll(() => rmSync(den, { recursive: true, force: true }));
  const ctx = (capabilities?: { askCards?: boolean }) => ({ wolfDen: den, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env: {}, ...(capabilities ? { capabilities } : {}) });
  const start = (c: ReturnType<typeof ctx>, args: object) => {
    const tool = createCrawlExtension({}, c).tools!.find((t) => t.name === "crawl_start")!;
    return tool.execute(args, { wolfDen: den, conversationId: 1 } as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;
  };

  it("with askCards it returns the cards questionnaire", async () => {
    const r = await start(ctx({ askCards: true }), {});
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("TWO brief calls");
    expect(r.content[0].text).toContain('id "source"'); // no path given: the card asks for it
  });

  it("the cwd hint is the workspace from the extension context, not the daemon's cwd", async () => {
    const r = await start({ ...ctx({ askCards: true }), workspace: "/the/wolf/workspace" }, {});
    expect(r.content[0].text).toContain("the wolf's workspace is /the/wolf/workspace");
    expect(r.content[0].text).not.toContain(process.cwd());
  });

  it("without the capability and without a path it refuses instead of interviewing", async () => {
    const r = await start(ctx(), {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("needs `path`");
  });
});

describe("crawl directive", () => {
  const base = { cwd: "/cwd", domains: ["wolfpack", "snapjack"], defaultDomain: "wolfpack", hints: [] as string[] };

  it("the directive raises two brief cards and a confirm", () => {
    const d = buildCrawlDirective({ ...base, src: "/src", hints: ["domain=snapjack"] });
    expect(d).toContain("TWO brief calls");
    expect(d).not.toContain("ask_user_question");
    expect(d).toContain('kind "confirm"');
    expect(d).toContain("include / exclude");
    expect(d).toContain("domain=snapjack");
    expect(d).not.toContain('id "source"');
    expect(d).not.toContain("/wolf:crawl-run"); // no dead end: the durable host has no run command
    expect(d).toContain("crawl_run"); // points at the durable run tool
    expect(d).toContain("showIf");
  });

  it("cards wording uses the wolf workspace for the source hint, and omits it when unknown", () => {
    expect(buildCrawlDirective({ ...base, cwd: "/wolf/work" })).toContain("the wolf's workspace is /wolf/work");
    const none = buildCrawlDirective({ ...base, cwd: undefined });
    expect(none).not.toContain("workspace is");
    expect(none).not.toContain("undefined");
  });
});
