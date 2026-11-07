import { describe, expect, it } from "vitest";
import { PR_BODY_LIMIT, parseFeatureDoc, releaseBody, releaseTitle, type ReleaseFeature, type ReleaseInput } from "./release-pr.js";

const feature = (o: Partial<ReleaseFeature> = {}): ReleaseFeature => ({
  id: "work-wolfpack-feat0001",
  title: "Owner-merged PR flow",
  screenshots: [],
  ...o,
});
const input = (o: Partial<ReleaseInput> = {}): ReleaseInput => ({
  wolf: "1uk4",
  date: "2026-11-06",
  previousStable: "abc1234",
  features: [feature()],
  otherCommits: [],
  liveEval: "not wired yet (work-wolfpack-tJ18SgU)",
  ...o,
});
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const fences = (s: string) => s.split("\n").filter((l) => /^\s*(```|~~~)/.test(l)).length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("release PR title", () => {
  it("names the wolf, the date and the feature count", () => {
    expect(releaseTitle(input({ features: [feature(), feature({ id: "work-wolfpack-feat0002" })] }))).toBe("Release 1uk4 2026-11-06: 2 features");
    expect(releaseTitle(input())).toBe("Release 1uk4 2026-11-06: 1 feature");
  });
});

describe("release PR body", () => {
  const full = input({
    tests: "312 passed",
    ci: "see the checks on this PR",
    features: [
      feature({ risk: "touches the deploy path", manualChecks: ["open the console"], diagram: "graph TD; A-->B", screenshots: ["https://x/a.png"], document: "# Doc\nthe feature" }),
    ],
    otherCommits: ["abc1234 chore(deps): bump"],
  });

  it("orders Decide, Tests and CI, one section per feature, then Other commits", () => {
    const { body } = releaseBody(full);
    const at = (s: string) => body.indexOf(s);
    const order = ["## Decide", "## Tests and CI", "### Owner-merged PR flow (work-wolfpack-feat0001)", "```mermaid\ngraph TD; A-->B\n```", "![work-wolfpack-feat0001 screenshot](https://x/a.png)", "# Doc\nthe feature", "## Other commits", "- abc1234 chore(deps): bump"];
    expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
    expect(order.map(at).every((n) => n >= 0)).toBe(true);
    expect(body).toContain("- **Rollback:** `git revert -m 1 <merge sha>`. Previous stable (at prepare time): `abc1234`.");
    expect(body).toContain("- live/eval: not wired yet (work-wolfpack-tJ18SgU)");
  });

  it("lists risk and manual checks per feature, labelled by feature, and says 'not provided' for a feature without them", () => {
    const { body } = releaseBody(
      input({
        features: [
          feature({ risk: "touches the deploy path", manualChecks: ["open the console", "restart hubd"] }),
          feature({ id: "work-wolfpack-feat0002", title: "Second" }),
        ],
      }),
    );
    expect(body).toContain(
      ["- **Risk:**", "  - Owner-merged PR flow (work-wolfpack-feat0001): touches the deploy path", "  - Second (work-wolfpack-feat0002): _not provided_", "- **Rollback:**"].join("\n"),
    );
    expect(body).toContain(
      [
        "- **Manual checks:**",
        "  - Owner-merged PR flow (work-wolfpack-feat0001):",
        "    - open the console",
        "    - restart hubd",
        "  - Second (work-wolfpack-feat0002): _not provided_",
      ].join("\n"),
    );
  });

  it("warns in the Decide header, naming them, when work items could not be read", () => {
    const warned = releaseBody(input({ unreadable: ["work-wolfpack-aaa00001", "work-wolfpack-bbb00002"] })).body;
    expect(warned).toContain("- ⚠ 2 work items could not be read: work-wolfpack-aaa00001, work-wolfpack-bbb00002; their commits are under Other commits");
    expect(warned.indexOf("⚠")).toBeLessThan(warned.indexOf("## Tests and CI"));
    expect(releaseBody(input()).body).not.toContain("⚠");
  });

  it("says 'not provided' for every other missing input instead of dropping it", () => {
    const { body } = releaseBody(input({ features: [feature(), feature({ id: "work-wolfpack-feat0002", title: "Second" })] }));
    expect(body.split("Diagram: _not provided_")).toHaveLength(3);
    expect(body.split("Screenshots: _not provided_")).toHaveLength(3);
    expect(body.split("Feature document: _not provided_")).toHaveLength(3);
    for (const line of ["- Tests: _not provided_", "- CI: _not provided_"]) expect(body).toContain(line);
    expect(body).toContain("## Other commits\nnone");
  });

  it("explains missing screenshot links instead of printing a broken one", () => {
    const { body } = releaseBody(input({ features: [feature({ screenshotsNote: "link unavailable (no GitHub remote)" })] }));
    expect(body).toContain("Screenshots: link unavailable (no GitHub remote)");
  });

  it("lists commits not tied to a feature", () => {
    const { body } = releaseBody(input({ otherCommits: ["aaa1111 fix(cli): one", "bbb2222 docs: two"] }));
    expect(body).toContain("## Other commits\n- aaa1111 fix(cli): one\n- bbb2222 docs: two");
  });
});

describe("release PR size handling: never cut, overflow into comments", () => {
  const rows = (n: number, from = 0) => Array.from({ length: n }, (_, k) => `row ${from + k}`);
  /** A document of about `kb` kilobytes made of numbered lines, so loss, duplication and reordering are visible. */
  const doc = (kb: number, prefix = "") => rows(Math.ceil((kb * 1000) / 8)).map((r) => prefix + r).join("\n");
  const f = (n: number, document?: string) => feature({ id: `work-wolfpack-feat000${n}`, title: ["", "First", "Second", "Third"][n]!, document });
  const rowsIn = (texts: string[]) => texts.flatMap((t) => t.split("\n")).filter((l) => /^row \d+$/.test(l));
  const fenceLines = (s: string) => s.split("\n").filter((l) => /^(```|~~~)/.test(l)).length;

  it("keeps everything in the body, with no comments, when it fits", () => {
    const r = releaseBody(input({ features: [f(1, "short doc")], otherCommits: ["abc1234 one"] }));
    expect(r.comments).toEqual([]);
    expect(r.body).not.toContain("Continued in comments");
    expect(r.body).toContain("short doc");
  });

  it("posts a section that does not fit whole as one comment, and ends the body with the list of what continues", () => {
    const first = doc(40);
    const second = doc(40);
    const r = releaseBody(input({ features: [f(1, first), f(2, second)], otherCommits: ["abc1234 one"] }));
    expect(bytes(r.body)).toBeLessThanOrEqual(PR_BODY_LIMIT);
    expect(r.body).toContain("### First (work-wolfpack-feat0001)");
    expect(r.body).not.toContain("### Second");
    expect(r.body).toContain(first);
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toContain("### Second (work-wolfpack-feat0002)");
    expect(r.comments[0]).toContain(second);
    expect(r.body.indexOf("## Other commits")).toBeLessThan(r.body.indexOf("Continued in comments"));
    expect(r.body.trimEnd().endsWith("Continued in comments: Second")).toBe(true);
  });

  it("sends every section after the first overflowing one to the comments, in order, even a small one", () => {
    const r = releaseBody(input({ features: [f(1, doc(40)), f(2, doc(40)), f(3, "tiny doc")] }));
    expect(r.body).not.toContain("tiny doc");
    expect(r.body.trimEnd().endsWith("Continued in comments: Second, Third")).toBe(true);
    // Sections that fit together share a comment instead of taking one each.
    expect(r.comments).toHaveLength(1);
    const all = r.comments.join("\n");
    expect(all.indexOf("### Second")).toBeLessThan(all.indexOf("### Third"));
    expect(all).toContain("tiny doc");
  });

  it("splits one huge section across consecutive comments at line boundaries, losing and repeating nothing, and marks the parts", () => {
    const r = releaseBody(input({ features: [f(1, doc(150))] }));
    expect(r.comments).toHaveLength(3);
    r.comments.forEach((c, k) => {
      expect(bytes(c)).toBeLessThanOrEqual(PR_BODY_LIMIT);
      expect(c.startsWith(`_First (work-wolfpack-feat0001) (part ${k + 1}/3)_`)).toBe(true);
    });
    expect(rowsIn(r.comments)).toEqual(rows(Math.ceil(150_000 / 8)));
    expect(rowsIn([r.body])).toEqual([]);
    expect(r.body.trimEnd().endsWith("Continued in comments: First")).toBe(true);
  });

  it.each([
    ["```mermaid", "```"],
    ["~~~text", "~~~"],
  ])("closes an open %s fence at a split and reopens it, with the same opener, in the next comment", (opener, marker) => {
    const text = `intro\n${opener}\n${"A-->B\n".repeat(15_000)}${marker}\nafter`;
    const r = releaseBody(input({ features: [f(1, text)] }));
    expect(r.comments.length).toBeGreaterThan(1);
    for (const c of r.comments) expect(fenceLines(c) % 2).toBe(0);
    expect(r.comments[0]!.trimEnd().endsWith(`\n${marker}`)).toBe(true);
    expect(r.comments[1]!).toMatch(new RegExp(`^_.*\\(part 2/\\d+\\)_\\n\\n${opener}\\nA-->B\\n`));
    expect(r.comments.join("\n")).toContain("after");
  });

  it("splits on UTF-8 bytes and code points: a line longer than a comment is cut without breaking a character", () => {
    const line = "é😀".repeat(40_000);
    const r = releaseBody(input({ features: [f(1, line)] }));
    expect(r.comments.length).toBeGreaterThan(1);
    for (const c of r.comments) {
      expect(bytes(c)).toBeLessThanOrEqual(PR_BODY_LIMIT);
      expect(LONE_SURROGATE.test(c)).toBe(false);
    }
    expect(r.comments.map((c) => c.split("\n").slice(2).join("\n")).join("")).toContain(line);
  });

  it("closes a feature document's unclosed fence at its end, so it cannot swallow the next section", () => {
    const r = releaseBody(input({ features: [f(1, "intro\n```ts\nconst a = 1;"), f(2, "second doc")] }));
    expect(fenceLines(r.body) % 2).toBe(0);
    const first = r.body.slice(r.body.indexOf("### First"), r.body.indexOf("### Second"));
    expect(first.trimEnd().endsWith("const a = 1;\n```")).toBe(true);
  });

  it("moves the per-feature Risk and Manual checks to the first comment when the Decide header alone would not fit", () => {
    const checks = Array.from({ length: 3000 }, (_, k) => `check number ${k} with some words to fill the line`);
    const r = releaseBody(input({ features: [feature({ risk: "touches deploy", manualChecks: checks })], unreadable: ["work-wolfpack-aaa00001"] }));
    expect(bytes(r.body)).toBeLessThanOrEqual(PR_BODY_LIMIT);
    expect(r.body).toContain("- **Merging does:**");
    expect(r.body).toContain("- **Rollback:**");
    expect(r.body).toContain("- ⚠ 1 work item could not be read: work-wolfpack-aaa00001");
    expect(r.body).toContain("- Risk and manual checks for 1 feature: see the first comment");
    expect(r.body).not.toContain("check number 0 ");
    expect(r.body.trimEnd().endsWith("Continued in comments: Risk and manual checks")).toBe(true);
    expect(r.comments[0]).toContain("Owner-merged PR flow (work-wolfpack-feat0001): touches deploy");
    expect(r.comments.join("\n")).toContain("check number 2999 with some words");
    expect(r.comments.join("\n")).toContain("check number 0 with some words");
  });

  it("moves the full list of unreadable work items to the first comment when even that header would not fit", () => {
    const ids = Array.from({ length: 3500 }, (_, k) => `work-wolfpack-dwn${String(k).padStart(5, "0")}`);
    const r = releaseBody(input({ unreadable: ids }));
    expect(bytes(r.body)).toBeLessThanOrEqual(PR_BODY_LIMIT);
    expect(r.body).toContain("- ⚠ 3500 work items could not be read; IDs in the first comment");
    expect(r.body).not.toContain("work-wolfpack-dwn00000");
    expect(r.body).toContain("- **Merging does:**");
    expect(r.body).toContain("- **Rollback:**");
    expect(r.body).toContain("see the first comment");
    expect(r.body.trimEnd()).toMatch(/Continued in comments: .*\n?$/m);
    // The list starts in the first comment; one this long (84 KB) continues in the next ones, and none is lost.
    expect(r.comments[0]).toContain(ids[0]!);
    const all = r.comments.join("\n");
    for (const id of ids) expect(all).toContain(id);
    r.comments.forEach((c, k) => expect(bytes(`<!-- wolfpack-release-part:${k + 1} -->\n${c}`)).toBeLessThanOrEqual(PR_BODY_LIMIT));
  });

  it("keeps the ids in the header while they fit", () => {
    const r = releaseBody(input({ unreadable: ["work-wolfpack-aaa00001"] }));
    expect(r.body).toContain("could not be read: work-wolfpack-aaa00001; their commits are under Other commits");
    expect(r.body).not.toContain("IDs in the first comment");
  });

  it("keeps every final text, once the part marker is added, within the limit", () => {
    const checks = Array.from({ length: 3000 }, (_, k) => `check number ${k} with some words to fill the line`);
    const r = releaseBody(input({ features: [feature({ manualChecks: checks, document: doc(150) }), f(2, doc(150))], otherCommits: ["abc1234 one"] }));
    expect(r.comments.length).toBeGreaterThan(3);
    r.comments.forEach((c, k) => expect(bytes(`<!-- wolfpack-release-part:${k + 1} -->\n${c}`)).toBeLessThanOrEqual(PR_BODY_LIMIT));
    expect(bytes(r.body)).toBeLessThanOrEqual(PR_BODY_LIMIT);
  });

  it("moves Other commits to a comment, whole, when the body has no room for them", () => {
    const commits = Array.from({ length: 400 }, (_, k) => `abc${String(k).padStart(4, "0")} chore: change number ${k} in the repository`);
    const r = releaseBody(input({ features: [f(1, doc(50))], otherCommits: commits }));
    expect(bytes(r.body)).toBeLessThanOrEqual(PR_BODY_LIMIT);
    expect(r.body).not.toContain("## Other commits");
    expect(r.body.trimEnd().endsWith("Continued in comments: Other commits")).toBe(true);
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toContain("## Other commits\n- " + commits[0]);
    expect(r.comments[0]).toContain("- " + commits[399]);
    expect(r.comments[0]).not.toContain("and 200 more");
  });
});

