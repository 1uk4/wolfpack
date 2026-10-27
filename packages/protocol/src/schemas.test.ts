import { describe, expect, it } from "vitest";
import {
  AbortRequestSchema,
  ActorSchema,
  ConsolidateResponseSchema,
  CreateThreadRequestSchema,
  PromoteResponseSchema,
  CreateThreadResponseSchema,
  ERROR_HTTP_STATUS,
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
  MemoryEventSchema,
  KbPipelineResponseSchema,
  parseMemoryEvent,
  EventEnvelopeSchema,
  PROTOCOL_VERSION,
  ProtocolVersionSchema,
  SnapshotEventSchema,
  SubmitAckSchema,
  SubmitRequestSchema,
  ThreadDetailSchema,
  ThreadEventSchema,
  ThreadMessageSchema,
  ThreadObjectSchema,
  ThreadSummarySchema,
  ShowDecisionParamsSchema,
  ShowChecklistParamsSchema,
  checklistProgress,
  parseObjectData,
  OBJECT_TYPES,
  OBJECT_TOOL_TYPES,
  OBJECT_TOOL_PARAMS,
  WolfSummarySchema,
  parseThreadEvent,
} from "./index.js";

const actor = { id: "1uk4", kind: "operator" as const };
const at = "2026-10-24T12:00:00.000Z";
const env = (id: number) => ({ id, threadId: "1uk4/home", at, actor });

const summary = { id: "1uk4/home", wolf: "1uk4", kind: "home", title: "Home" };
const message = { id: "m1", role: "user", text: "hi", at };
const detail = { ...summary, messages: [message], busy: true, lastEventId: 3 };

// Wire form of the mock's scripted turn (thinking, text, one tool, text).
const turn = [
  { ...env(1), type: "turn-start", turnId: "t1" },
  { ...env(2), type: "thinking-delta", turnId: "t1", text: "Reading. " },
  { ...env(3), type: "text-delta", turnId: "t1", text: "Let me look " },
  { ...env(4), type: "tool-start", turnId: "t1", callId: "c1", name: "read", args: { path: "README.md" } },
  { ...env(5), type: "tool-update", turnId: "t1", callId: "c1", output: "# Wolfpack\n" },
  { ...env(6), type: "tool-end", turnId: "t1", callId: "c1", result: "# Wolfpack\n", isError: false },
  { ...env(7), type: "text-delta", turnId: "t1", text: "done." },
  { ...env(8), type: "turn-end", turnId: "t1", reason: "complete" },
];

describe("version", () => {
  it("is the integer 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(ProtocolVersionSchema.parse(1)).toBe(1);
    expect(ProtocolVersionSchema.safeParse(2).success).toBe(false);
  });
});

describe("actor", () => {
  it("parses and rejects", () => {
    expect(ActorSchema.parse(actor)).toEqual(actor);
    expect(ActorSchema.safeParse({ id: "x", kind: "robot" }).success).toBe(false);
    expect(ActorSchema.safeParse({ kind: "wolf" }).success).toBe(false);
  });
});

describe("error envelope", () => {
  it("parses every code and maps each to an HTTP status", () => {
    for (const code of ErrorCodeSchema.options) {
      expect(ErrorEnvelopeSchema.parse({ code, message: "m", retryable: false }).code).toBe(code);
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(ERROR_HTTP_STATUS.busy).toBe(409);
    expect(ERROR_HTTP_STATUS.not_found).toBe(404);
  });
  it("rejects bad code / missing retryable", () => {
    expect(ErrorEnvelopeSchema.safeParse({ code: "teapot", message: "m", retryable: false }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ code: "busy", message: "m" }).success).toBe(false);
  });
});

