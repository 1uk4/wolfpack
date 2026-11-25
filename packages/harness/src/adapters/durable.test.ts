import { describe, expect, it } from "vitest";
import { UNBOUND_CONTEXT } from "@wolfpack/memory";
import { section } from "../extension-api.js";
import { excludeFromFreeze, forgetContext, pendingContextNotice } from "../context-notice.js";
import { adaptToDurable, toDurableResult } from "./durable.js";

describe("toDurableResult", () => {
  it("puts tool text on pi-durable's output channel", () => {
    expect(toDurableResult({ content: [{ type: "text", text: "done" }] })).toEqual({
      output: [{ type: "text", text: "done" }],
    });
  });

  it("keeps the error text and flag", () => {
    expect(toDurableResult({ content: [{ type: "text", text: "Consolidation failed: 400" }], isError: true })).toEqual({
      output: [{ type: "text", text: "Consolidation failed: 400" }],
      isError: true,
    });
  });

  it("never returns an empty error (the API rejects it and wedges the conversation)", () => {
    for (const content of [[], [{ type: "text" as const, text: "  " }]]) {
      const r = toDurableResult({ content, isError: true });
      expect(r.isError).toBe(true);
      expect(r.output.length).toBe(1);
      expect(r.output[0]!.text.trim()).not.toBe("");
    }
  });
});

