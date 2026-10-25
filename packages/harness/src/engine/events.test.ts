/** Synthetic edge cases the recordings don't cover. Shapes follow the captured engine events. */
import { describe, expect, it } from "vitest";
import { createEventMapper, type EngineEvent, type EngineSnapshot } from "./events.js";

const ev = (e: unknown) => e as EngineEvent;
const start = (id = 1) => ev({ type: "run_start", inputs: [id] });
const end = (id = 1) => ev({ type: "run_end", inputs: [id] });
const sub = (id: number, status: string, reason?: string) => ev({ type: "submission", record: { type: "input", id, conversationId: 1, status, reason } });
const asstStart = (content: unknown[]) => ev({ type: "message_start", message: { role: "assistant", content } });
const delta = (d: string, kind = "text_delta") => ev({ type: "message_update", changes: [{ type: kind, contentIndex: 0, delta: d }] });
const asstEnd = (content: unknown[], extra: object = {}) =>
  ev({ type: "message_end", entry: { kind: "pi.assistant", id: 5, conversationId: 1, model: [{ role: "assistant", content, stopReason: "stop", ...extra }] } });

const map = (...events: EngineEvent[]) => {
  const m = createEventMapper();
  return [...m.push(events), ...m.flush()];
};

describe("text reconciliation", () => {
  it("emits nothing from message_start when it carries no text", () => {
    const out = map(start(), asstStart([]), delta("hi"), asstEnd([{ type: "text", text: "hi" }]), end(), sub(1, "done"));
    expect(out.filter((e) => e.type === "text-delta")).toHaveLength(1);
  });

  it("emits only the unstreamed tail at message_end", () => {
    const out = map(start(), asstStart([{ type: "text", text: "Hel" }]), delta("lo, wo"), asstEnd([{ type: "text", text: "Hello, world" }]), end(), sub(1, "done"));
    expect(out.filter((e) => e.type === "text-delta").map((e: any) => e.text)).toEqual(["Hel", "lo, wo", "rld"]);
  });

  it("does not repeat text when the stream already complete", () => {
    const out = map(start(), asstStart([]), delta("abc"), asstEnd([{ type: "text", text: "abc" }]), end(), sub(1, "done"));
    expect(out.filter((e) => e.type === "text-delta")).toHaveLength(1);
  });

  it("resets per assistant message (second round starts fresh)", () => {
    const out = map(
      start(), asstStart([{ type: "text", text: "one" }]), asstEnd([{ type: "text", text: "one" }]),
      asstStart([{ type: "text", text: "two" }]), asstEnd([{ type: "text", text: "two" }]), end(), sub(1, "done"),
    );
    expect(out.filter((e) => e.type === "text-delta").map((e: any) => e.text)).toEqual(["one", "two"]);
  });

  it("maps thinking deltas and reconciles thinking tail", () => {
    const out = map(
      start(), asstStart([{ type: "thinking", thinking: "hm" }]), delta("m, ", "thinking_delta"),
      asstEnd([{ type: "thinking", thinking: "hmm, ok" }, { type: "text", text: "x" }]), end(), sub(1, "done"),
    );
    expect(out.filter((e) => e.type === "thinking-delta").map((e: any) => e.text)).toEqual(["hm", "m, ", "ok"]);
  });

  it("ignores user/system/tool-result messages", () => {
    const out = map(start(), ev({ type: "message_start", message: { role: "user", content: "hi" } }), ev({ type: "message_start", message: { role: "toolResult", content: [{ type: "text", text: "x" }] } }), end(), sub(1, "done"));
    expect(out.map((e) => e.type)).toEqual(["turn-start", "turn-end"]);
  });
});