describe("feature document parsing", () => {
  it("takes the diagram from the first line-anchored mermaid block and leaves the rest as the document", () => {
    const md = "Use a fence like ```mermaid inline, not at a line start.\n```mermaid\ngraph TD; A-->B\n```\nrest\n```mermaid\ngraph TD; C-->D\n```\n";
    const r = parseFeatureDoc(md);
    expect(r.diagram).toBe("graph TD; A-->B");
    expect(r.document).toContain("Use a fence like ```mermaid");
    expect(r.document).toContain("graph TD; C-->D");
    expect(r.document).not.toContain("A-->B");
  });

  it("tolerates CRLF line endings", () => {
    const r = parseFeatureDoc("```mermaid\r\ngraph TD; A-->B\r\n```\r\n\r\n## Release notes\r\nRisk: low\r\nManual checks:\r\n- one\r\n- two\r\n");
    expect(r.diagram).toBe("graph TD; A-->B");
    expect(r.risk).toBe("low");
    expect(r.manualChecks).toEqual(["one", "two"]);
  });

  it("ignores a Release notes heading or a mermaid opener that sits inside another fence", () => {
    const md = "~~~md\n```mermaid\nnot a diagram\n```\n## Release notes\nRisk: inside the fence\n~~~\n\n## Release notes\nRisk: the real one\n";
    const r = parseFeatureDoc(md);
    expect(r.diagram).toBeUndefined();
    expect(r.risk).toBe("the real one");
    expect(r.document).toContain("not a diagram");
  });

  it("treats an empty mermaid block as no diagram without running on to a later fence", () => {
    const r = parseFeatureDoc("```mermaid\n```\ntext\n```ts\nconst a = 1;\n```\n");
    expect(r.diagram).toBeUndefined();
    expect(r.document).toBe("text\n```ts\nconst a = 1;\n```");
  });

  it("reads Risk and Manual checks from the Release notes section only, and returns nothing without one", () => {
    const md = "## Plan\nRisk: not this one\n\n## Release notes\nRisk: touches deploy\nManual checks:\n- open the console\n* restart hubd\n\n## Later\n- not a check\n";
    const r = parseFeatureDoc(md);
    expect(r.risk).toBe("touches deploy");
    expect(r.manualChecks).toEqual(["open the console", "restart hubd"]);
    expect(parseFeatureDoc("## Plan\nRisk: no section here\n")).toMatchObject({ risk: undefined, manualChecks: undefined });
    expect(parseFeatureDoc(null).document).toBeUndefined();
  });
});
