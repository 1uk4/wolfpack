/**
 * ls / grep / find / guarded_bash on a real wolf (startTestWolf, scripted model): a scout spawned into a temp dir uses
 * them, caps and notes are visible, guarded_bash refuses writes, no read-only profile reports a missing tool, and home
 * only gets the tools with `tools: [coding, readonly]`. The worker search is also driven directly for the deadline.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";
import { globToRegExp, readOnlyToolsExcluding, runSearch } from "../engine/readonly-tools.js";

let tw: TestWolf | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Args = Record<string, string | boolean | number>;
const toolMsg = (name: string, args: Args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const textOf = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : (m.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join(""));
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

interface Result {
  tool: string;
  text: string;
  isError: boolean;
}

/**
 * Boot a wolf whose scout (or, with `home: true`, the home thread itself) runs `calls` in order. Resolves with the
 * tool results once all have come back, plus every request the home thread made.
 */
async function run(calls: Array<[string, Args]>, opts: { cwd?: string; yaml?: string; home?: boolean; agent?: string } = {}) {
  const results: Result[] = [];
  const homeRequests: string[] = [];
  let next = 0;
  const step: FauxResponseStep = async (ctx) => {
    const sys = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
    const last = ctx.messages[ctx.messages.length - 1];
    const isChild = sys.includes("You are the sub-agent");
    if (!isChild) homeRequests.push(JSON.stringify(ctx));
    const mine = opts.home ? !isChild : isChild;
    if (!mine) {
      if (last.role === "toolResult") return fauxAssistantMessage("spawned");
      if (textOf(last).startsWith("spawn")) return toolMsg("subagent", { agent: opts.agent ?? "scout", task: "look around", ...(opts.cwd ? { cwd: opts.cwd } : {}) });
      return fauxAssistantMessage("idle");
    }
    if (last.role === "toolResult") results.push({ tool: last.toolName, text: textOf(last), isError: last.isError });
    const c = calls[next++];
    return c ? toolMsg(c[0], c[1]) : fauxAssistantMessage("DONE");
  };
  tw = await startTestWolf({ script: Array.from({ length: 60 }, () => step), ...(opts.yaml ? { yaml: opts.yaml } : {}) });
  mkdirSync(join(tw.root, "agent", "agents"), { recursive: true });
  writeFileSync(join(tw.root, "agent", "agents", "scout.md"), "---\nname: scout\ndescription: reads\nmodel: fast\ntools: read, grep, find, ls, guarded_bash\n---\n\nYou are a scout.\n");
  await tw.client.submit(tw.home, opts.home ? "go" : "spawn", { whenBusy: "reject" });
  await vi.waitFor(() => expect(results).toHaveLength(calls.length), { timeout: 15000 });
  return { results, homeRequests };
}