describe("resources", () => {
  it("WolfSummary", () => {
    const w = { id: "1uk4", name: "1uk4", host: "local", status: "online" };
    expect(WolfSummarySchema.parse(w)).toEqual(w);
    expect(WolfSummarySchema.safeParse({ ...w, status: "asleep" }).success).toBe(false);
  });
  it("ThreadSummary", () => {
    expect(ThreadSummarySchema.parse(summary)).toEqual(summary);
    expect(ThreadSummarySchema.parse({ ...summary, boundWorkItem: "work-x" }).boundWorkItem).toBe("work-x");
    expect(ThreadSummarySchema.safeParse({ ...summary, kind: "group" }).success).toBe(false);
  });
  it("ThreadMessage", () => {
    expect(ThreadMessageSchema.parse(message)).toEqual(message);
    const withTools = { ...message, tools: [{ callId: "c1", name: "bash", args: { command: "ls" }, result: "a", isError: false, textOffset: 0 }] };
    expect(ThreadMessageSchema.parse(withTools)).toEqual(withTools);
    expect(ThreadMessageSchema.parse({ ...message, tools: [{ callId: "c1", name: "bash", args: {} }] }).tools).toHaveLength(1);
    expect(ThreadMessageSchema.safeParse({ ...message, tools: [{ name: "bash" }] }).success).toBe(false);
    expect(ThreadMessageSchema.safeParse({ ...message, role: "system" }).success).toBe(false);
    expect(ThreadMessageSchema.safeParse({ ...message, at: "yesterday" }).success).toBe(false);
  });
  it("ThreadDetail", () => {
    expect(ThreadDetailSchema.parse(detail)).toEqual(detail);
    expect(ThreadDetailSchema.safeParse({ ...detail, lastEventId: -1 }).success).toBe(false);
    expect(ThreadDetailSchema.safeParse({ ...summary, messages: [] }).success).toBe(false);
  });
});

describe("events", () => {
  it("parses the whole scripted turn", () => {
    for (const e of turn) {
      const r = parseThreadEvent(e);
      expect(r.kind).toBe("event");
      expect(ThreadEventSchema.parse(e)).toEqual(e);
    }
  });
  it("parses error (with and without turnId) and turn-end reasons", () => {
    expect(ThreadEventSchema.safeParse({ ...env(9), type: "error", message: "boom" }).success).toBe(true);
    expect(ThreadEventSchema.safeParse({ ...env(9), type: "error", turnId: "t1", message: "boom" }).success).toBe(true);
    for (const reason of ["complete", "aborted", "error"]) {
      expect(ThreadEventSchema.safeParse({ ...env(9), type: "turn-end", turnId: "t1", reason }).success).toBe(true);
    }
    expect(ThreadEventSchema.safeParse({ ...env(9), type: "turn-end", turnId: "t1", reason: "meh" }).success).toBe(false);
  });
  it("rejects negative / zero / fractional ids and missing actor", () => {
    const e = turn[0];
    expect(ThreadEventSchema.safeParse({ ...e, id: -1 }).success).toBe(false);
    expect(ThreadEventSchema.safeParse({ ...e, id: 0 }).success).toBe(false);
    expect(ThreadEventSchema.safeParse({ ...e, id: 1.5 }).success).toBe(false);
    const { actor: _a, ...noActor } = e;
    expect(ThreadEventSchema.safeParse(noActor).success).toBe(false);
    expect(EventEnvelopeSchema.safeParse(noActor).success).toBe(false);
  });
  it("rejects a known type with a bad payload", () => {
    const r = parseThreadEvent({ ...env(2), type: "text-delta", turnId: "t1" });
    expect(r.kind).toBe("invalid");
  });
  it("snapshot carries baseline thread state, upToId and optional in-flight partial", () => {
    const snap = { ...env(9), type: "snapshot", upToId: 8, thread: detail };
    expect(SnapshotEventSchema.parse(snap)).toEqual(snap);
    const withPartial = { ...snap, inFlight: { turnId: "t2", text: "par", thinking: "hm" } };
    expect(SnapshotEventSchema.parse(withPartial).inFlight?.text).toBe("par");
    expect(SnapshotEventSchema.safeParse({ ...snap, upToId: undefined }).success).toBe(false);
    expect(SnapshotEventSchema.safeParse({ ...snap, thread: summary }).success).toBe(false);
  });
});

