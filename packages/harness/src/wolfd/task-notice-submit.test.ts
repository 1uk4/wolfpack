import { describe, expect, it, vi } from "vitest";
import type { Card } from "@wolfpack/protocol";
import { CARD_DETAILS_KEY } from "../engine/index.js";
import { EngineBusyError } from "../engine/index.js";
import { stripSupersededNotes } from "../superseded-note.js";
import { messagesFromEntries } from "./messages.js";
import { ThreadRuntime } from "./thread.js";

const NOTICE = "Task update: stage in_build → shipped; Record updated";
const card: Card = { tool: "ask_user_question", fields: [{ id: "answer", kind: "free-text", label: "Q" }] };
const toolEntry = { id: 1, kind: "pi.tool_result", model: [{ role: "toolResult", toolCallId: "c1", toolName: "ask_user_question", content: [], timestamp: 1, details: { [CARD_DETAILS_KEY]: card } }] } as never;

function rig(opts: { kind?: string; notice?: () => Promise<{ text: string; commit(): void }>; submit?: () => Promise<unknown>; deadline?: number } = {}) {
  const inputs: string[] = [];
  const conv = {
    id: "1",
    submit: vi.fn(async ({ input }: { input: string }) => {
      inputs.push(input);
      if (opts.submit) await opts.submit();
      return { messageId: "9", disposition: "queued" };
    }),
  };
  const commit = vi.fn();
  const taskNotice = vi.fn(opts.notice ?? (async () => ({ text: NOTICE, commit })));
  const host = { name: "w", den: undefined, settleMs: 1, closing: () => false, emitWolf() {}, onError() {}, taskNotice, taskNoticeDeadlineMs: opts.deadline } as never;
  const rt = new ThreadRuntime({ id: "w/home", ...(opts.kind ? { kind: opts.kind } : {}) } as never, conv as never, host);
  return { rt, inputs, commit, taskNotice, conv };
}

describe("ThreadRuntime.submit task notice", () => {
  it("prepends the notice and commits after the engine accepted the message", async () => {
    const { rt, inputs, commit } = rig();
    await rt.submit("hello", "steer");
    expect(inputs).toEqual([`${NOTICE}\n\nhello`]);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("leaves it uncommitted when the engine is busy or fails", async () => {
    for (const err of [new EngineBusyError(), new Error("boom")]) {
      const { rt, commit } = rig({ submit: async () => { throw err; } });
      await expect(rt.submit("hello", "reject")).rejects.toBeDefined();
      expect(commit).not.toHaveBeenCalled();
    }
  });

  it("a throwing or slow taskNotice still submits the plain text", async () => {
    const a = rig({ notice: async () => { throw new Error("api down"); } });
    await a.rt.submit("hello", "steer");
    expect(a.inputs).toEqual(["hello"]);
    const b = rig({ notice: () => new Promise(() => {}), deadline: 20 });
    await b.rt.submit("hello", "steer");
    expect(b.inputs).toEqual(["hello"]);
  });

  it("no notice while running, for child threads, or for internal submits", async () => {
    const running = rig();
    (running.rt as never as { running: unknown }).running = { turnId: "t" };
    await running.rt.submit("hello", "steer");
    expect(running.inputs).toEqual(["hello"]);
    expect(running.taskNotice).not.toHaveBeenCalled();
    const child = rig({ kind: "subagent" });
    await child.rt.submit("hello", "steer");
    expect(child.inputs).toEqual(["hello"]);
    const internal = rig();
    await internal.rt.submit("result", "steer", [], { internal: true });
    expect(internal.inputs).toEqual(["result"]);
    expect(internal.taskNotice).not.toHaveBeenCalled();
    expect(internal.commit).not.toHaveBeenCalled();
  });

  it("a turn that starts while the notice is read drops the notice", async () => {
    const r = rig();
    r.taskNotice.mockImplementation(async () => {
      (r.rt as never as { running: unknown }).running = { turnId: "t" };
      return { text: NOTICE, commit: r.commit };
    });
    await r.rt.submit("hello", "steer");
    expect(r.inputs).toEqual(["hello"]);
    expect(r.commit).not.toHaveBeenCalled();
  });

  it("pending card + notice: history and the observer see only the operator's text", async () => {
    const { rt, inputs } = rig();
    rt.cards.reset([toolEntry]);
    await rt.submit("hello", "steer");
    const sent = inputs[0];
    expect(sent).toBe(`(Your pending ask_user_question question (call c1) was superseded by this message.)\n\n${NOTICE}\n\nhello`);
    const call = { id: 0, kind: "pi.assistant", model: [{ role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "c1", name: "ask_user_question", arguments: { question: "Q" } }] }] } as never;
    const history = messagesFromEntries([call, toolEntry, { id: 2, kind: "pi.user", model: [{ role: "user", content: sent }] } as never]);
    expect(history.find((m) => m.role === "user")!.text).toBe("hello");
    expect(stripSupersededNotes(sent)).toBe("hello");
  });
});
