import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCrawlCore } from "./crawl-core.js";
import { APPROVE, EDIT, parseScope, runCrawlInterview, withPause, type Ask } from "./crawl-tui.js";

function source(): string {
  const src = mkdtempSync(join(tmpdir(), "crawl-tui-src-"));
  mkdirSync(join(src, "docs"), { recursive: true });
  mkdirSync(join(src, "notes"), { recursive: true });
  writeFileSync(join(src, "docs", "a.md"), "# A\nalpha\n");
  writeFileSync(join(src, "notes", "c.md"), "# C\ngamma\n");
  return src;
}

/** A scripted wizard: answers by the title it is asked, recording every prompt. */
function harness(answers: Record<string, string | null>) {
  const asked: { title: string; context?: string }[] = [];
  const notes: { m: string; level: string }[] = [];
  const ask: Ask = async (_ctx, title, context) => {
    asked.push({ title, context });
    const key = Object.keys(answers).find((k) => title.includes(k));
    if (key === undefined) throw new Error(`unexpected prompt: ${title}`);
    return answers[key];
  };
  const home = mkdtempSync(join(tmpdir(), "crawl-tui-home-"));
  const core = createCrawlCore({ crawlHome: join(home, "crawls"), defaultDomain: "wolfpack", declaredDomains: () => null });
  const ctx = { ui: { notify: (m: string, level: string) => notes.push({ m, level }) } };
  const run = (args: string[]) => runCrawlInterview({ ctx, args, cwd: "/cwd", domains: null, defaultDomain: "wolfpack", core, ask });
  return { asked, notes, run, core };
}

describe("parseScope", () => {
  it("reads include and exclude globs; the whole-tree choice and junk are no scope", () => {
    expect(parseScope("include: **/*.md; *.txt; exclude: notes/**")).toEqual({ include: ["**/*.md", "*.txt"], exclude: ["notes/**"] });
    // commas belong to the glob (brace sets), only `;` separates
    expect(parseScope("include: **/*.{md,txt}")).toEqual({ include: ["**/*.{md,txt}"] });
    expect(parseScope("exclude: a/**; {b,c}/**")).toEqual({ exclude: ["a/**", "{b,c}/**"] });
    expect(parseScope("")).toEqual({});
    expect(parseScope(null)).toEqual({});
    expect(parseScope("everything please")).toEqual({});
  });
});

describe("pi /wolf:crawl interview", () => {
  it("scope reaches the plan; preview shows the batches; approving finalizes", async () => {
    const src = source();
    const t = harness({ Scope: "include: **/*.md; exclude: notes/**", "look good": APPROVE });
    const r = await t.run([src, "wolfpack", "by-folder", "1"]);
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    const yaml = readFileSync(r.planPath, "utf8");
    expect(yaml).toContain("status: ready");
    expect(yaml).toContain("notes/**");
    expect(yaml).toContain("**/*.md");
    expect(yaml).not.toContain("notes:\n"); // the excluded folder made no batch
    // the approval prompt carried the batch summary
    const approval = t.asked.find((a) => a.title.includes("look good"))!;
    expect(approval.context).toContain("docs");
    expect(t.notes.at(-1)!.m).toContain("status: ready");
  });

  it("asks only for what the command line left out", async () => {
    const src = source();
    const t = harness({ domain: "wolfpack", strategy: "by-pattern", Scope: "", "look good": EDIT });
    const r = await t.run([src]);
    expect(t.asked.map((a) => a.title.replace("🐺 ", ""))).toEqual(["Target KB domain", "Grouping strategy", "Scope", "Does this plan look good?"]);
    expect(r.status).toBe("drafted");
  });

  it("declining the confirm leaves a draft, not a ready plan", async () => {
    const src = source();
    const t = harness({ Scope: "", "look good": EDIT });
    const r = await t.run([src, "wolfpack", "by-folder", "1"]);
    expect(r.status).toBe("drafted");
    if (r.status !== "drafted") return;
    expect(readFileSync(r.planPath, "utf8")).toContain("status: draft");
    expect(t.notes.at(-1)!.m).toContain("left as a draft");
  });

  it("escaping the confirm also keeps the draft", async () => {
    const t = harness({ Scope: "", "look good": null });
    expect((await t.run([source(), "wolfpack", "by-folder", "1"])).status).toBe("drafted");
  });

  it("a bad source path fails cleanly before any further question", async () => {
    const t = harness({});
    const r = await t.run(["/no/such/dir"]);
    expect(r).toEqual({ status: "bad-path", path: "/no/such/dir" });
    expect(t.asked).toEqual([]);
    expect(t.notes[0]).toMatchObject({ level: "error" });
    expect(t.notes[0].m).toContain("/no/such/dir");
  });

  it("a typed path that does not exist is refused the same way", async () => {
    const t = harness({ "Which directory": "/typed/nowhere" });
    expect((await t.run([])).status).toBe("bad-path");
  });

  it("a typed depth that is not a number is reported, not silently dropped", async () => {
    const t = harness({ Scope: "", "look good": EDIT, "Folder depth": "deep" });
    const r = await t.run([source(), "wolfpack", "by-folder"]);
    expect(r.status).toBe("drafted");
    expect(t.notes.some((n) => n.level === "warning" && n.m.includes('"deep"'))).toBe(true);
  });

  it("a wizard that throws still releases the observation pause, and the error propagates", async () => {
    const t = harness({});
    const released: boolean[] = [];
    const boom = withPause(
      () => runCrawlInterview({ ctx: { ui: { notify() {} } }, args: [source(), "wolfpack", "by-folder", "1"], cwd: "/cwd", domains: null, defaultDomain: "wolfpack", core: t.core, ask: async () => { throw new Error("tui died"); } }),
      (keep) => released.push(keep),
    );
    await expect(boom).rejects.toThrow("tui died");
    expect(released).toEqual([false]);
  });

  it("the pause is kept only for a drafted result", async () => {
    const keeps = async (answers: Record<string, string | null>, args: string[]) => {
      const t = harness(answers);
      const released: boolean[] = [];
      await withPause(() => t.run(args), (k) => released.push(k));
      return released;
    };
    const full = [source(), "wolfpack", "by-folder", "1"];
    expect(await keeps({ Scope: "", "look good": EDIT }, full)).toEqual([true]); // drafted
    expect(await keeps({ Scope: "", "look good": APPROVE }, [source(), "wolfpack", "by-folder", "1"])).toEqual([false]); // ready
    expect(await keeps({}, ["/no/such/dir"])).toEqual([false]); // bad path
    expect(await keeps({ "Target KB domain": null }, [source()])).toEqual([false]); // cancelled
  });

  it("Esc at any question cancels without writing a plan", async () => {
    const t = harness({ "Target KB domain": null });
    expect(await t.run([source()])).toEqual({ status: "cancelled" });
  });
});