describe("read-only tools on wolfd", () => {
  it("a scout in a temp dir greps, lists, finds, and guarded_bash refuses a write", async () => {
    const work = tmp("ro-work-");
    mkdirSync(join(work, "src"));
    writeFileSync(join(work, "src", "a.ts"), "export const needle = 1;\nconst other = 2;\n");
    writeFileSync(join(work, "notes.md"), "no match here\n");
    const { results, homeRequests } = await run(
      [
        ["grep", { pattern: "needle" }],
        ["ls", {}],
        ["find", { pattern: "*.ts" }],
        ["guarded_bash", { command: "ls -a && cat src/a.ts" }],
        ["guarded_bash", { command: "echo hi > written.txt" }],
      ],
      { cwd: work },
    );
    expect(results[0]).toMatchObject({ tool: "grep", isError: false });
    expect(results[0].text).toContain("src/a.ts:1: export const needle = 1;");
    expect(results[0].text).not.toContain("notes.md");
    expect(results[1].text.split("\n").sort()).toEqual(["notes.md", "src/"]);
    expect(results[2].text).toBe("src/a.ts");
    expect(results[3]).toMatchObject({ tool: "guarded_bash", isError: false });
    expect(results[3].text).toContain("needle");
    expect(results[4].isError).toBe(true);
    expect(existsSync(join(work, "written.txt"))).toBe(false);

    const msgs = (await tw!.client.getThread(tw!.home)).messages.map((m) => m.text).join("\n");
    expect(msgs).not.toMatch(/has no .* tool/);
    // home was not offered the read-only tools, though its request does carry tool declarations
    expect(homeRequests.length).toBeGreaterThan(0);
    for (const r of homeRequests) {
      expect(r).toContain("subagent_stop");
      for (const t of ["ls", "grep", "find", "guarded_bash"]) expect(r).not.toContain(`"name":"${t}"`);
    }
  });

  it.each(["scout", "planner", "reviewer", "researcher", "investigator"])("spawning %s reports no missing tools", async (agent) => {
    const seen: string[] = [];
    let spawned = false;
    const step: FauxResponseStep = async (ctx) => {
      const sys = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
      const last = ctx.messages[ctx.messages.length - 1];
      if (sys.includes("You are the sub-agent")) return fauxAssistantMessage("child done");
      if (last.role === "toolResult") {
        seen.push(textOf(last));
        return fauxAssistantMessage("ok");
      }
      if (!spawned && textOf(last).startsWith("spawn")) {
        spawned = true;
        return toolMsg("subagent", { agent, task: "x" });
      }
      return fauxAssistantMessage("idle");
    };
    tw = await startTestWolf({ script: Array.from({ length: 20 }, () => step) });
    await tw.client.submit(tw.home, "spawn", { whenBusy: "reject" });
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 10000 });
    expect(seen[0]).not.toMatch(/Notice: this runtime has no/);
    expect(seen[0]).not.toMatch(/is not available|unknown agent/i);
  });

  it("limits: match and result caps say so, long lines are cut, binary/large/symlinked files are skipped, symlinked dirs not entered", async () => {
    const work = tmp("ro-caps-");
    const outside = tmp("ro-outside-");
    writeFileSync(join(outside, "secret.txt"), "needle in outside\n");
    writeFileSync(join(work, "many.txt"), Array.from({ length: 150 }, (_, i) => `needle ${i}`).join("\n") + "\n");
    writeFileSync(join(work, "long.txt"), `needle ${"x".repeat(900)}\n`);
    writeFileSync(join(work, "late.txt"), `${"y".repeat(2500)} needleAtEnd\n`);
    writeFileSync(join(work, "bin.dat"), Buffer.concat([Buffer.from("needle\n"), Buffer.from([0, 1, 2])]));
    writeFileSync(join(work, "big.txt"), "needle\n" + "z".repeat(1024 * 1024 + 10));
    symlinkSync(join(outside, "secret.txt"), join(work, "link.txt"));
    symlinkSync("/dev/zero", join(work, "zero"));
    symlinkSync(outside, join(work, "linkdir"));
    for (let i = 0; i < 12; i++) writeFileSync(join(work, `f${i}.log`), "");
    const { results } = await run(
      [
        ["grep", { pattern: "needle", glob: "many.txt" }],
        ["grep", { pattern: "needle", glob: "long.txt" }],
        ["grep", { pattern: "needleAtEnd" }],
        ["grep", { pattern: "needle" }],
        ["find", { pattern: "*.log", limit: 5 }],
        ["find", { pattern: "*.txt" }],
        ["grep", { pattern: "needle", path: "link.txt" }],
        ["grep", { pattern: "needle", path: "zero" }],
      ],
      { cwd: work },
    );
    const [many, long, late, all, findCap, findTxt, linkRoot, zeroRoot] = results.map((r) => r.text);
    expect(many.split("\n")).toHaveLength(101);
    expect(many).toContain("many.txt:1: needle 0");
    expect(many).toContain("[limit of 100 matches reached; narrow the pattern, path or glob]");
    expect(long).toMatch(/^long\.txt:1: needle x+…$/);
    expect(long.length).toBeLessThan(560);
    expect(late).toBe("No matches found"); // beyond the first 2000 chars of the line
    // binary, >1MB, symlinked file and symlinked dir are all skipped
    expect(all).not.toContain("bin.dat");
    expect(all).not.toContain("big.txt");
    expect(all).not.toContain("link");
    expect(all).not.toContain("outside");
    expect(findCap.split("\n")).toHaveLength(6);
    expect(findCap).toContain("[limit of 5 results reached; narrow the pattern, path or glob]");
    expect(findTxt.split("\n")).toContain("link.txt"); // find lists a symlinked file but not what is under a symlinked dir
    expect(findTxt).not.toContain("secret.txt");
    expect(linkRoot).toBe("link.txt:1: needle in outside"); // named explicitly: followed, and it is a regular file within the size cap
    expect(zeroRoot).toBe("No matches found"); // /dev/zero is not a regular file
  });

  it("a relative path resolves against the child's cwd; an invalid regex is an error", async () => {
    const work = tmp("ro-rel-");
    mkdirSync(join(work, "sub"));
    writeFileSync(join(work, "sub", "x.txt"), "hello\n");
    const { results } = await run(
      [
        ["ls", { path: "sub" }],
        ["grep", { pattern: "hello", path: "sub" }],
        ["find", { pattern: "./*.txt", path: "./sub" }],
        ["grep", { pattern: "(" }],
        ["ls", { path: "sub/x.txt" }],
      ],
      { cwd: work },
    );
    expect(results[0].text).toBe("x.txt");
    expect(results[1].text).toBe("sub/x.txt:1: hello".replace("sub/x.txt", "x.txt"));
    expect(results[2].text).toBe("x.txt");
    expect(results[3].isError).toBe(true);
    expect(results[3].text).toMatch(/Invalid pattern/);
    expect(results[4].isError).toBe(true);
    expect(results[4].text).toMatch(/Not a directory/);
  });

  it("guarded_bash refuses writes with the guard's exact message and runs nothing", async () => {
    const work = tmp("ro-gb-");
    const tail = " This agent is read-only: do not retry a variant of this command; report what you need to the orchestrator instead.";
    const attempts: Array<[string, string]> = [
      ["echo hi > f.txt", "Blocked by guarded_bash: output redirect `> f.txt` writes a file (redirects may only go to /dev/null or /tmp/). Command: echo hi."],
      ["echo hi | tee out.txt", "Blocked by guarded_bash: `tee` writes files (only /dev/null is allowed). Command: tee out.txt."],
      ["rm -f x", "Blocked by guarded_bash: `rm` deletes files. Command: rm -f x."],
      ["(echo a > g.txt)", "Blocked by guarded_bash: output redirect `> g.txt` writes a file (redirects may only go to /dev/null or /tmp/). Command: echo a."],
      ["touch $(echo h.txt)", "Blocked by guarded_bash: `touch` creates or touches files. Command: touch $SUBST."],
    ];
    const { results } = await run([...attempts.map(([command]): [string, Args] => ["guarded_bash", { command }]), ["guarded_bash", { command: "cat > i.txt <<EOF\nhi\nEOF" }]], { cwd: work });
    attempts.forEach(([, msg], i) => {
      expect(results[i].isError).toBe(true);
      expect(results[i].text).toContain(msg + tail);
    });
    expect(results[5].isError).toBe(true);
    expect(results[5].text).toContain("Blocked by guarded_bash: couldn't parse; simplify the command (here-documents are not supported).");
    for (const f of ["f.txt", "out.txt", "g.txt", "h.txt", "i.txt"]) expect(existsSync(join(work, f))).toBe(false);
  });

  it("home gets the tools only with `tools: [coding, readonly]`", async () => {
    const { results, homeRequests } = await run([["ls", {}]], { home: true, yaml: "tools: [coding, readonly]\n" });
    expect(results[0]).toMatchObject({ tool: "ls", isError: false });
    for (const t of ["ls", "grep", "find", "guarded_bash"]) expect(homeRequests[0]).toContain(`"name":"${t}"`);
  });
});