describe("frozen sections", () => {
  const ctx = { abortSignal: undefined } as never;
  type Render = { render(input: unknown, ctx: unknown): Promise<string | undefined> };
  const tagged = (name: string, text: string) => `<${name}>\n${text}\n</${name}>`;
  /** Frozen kb_access and active_task over a mutable text, plus a live section. Conversation ids are unique per test. */
  const setup = (text: { kb: string; task: string }, den = "/den") => {
    const ext = adaptToDurable(
      { name: "t", sections: [section("kb_access", () => text.kb, { frozen: true }), section("active_task", () => text.task, { frozen: true }), section("live", () => text.kb)] } as never,
      { wolfDen: den, wolfName: "w" },
    );
    const [kb, task, live] = ext.sections as unknown as Render[];
    return { kb: kb!, task: task!, live: live!, den };
  };
  const bound = (id: string, title: string) => `## Active Task\n\n**Feature:** [${id}] ${title} (kind: feature)\n\nCall task_query {current: true} for the plan, notes and current stage.`;
  // The real strings of extensions/wolfpack-memory/unified-tasks.ts: the unbound text, and the catch-branch error text.
  const UNBOUND = `## Active Task\n\n${UNBOUND_CONTEXT}\nUse \`task_query\` to see available work.`;
  const ERROR = "## Active Task\n\nError: ENOENT: no such file or directory";

  it("keeps the shown text byte-identical across requests, announces a KB change once, and ignores count drift", async () => {
    const text = { kb: "- wolfpack (1 entries):\n  - Hub (1)", task: UNBOUND };
    const { kb, live, den } = setup(text);
    // pi-durable wraps what render returns as `<key>\n...\n</key>` and hands the transcript's text back as input.shown[key]
    // (pi-durable 1.4 harness/prompt.js renderSections, harness/generation.js). renderSections is not exported from the
    // package, so there is no seam to drive the real assembly: the wrapping is mirrored here.
    const first = await kb.render({ conversationId: "7", shown: {} }, ctx);
    const system1 = tagged("kb_access", first!);
    expect((await pendingContextNotice(den, "7")).text).toBe("");

    text.kb = "- wolfpack (9 entries):\n  - Hub (1)\n  - Sync (1)"; // a section appeared; counts drifted too
    const shown = { kb_access: system1 };
    const second = await kb.render({ conversationId: "7", shown }, ctx);
    expect(tagged("kb_access", second!)).toBe(system1);
    expect(await live.render({ conversationId: "7", shown }, ctx)).toBe(text.kb);

    const notice = await pendingContextNotice(den, "7");
    expect(notice.text).toBe("Context update: kb_access changed (+1: Sync ()); re-read the domain _digest.json");
    notice.commit();
    expect((await pendingContextNotice(den, "7")).text).toBe("");
    text.kb = "- wolfpack (12 entries):\n  - Hub (1)\n  - Sync (1)";
    await kb.render({ conversationId: "7", shown }, ctx);
    expect((await pendingContextNotice(den, "7")).text).toBe("");
  });

  it("sees a bind or unbind that happened between turns with no render in between", async () => {
    const text = { kb: "- a (1)", task: UNBOUND };
    const { task, den } = setup(text);
    await task.render({ conversationId: "20", shown: {} }, ctx);
    text.task = bound("work-wolfpack-AbC1234", "Fix the thing (now)");
    const bind = await pendingContextNotice(den, "20");
    expect(bind.text).toBe('Context update: active_task changed (now work-wolfpack-AbC1234 "Fix the thing (now)"); call task_query {current: true}');
    bind.commit();
    text.task = UNBOUND;
    expect((await pendingContextNotice(den, "20")).text).toBe("Context update: active_task changed (now unbound); call task_query {current: true}");
  });

  it("ignores a failed active_task render: no unbind announced, the last state is kept (also after a restart)", async () => {
    const text = { kb: "", task: bound("work-wolfpack-AbC1234", "T") };
    const { task, den } = setup(text);
    const first = await task.render({ conversationId: "22", shown: {} }, ctx);
    const shown = { active_task: tagged("active_task", first!) };
    text.task = ERROR;
    expect(await task.render({ conversationId: "22", shown }, ctx)).toBe(first); // still frozen
    expect((await pendingContextNotice(den, "22")).text).toBe("");
    text.task = UNBOUND; // a real unbind after the error is still announced
    expect((await pendingContextNotice(den, "22")).text).toBe("Context update: active_task changed (now unbound); call task_query {current: true}");

    // Restart: the transcript shows an Error text; the fresh text is shown, and nothing is announced.
    text.task = bound("work-wolfpack-ZzZ9999", "Back");
    expect(await task.render({ conversationId: "23", shown: { active_task: tagged("active_task", ERROR) } }, ctx)).toBe(text.task);
    expect((await pendingContextNotice(den, "23")).text).toBe("");
  });

  it("announces a rebind to another item and keeps showing the first", async () => {
    const text = { kb: "", task: bound("work-wolfpack-AAA1111", "One") };
    const { task, den } = setup(text);
    const first = await task.render({ conversationId: "21", shown: {} }, ctx);
    text.task = bound("work-snapjack-BBB2222", "Two");
    expect(await task.render({ conversationId: "21", shown: { active_task: tagged("active_task", first!) } }, ctx)).toBe(first);
    expect((await pendingContextNotice(den, "21")).text).toBe('Context update: active_task changed (now work-snapjack-BBB2222 "Two"); call task_query {current: true}');
  });

  it("shows the fresh text after a compaction (no shown entry) and announces nothing", async () => {
    const text = { kb: "- a (1)", task: UNBOUND };
    const { kb, den } = setup(text);
    await kb.render({ conversationId: "30", shown: {} }, ctx);
    text.kb = "- a (1)\n- b (1)";
    expect(await kb.render({ conversationId: "30", shown: {} }, ctx)).toBe("- a (1)\n- b (1)");
    expect((await pendingContextNotice(den, "30")).text).toBe("");
  });

  it("after a restart (no memory) keeps the shown text and announces the difference once", async () => {
    const text = { kb: "- a (1)\n- b (1)", task: UNBOUND };
    const { kb, den } = setup(text);
    const shown = { kb_access: tagged("kb_access", "- a (1)") };
    expect(await kb.render({ conversationId: "40", shown }, ctx)).toBe("- a (1)");
    const n = await pendingContextNotice(den, "40");
    expect(n.text).toBe("Context update: kb_access changed (+1: b ()); re-read the domain _digest.json");
    n.commit();
    expect((await pendingContextNotice(den, "40")).text).toBe("");
  });

  it("replaces the active_task loading placeholder with the fresh text and does not announce it afterwards", async () => {
    const text = { kb: "", task: bound("work-wolfpack-AbC1234", "T") };
    const { task, den } = setup(text);
    const shown = { active_task: tagged("active_task", "## Active Task\n\nBound to work-wolfpack-AbC1234 (loading...). Use `task_query` to refresh.") };
    expect(await task.render({ conversationId: "50", shown }, ctx)).toBe(text.task);
    expect((await pendingContextNotice(den, "50")).text).toBe("");
  });

  it("does not freeze a subagent child, and forgetting a conversation drops its state", async () => {
    const text = { kb: "- a (1)", task: UNBOUND };
    const { kb, den } = setup(text);
    excludeFromFreeze(den, "60");
    text.kb = "- a (1)\n- b (1)";
    expect(await kb.render({ conversationId: "60", shown: { kb_access: tagged("kb_access", "- a (1)") } }, ctx)).toBe(text.kb);
    expect((await pendingContextNotice(den, "60")).text).toBe("");

    await kb.render({ conversationId: "61", shown: { kb_access: tagged("kb_access", "- a (1)") } }, ctx);
    expect((await pendingContextNotice(den, "61")).text).not.toBe("");
    forgetContext(den, "61");
    expect((await pendingContextNotice(den, "61")).text).toBe("");
  });
});

describe("toDurableResult endTurn", () => {
  it("terminates the round without a card", () => {
    expect(toDurableResult({ content: [{ type: "text", text: "pending" }], endTurn: true })).toEqual({ output: [{ type: "text", text: "pending" }], control: { terminate: true } });
  });
});
