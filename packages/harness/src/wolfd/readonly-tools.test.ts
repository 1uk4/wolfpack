/**
 * ls / grep / find / guarded_bash on a real wolf (startTestWolf, scripted model): a scout spawned into a temp dir uses
 * them, guarded_bash refuses a write, no read-only profile reports a missing tool, and home does not get them by default.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";
import { globToRegExp } from "../engine/readonly-tools.js";

let tw: TestWolf | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const toolMsg = (name: string, args: Record<string, string | boolean | number>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const textOf = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : (m.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join(""));

describe("read-only tools on wolfd", () => {
  it("a scout in a temp dir greps, lists, finds, and guarded_bash refuses a write", async () => {
    const work = mkdtempSync(join(tmpdir(), "ro-work-"));
    dirs.push(work);
    mkdirSync(join(work, "src"));
    writeFileSync(join(work, "src", "a.ts"), "export const needle = 1;\nconst other = 2;\n");
    writeFileSync(join(work, "notes.md"), "no match here\n");
    const results: Array<{ tool: string; text: string; isError: boolean }> = [];
    const homeRequests: string[] = [];
    let nextChild = 0;
    const childPlan: Array<[string, Record<string, string>]> = [
      ["grep", { pattern: "needle" }],
      ["ls", {}],
      ["find", { pattern: "*.ts" }],
      ["guarded_bash", { command: "ls -a && cat src/a.ts" }],
      ["guarded_bash", { command: "echo hi > written.txt" }],
    ];
    const step: FauxResponseStep = async (ctx) => {
      const sys = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
      const last = ctx.messages[ctx.messages.length - 1];
      if (!sys.includes("You are the sub-agent")) {
        homeRequests.push(JSON.stringify(ctx));
        if (last.role === "toolResult") return fauxAssistantMessage("spawned");
        if (textOf(last).startsWith("spawn")) return toolMsg("subagent", { agent: "scout", task: "look around", cwd: work });
        return fauxAssistantMessage("parent idle");
      }
      if (last.role === "toolResult") results.push({ tool: last.toolName, text: textOf(last), isError: last.isError });
      const next = childPlan[nextChild++];
      return next ? toolMsg(next[0], next[1]) : fauxAssistantMessage("DONE");
    };
    tw = await startTestWolf({ script: Array.from({ length: 40 }, () => step) });
    mkdirSync(join(tw.root, "agent", "agents"), { recursive: true });
    writeFileSync(
      join(tw.root, "agent", "agents", "scout.md"),
      "---\nname: scout\ndescription: reads\nmodel: fast\ntools: read, grep, find, ls, guarded_bash\n---\n\nYou are a scout.\n",
    );
    await tw.client.submit(tw.home, "spawn", { whenBusy: "reject" });
    const { vi } = await import("vitest");
    await vi.waitFor(() => expect(results).toHaveLength(5), { timeout: 10000 });

    const by = (i: number) => results[i];
    expect(by(0)).toMatchObject({ tool: "grep", isError: false });
    expect(by(0).text).toContain("src/a.ts:1: export const needle = 1;");
    expect(by(0).text).not.toContain("notes.md");
    expect(by(1).text.split("\n").sort()).toEqual(["notes.md", "src/"]);
    expect(by(2).text).toBe("src/a.ts");
    expect(by(3)).toMatchObject({ tool: "guarded_bash", isError: false });
    expect(by(3).text).toContain("needle");
    expect(by(4).isError).toBe(true);
    expect(by(4).text).toMatch(/block|read-only|redirect/i);
    expect(existsSync(join(work, "written.txt"))).toBe(false);

    // the spawn reported nothing missing; home was not offered the read-only tools
    const [child] = await tw.client.listChildren!(tw.home);
    const msgs = (await tw.client.getThread(tw.home)).messages.map((m) => m.text).join("\n");
    expect(msgs).not.toMatch(/has no .* tool/);
    expect(child.agent).toBe("scout");
    expect(homeRequests.length).toBeGreaterThan(0);
    for (const r of homeRequests) {
      expect(r).toContain("subagent_stop"); // the request does carry tool declarations
      for (const t of ["ls", "grep", "find", "guarded_bash"]) expect(r).not.toContain(`"name":"${t}"`);
    }
  });

  it.each(["scout", "planner", "reviewer", "researcher", "investigator"])("spawning %s reports no missing tools", async (agent) => {
    let spawned = false;
    const seen: string[] = [];
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
    const { vi } = await import("vitest");
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 10000 });
    expect(seen[0]).not.toMatch(/Notice: this runtime has no/);
    expect(seen[0]).not.toMatch(/is not available|unknown agent/i);
  });
});

describe("globToRegExp", () => {
  it("handles *, ** and ?", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globToRegExp("a?.md").test("ab.md")).toBe(true);
  });
});