describe("ignore-unknown contract", () => {
  it("an unknown type with a valid envelope parses as unknown, not an error", () => {
    const future = { ...env(10), type: "future-madeup-event", whatever: { nested: true } };
    expect(ThreadEventSchema.safeParse(future).success).toBe(false);
    const r = parseThreadEvent(future);
    expect(r.kind).toBe("unknown");
    if (r.kind === "unknown") {
      expect(r.event.envelope.type).toBe("future-madeup-event");
      expect(r.event.envelope.id).toBe(10);
      expect(r.event.raw).toEqual(future);
    }
  });
  it("a consumer loop skips unknown events and keeps the known ones", () => {
    const stream = [turn[0], { ...env(2), type: "future-madeup-event" }, turn[7]];
    const seen = stream.map(parseThreadEvent).flatMap((r) => (r.kind === "event" ? [r.event.type] : []));
    expect(seen).toEqual(["turn-start", "turn-end"]);
  });
  it("a malformed envelope is invalid, even with an unknown type", () => {
    expect(parseThreadEvent({ type: "future-madeup-event" }).kind).toBe("invalid");
    expect(parseThreadEvent(null).kind).toBe("invalid");
  });
});

describe("commands", () => {
  it("SubmitRequest requires whenBusy", () => {
    const ok = { threadId: "1uk4/home", input: "hi", whenBusy: "reject" };
    expect(SubmitRequestSchema.parse(ok)).toEqual(ok);
    for (const w of ["steer", "followUp", "reject"]) {
      expect(SubmitRequestSchema.safeParse({ ...ok, whenBusy: w }).success).toBe(true);
    }
    expect(SubmitRequestSchema.safeParse({ threadId: "t", input: "hi" }).success).toBe(false);
    expect(SubmitRequestSchema.safeParse({ ...ok, whenBusy: "queue" }).success).toBe(false);
    expect(SubmitRequestSchema.safeParse({ ...ok, whenBusy: "follow_up" }).success).toBe(false);
  });
  it("SubmitAck", () => {
    for (const disposition of ["started", "steered", "queued"]) {
      expect(SubmitAckSchema.safeParse({ messageId: "m1", disposition }).success).toBe(true);
    }
    expect(SubmitAckSchema.safeParse({ messageId: "m1", disposition: "dropped" }).success).toBe(false);
  });
  it("AbortRequest", () => {
    expect(AbortRequestSchema.parse({ threadId: "t" })).toEqual({ threadId: "t" });
    expect(AbortRequestSchema.safeParse({}).success).toBe(false);
  });
  it("CreateThreadRequest allows only home; response is a ThreadSummary", () => {
    expect(CreateThreadRequestSchema.parse({ wolf: "1uk4", kind: "home" })).toEqual({ wolf: "1uk4", kind: "home" });
    expect(CreateThreadRequestSchema.safeParse({ wolf: "1uk4", kind: "feature" }).success).toBe(false);
    expect(CreateThreadResponseSchema.parse(summary)).toEqual(summary);
  });
});