describe("turn-end reason", () => {
  it("waits for the submission; reason from its status", () => {
    const m = createEventMapper();
    expect(m.push([start(), end()]).map((e) => e.type)).toEqual(["turn-start"]);
    expect(m.push([sub(1, "unanswered", "aborted")])).toEqual([{ type: "turn-end", turnId: "turn-1", reason: "aborted" }]);
  });
  it("unanswered for another reason is an error", () => {
    expect(map(start(), end(), sub(1, "unanswered", "boom")).at(-1)).toMatchObject({ reason: "error" });
  });
  it("a steered input's submission after the turn closed is ignored", () => {
    const out = map(start(1), ev({ type: "run_end", inputs: [1, 2] }), sub(1, "done"), sub(2, "done"));
    expect(out.filter((e) => e.type === "turn-end")).toHaveLength(1);
  });
  it("falls back to the message stopReason when the stream ends before the submission", () => {
    const out = map(start(), asstStart([]), asstEnd([{ type: "text", text: "p" }], { stopReason: "aborted" }), end());
    expect(out.at(-1)).toMatchObject({ type: "turn-end", reason: "aborted" });
  });
  it("model error emits an error event, then turn-end error", () => {
    const out = map(start(), asstStart([]), asstEnd([], { stopReason: "error", errorMessage: "overloaded" }), end(), sub(1, "done"));
    expect(out.map((e) => e.type)).toEqual(["turn-start", "error", "turn-end"]);
    expect(out[1]).toMatchObject({ message: "overloaded" });
  });
});

describe("tools", () => {
  const tstart = (id: string, extra = {}) => ev({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { c: 1 }, ...extra });
  const tupd = (id: string, output: unknown, extra = {}) => ev({ type: "tool_execution_update", toolCallId: id, toolName: "bash", output, ...extra });
  const tend = (id: string, entry?: unknown, extra = {}) => ev({ type: "tool_execution_end", toolCallId: id, toolName: "bash", entry, ...extra });

  it("applies trimStart + append to the accumulated output", () => {
    const out = map(start(), tstart("c"), tupd("c", { set: "abcdef" }), tupd("c", { trimStart: 3, append: "XY" }));
    expect(out.filter((e) => e.type === "tool-update").map((e: any) => e.output)).toEqual(["abcdef", "defXY"]);
  });
  it("a faulted tool (no result entry) ends as an error with its partial output", () => {
    const out = map(start(), tstart("c"), tupd("c", { set: "half" }), tend("c"));
    expect(out.at(-1)).toMatchObject({ type: "tool-end", callId: "c", result: "half", isError: true });
  });
  it("surfaces isError from the result entry", () => {
    const entry = { kind: "pi.tool-result", model: [{ role: "toolResult", isError: true, content: [{ type: "text", text: "nope" }] }] };
    expect(map(start(), tstart("c"), tend("c", entry)).at(-1)).toMatchObject({ result: "nope", isError: true });
  });
  it("does not surface nested tool calls", () => {
    const out = map(start(), tstart("p/1", { parentToolCallId: "p" }), tupd("p/1", { set: "x" }, { parentToolCallId: "p" }), tend("p/1", undefined, { parentToolCallId: "p" }));
    expect(out.map((e) => e.type)).toEqual(["turn-start"]);
  });
});

describe("snapshots", () => {
  const snap = (extra: object = {}): EngineSnapshot =>
    ({ type: "snapshot", entries: [], tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} }, ...extra }) as EngineSnapshot;

  it("a mid-stream engine snapshot becomes a resync and reseeds turn state", () => {
    const m = createEventMapper();
    const out = m.push([ev(snap({ run: { inputs: [9] }, generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "so far" }] } } })), delta(" more"), asstEnd([{ type: "text", text: "so far more!" }])]);
    expect(out.map((e) => e.type)).toEqual(["resync", "text-delta", "text-delta"]);
    expect(out.slice(1).map((e: any) => [e.turnId, e.text])).toEqual([["turn-9", " more"], ["turn-9", "!"]]);
  });

  it("seeding from an attach snapshot joins a run in progress without a turn-start", () => {
    const m = createEventMapper(snap({ run: { inputs: [3] }, tools: [{ callId: "c", name: "bash", status: "running", output: "ab" }] }));
    const out = m.push([tupd("c"), end(3), sub(3, "done")]);
    expect(out.map((e) => e.type)).toEqual(["tool-update", "turn-end"]);
    expect(out[0]).toMatchObject({ output: "abcd", turnId: "turn-3" });
    function tupd(id: string) {
      return ev({ type: "tool_execution_update", toolCallId: id, toolName: "bash", output: { append: "cd" } });
    }
  });

  it("events with no known turn are dropped", () => {
    expect(map(delta("orphan"))).toEqual([]);
  });
});