describe("runSearch", () => {
  it("returns in time with a note when a catastrophic regex hits the deadline", async () => {
    const work = tmp("ro-redos-");
    writeFileSync(join(work, "a.txt"), `${"a".repeat(40)}!\n`);
    const t0 = Date.now();
    const r = await runSearch({ mode: "grep", root: work, limit: 100, regex: { source: "^(a+)+$", flags: "" } }, { deadlineMs: 400 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.note).toBe("[search stopped after 0.4s deadline with 0 results so far; narrow the pattern, path or glob]");
  });

  it("stops at maxVisited and says so", async () => {
    const work = tmp("ro-visit-");
    for (let i = 0; i < 30; i++) writeFileSync(join(work, `f${String(i).padStart(2, "0")}.txt`), "x\n");
    const r = await runSearch({ mode: "find", root: work, limit: 1000, glob: { source: ".*", flags: "", pattern: "*" } }, { maxVisited: 10 });
    expect(r.lines).toHaveLength(10);
    expect(r.note).toBe("[search stopped after 10 entries; narrow the path or glob]");
  });
});

describe("globToRegExp", () => {
  it("handles *, ** , ? and a leading ./", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globToRegExp("a?.md").test("ab.md")).toBe(true);
    expect(globToRegExp("./src/*.ts").test("src/a.ts")).toBe(true);
  });
});

describe("name collisions", () => {
  it("does not register a tool another extension already defines, and reports it", () => {
    const seen: string[] = [];
    const ext = readOnlyToolsExcluding(new Set(["grep"]), (m) => seen.push(m));
    expect((ext?.tools ?? []).map((t) => t.name)).toEqual(["ls", "find", "guarded_bash"]);
    expect(seen).toEqual(['read-only tool "grep" not registered: another extension already defines it']);
  });
});