describe("MemoryEvent", () => {
  const base = { wolf: "w", timestamp: "2026-10-25T10:00:00.000Z", domain: "wolfpack" };
  const variants = [
    { ...base, type: "observation_captured", threadId: "w/home", conversationId: 1, target: { kind: "den" }, count: 2, summary: "Cache lookups" },
    { ...base, type: "observation_captured", conversationId: 4, target: { kind: "work", workId: "work-1", featureId: "work-f" }, count: 1, summary: "x" },
    { ...base, type: "topic_consolidated", target: { kind: "session", topicId: "caching" }, topicId: "caching", observationCount: 3, change: "create" },
    { ...base, type: "contribution_emitted", target: { kind: "den", topicId: "caching" }, contributionId: "caching-abc", lane: "inbox/w" },
    { ...base, type: "promote_started", target: { kind: "den" }, jobId: "j1" },
    { ...base, type: "promote_finished", target: { kind: "den" }, jobId: "j1", consolidated: 3, contributions: 1 },
    { ...base, type: "promote_failed", target: { kind: "den" }, jobId: "j1", message: "boom" },
    { ...base, type: "record_written", target: { kind: "work", workId: "work-1", featureId: "work-f" }, observationCount: 3, chars: 1200 },
    { ...base, type: "record_written", target: { kind: "work", workId: "work-1" }, observationCount: 1 },
    { ...base, type: "topic_archived", target: { kind: "den", topicId: "caching" }, topicId: "caching", absorbedInto: "kb-caching-1" },
    { ...base, type: "topic_archived", target: { kind: "den", topicId: "noise" }, topicId: "noise" },
    { ...base, domain: "kb", type: "sweep_started", target: { kind: "den" }, pending: 3 },
    { ...base, domain: "kb", type: "sweep_item", target: { kind: "den" }, from: "w", denTopicId: "caching", outcome: "create", entryId: "kb-caching-1" },
    { ...base, domain: "kb", type: "sweep_item", target: { kind: "den" }, from: "w", denTopicId: "noise", outcome: "reject" },
    { ...base, domain: "kb", type: "sweep_finished", target: { kind: "den" }, processed: 1, created: 1, merged: 0, rejected: 0, parked: 0, remaining: 2, durationMs: 1500 },
    { ...base, domain: "kb", type: "sweep_finished", target: { kind: "den" }, processed: 0, created: 0, merged: 0, rejected: 0, parked: 0, remaining: 1, durationMs: 10, error: "boom" },
  ];

  it("parses every variant (threadId optional)", () => {
    for (const v of variants) expect(parseMemoryEvent(v)).toMatchObject({ kind: "event", event: { type: v.type } });
    expect(new Set(variants.map((v) => v.type))).toEqual(new Set(MemoryEventSchema.options.map((o) => o.shape.type.value)));
  });

  it("conversationId is an optional integer", () => {
    const obs = variants[0];
    expect(parseMemoryEvent(obs)).toMatchObject({ kind: "event", event: { conversationId: 1 } });
    const { conversationId: _c, ...without } = obs;
    expect(parseMemoryEvent(without)).toMatchObject({ kind: "event" });
    expect(parseMemoryEvent({ ...obs, conversationId: 1.5 })).toMatchObject({ kind: "invalid" });
    expect(parseMemoryEvent({ ...obs, conversationId: "1" })).toMatchObject({ kind: "invalid" });
  });

  it("promote_finished parses with and without the optional pending count", () => {
    const fin = variants.find((v) => v.type === "promote_finished")!;
    expect(parseMemoryEvent(fin)).toMatchObject({ kind: "event" });
    expect(parseMemoryEvent({ ...fin, pending: 2 })).toMatchObject({ kind: "event", event: { pending: 2 } });
  });

  it("ignores unknown types and flags a known type with a bad payload", () => {
    expect(parseMemoryEvent({ ...base, type: "future_event", target: { kind: "den" } })).toMatchObject({ kind: "unknown" });
    expect(parseMemoryEvent({ ...base, type: "promote_started", target: { kind: "den" } })).toMatchObject({ kind: "invalid" });
    expect(parseMemoryEvent("nope")).toMatchObject({ kind: "invalid" });
  });

  it("sweep_item rejects an outcome it does not know", () => {
    const item = variants.find((v) => v.type === "sweep_item")!;
    expect(parseMemoryEvent({ ...item, outcome: "unclassified" })).toMatchObject({ kind: "invalid" });
  });

  it("is not a ThreadEvent and needs no protocol bump", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(parseThreadEvent(variants[0])).toMatchObject({ kind: "invalid" });
  });
});

describe("memory action responses", () => {
  const counts = { observationsProcessed: 3, topicsCreated: 1, topicsMerged: 1, topicsSkipped: 0, claimsSubmitted: 0, topicIds: ["caching"] };
  it("consolidate: counts and topic ids; optional extras", () => {
    expect(ConsolidateResponseSchema.parse(counts)).toEqual(counts);
    expect(ConsolidateResponseSchema.safeParse({ ...counts, recordsWritten: 2, observationsPending: 1 }).success).toBe(true);
    expect(ConsolidateResponseSchema.safeParse({ ...counts, topicsCreated: -1 }).success).toBe(false);
    const { topicIds: _t, ...noIds } = counts;
    expect(ConsolidateResponseSchema.safeParse(noIds).success).toBe(false);
  });
  it("promote: started | already_running with a job id", () => {
    expect(PromoteResponseSchema.parse({ jobId: "promote-1", status: "started" }).status).toBe("started");
    expect(PromoteResponseSchema.parse({ jobId: "promote-1", status: "already_running" }).status).toBe("already_running");
    expect(PromoteResponseSchema.safeParse({ jobId: "promote-1", status: "done" }).success).toBe(false);
    expect(PromoteResponseSchema.safeParse({ status: "started" }).success).toBe(false);
  });
  it("new error codes map to 409 and need no protocol bump", () => {
    expect(ERROR_HTTP_STATUS.memory_unavailable).toBe(409);
    expect(ERROR_HTTP_STATUS.promote_unavailable).toBe(409);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

it("memory_busy maps to 409", () => {
  expect(ERROR_HTTP_STATUS.memory_busy).toBe(409);
});

describe("KbPipelineResponse", () => {
  it("parses a full response and an empty one", () => {
    const full = {
      lanes: [{ wolf: "w", pending: 2, oldestAgeMs: 5000 }, { wolf: "x", pending: 0 }],
      receipts: [
        { wolf: "w", denTopicId: "caching", outcome: "create", entryId: "kb-caching-1", processed: "2026-10-25T10:00:00.000Z" },
        { wolf: "w", denTopicId: "odd", outcome: "unclassified", processed: "2026-10-25T09:00:00.000Z", detail: "pending domain: foo" },
      ],
      parked: [{ wolf: "w", file: "stuck-1.md", denTopicId: "stuck", reason: "failed 3 times" }],
      sweep: {
        current: { from: "w", denTopicId: "caching", startedAt: "2026-10-25T10:00:00.000Z", route: "merge" },
        last: { startedAt: "2026-10-25T09:59:00.000Z", finishedAt: "2026-10-25T10:00:00.000Z", processed: 1, created: 1, merged: 0, rejected: 0, parked: 0, remaining: 0, durationMs: 60000 },
      },
    };
    expect(KbPipelineResponseSchema.parse(full)).toEqual(full);
    expect(KbPipelineResponseSchema.safeParse({ lanes: [], receipts: [], parked: [], sweep: {} }).success).toBe(true);
    expect(KbPipelineResponseSchema.safeParse({ ...full, receipts: [{ ...full.receipts[0], outcome: "created" }] }).success).toBe(false);
  });
});

describe("structured objects", () => {
  const decision = { options: [{ id: "a", label: "A" }, { id: "b", label: "B", detail: "d" }], chosen: "a", rationale: "r" };

  it("ObjectUpsertEventSchema parses with and without textOffset, and rejects a bad rev / empty id", () => {
    const e = { ...env(9), type: "object-upsert", turnId: "t1", objectId: "o1", objectType: "decision", rev: 2, data: decision };
    expect(ThreadEventSchema.parse(e)).toMatchObject({ rev: 2, objectType: "decision" });
    expect(ThreadEventSchema.parse({ ...e, textOffset: 7 })).toMatchObject({ textOffset: 7 });
    expect(ThreadEventSchema.safeParse({ ...e, rev: 0 }).success).toBe(false);
    expect(ThreadEventSchema.safeParse({ ...e, objectId: "" }).success).toBe(false);
    expect(parseThreadEvent({ ...e, objectId: "" }).kind).toBe("invalid");
  });

  it("ThreadObjectSchema and ThreadMessage.objects (optional)", () => {
    const o = { objectId: "o1", type: "decision", rev: 1, data: decision, textOffset: 0 };
    expect(ThreadObjectSchema.parse(o)).toEqual(o);
    expect(ThreadObjectSchema.safeParse({ ...o, rev: -1 }).success).toBe(false);
    expect(ThreadMessageSchema.parse({ ...message, role: "assistant", objects: [o] }).objects).toHaveLength(1);
    expect(ThreadMessageSchema.parse(message).objects).toBeUndefined();
  });

  it("parseObjectData validates per type and chosen against option ids", () => {
    expect(parseObjectData("decision", decision)).toMatchObject({ chosen: "a" });
    expect(parseObjectData("decision", { ...decision, chosen: "zzz" })).toBeUndefined();
    expect(parseObjectData("decision", { ...decision, options: [] })).toBeUndefined();
    expect(parseObjectData("graph", {})).toBeUndefined();
  });

  it("the type list, tool-name map and tool params agree", () => {
    expect(Object.keys(OBJECT_TOOL_TYPES).sort()).toEqual(Object.keys(OBJECT_TOOL_PARAMS).sort());
    expect(Object.values(OBJECT_TOOL_TYPES).sort()).toEqual([...OBJECT_TYPES].sort());
    for (const [name, v] of Object.entries(OBJECT_TOOL_PARAMS)) expect(OBJECT_TOOL_TYPES[name as keyof typeof OBJECT_TOOL_TYPES]).toBe(v.type);
  });

  it("ShowDecisionParamsSchema requires objectId and a chosen id among the options", () => {
    expect(ShowDecisionParamsSchema.safeParse({ ...decision, objectId: "o1" }).success).toBe(true);
    expect(ShowDecisionParamsSchema.safeParse(decision).success).toBe(false);
    expect(ShowDecisionParamsSchema.safeParse({ ...decision, objectId: "o1", chosen: "zzz" }).success).toBe(false);
  });

  describe("checklist", () => {
    const checklist = { title: "Ship", items: [{ id: "a", label: "A", state: "done" }, { id: "b", label: "B", state: "doing", note: "n" }, { id: "c", label: "C", state: "skipped" }] };

    it("parseObjectData accepts valid items and rejects empty, duplicate ids and unknown states", () => {
      expect(parseObjectData("checklist", checklist)).toEqual(checklist);
      expect(parseObjectData("checklist", { items: [] })).toBeUndefined();
      expect(parseObjectData("checklist", { items: [checklist.items[0], { ...checklist.items[1], id: "a" }] })).toBeUndefined();
      expect(parseObjectData("checklist", { items: [{ id: "a", label: "A", state: "finished" }] })).toBeUndefined();
    });

    it("ShowChecklistParamsSchema requires objectId, min 1 item and unique ids", () => {
      expect(ShowChecklistParamsSchema.safeParse({ ...checklist, objectId: "o" }).success).toBe(true);
      expect(ShowChecklistParamsSchema.safeParse(checklist).success).toBe(false);
      expect(ShowChecklistParamsSchema.safeParse({ objectId: "o", items: [] }).success).toBe(false);
      expect(ShowChecklistParamsSchema.safeParse({ objectId: "o", items: [checklist.items[0], checklist.items[0]] }).success).toBe(false);
      expect(ShowChecklistParamsSchema.safeParse({ objectId: "o", items: [{ id: "a", label: "A", state: "nope" }] }).success).toBe(false);
    });

    it("progress is derived: done over total", () => {
      expect(checklistProgress(parseObjectData("checklist", checklist)!)).toEqual({ done: 1, total: 3 });
    });
  });
});
