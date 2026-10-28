import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_NAME_HEADER,
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  ROUTES,
  SSE_DONE,
  buildPath,
  parseThreadEvent,
  type ErrorCode,
  type RouteName,
  type ThreadEvent,
} from "../index.js";
import type { z } from "zod";

export interface ContractOptions {
  /** Wolf to run against. Default: the first wolf the server lists. */
  wolf?: string;
  /** Max ms to wait for a scripted turn to finish. Default 10000. */
  turnTimeoutMs?: number;
  /** Servers that can graduate a feature: closes the feature thread of this work item (enables the thread_closed test). */
  closeFeatureThread?: (workItemId: string) => Promise<void> | void;
}

interface Frame {
  id?: number;
  data: string;
}
interface StreamResult {
  status: number;
  frames: Frame[];
  events: ThreadEvent[];
  /** True when the stream ended with the [DONE] terminator. */
  done: boolean;
}

/**
 * Run the /v1 contract against any running server. `baseUrl` is a thunk so
 * the server can be started in a beforeAll.
 */
export function runContractSuite(baseUrl: () => string, options: ContractOptions = {}): void {
  const timeout = options.turnTimeoutMs ?? 10_000;

  const call = (path: string, init: RequestInit = {}) => fetch(baseUrl() + path, init);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  async function expectJson<S extends z.ZodType>(res: Response, schema: S, status: readonly number[] = [200]): Promise<z.infer<S>> {
    const body = await res.json();
    expect(status, JSON.stringify(body)).toContain(res.status);
    return schema.parse(body);
  }

  async function expectError(res: Response, code: ErrorCode): Promise<void> {
    expect(res.status).toBe(ERROR_HTTP_STATUS[code]);
    const env = ErrorEnvelopeSchema.parse(await res.json());
    expect(env.code).toBe(code);
  }

  async function readStream(path: string, headers: Record<string, string> = {}, stopAfter?: number): Promise<StreamResult> {
    const res = await call(path, { headers });
    if (res.status !== 200) return { status: res.status, frames: [], events: [], done: false };
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const frames: Frame[] = [];
    const events: ThreadEvent[] = [];
    let buf = "";
    let done = false;
    outer: for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const frame: Frame = { data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) frame.id = Number(line.slice(4));
          else if (line.startsWith("data: ")) frame.data += line.slice(6);
        }
        frames.push(frame);
        if (frame.data === SSE_DONE) {
          done = true;
          break outer;
        }
        const parsed = parseThreadEvent(JSON.parse(frame.data));
        expect(parsed.kind).toBe("event");
        if (parsed.kind === "event") {
          expect(frame.id).toBe(parsed.event.id);
          events.push(parsed.event);
        }
        if (stopAfter !== undefined && events.length >= stopAfter) break outer;
      }
    }
    await reader.cancel().catch(() => {});
    return { status: res.status, frames, events, done };
  }

  const getThread = async (id: string) => expectJson(await call(buildPath("getThread", { id })), ROUTES.getThread.response.schema);
  const submit = (id: string, input: string, whenBusy?: string) =>
    post(buildPath("submit", { id }), whenBusy === undefined ? { input } : { input, whenBusy });
  const streamPath = (id: string) => buildPath("streamThread", { id });

  async function waitIdle(id: string): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (!(await getThread(id)).busy) return;
      if (Date.now() > deadline) throw new Error(`thread ${id} never went idle`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Submit on an idle thread and read its stream to the end. */
  async function runTurn(id: string, input = "hi"): Promise<ThreadEvent[]> {
    await waitIdle(id);
    const ack = await expectJson(await submit(id, input, "reject"), ROUTES.submit.response.schema);
    expect(ack.disposition).toBe("started");
    const s = await readStream(streamPath(id));
    expect(s.done).toBe(true);
    return s.events;
  }

  describe("/v1 contract", () => {
    let wolf = "";
    let threadId = "";

    it("GET /v1/wolves lists wolves", async () => {
      const body = await expectJson(await call(buildPath("listWolves")), ROUTES.listWolves.response.schema);
      expect(body.wolves.length).toBeGreaterThan(0);
      wolf = options.wolf ?? body.wolves[0].name;
      expect(body.wolves.some((w) => w.name === wolf)).toBe(true);
    });

    it("POST threads creates the home thread idempotently", async () => {
      const path = buildPath("createThread", { name: wolf });
      const first = await expectJson(await post(path, { kind: "home" }), ROUTES.createThread.response.schema, [200, 201]);
      expect(first.kind).toBe("home");
      expect(first.wolf).toBe(wolf);
      const second = await expectJson(await post(path, { kind: "home" }), ROUTES.createThread.response.schema, [200]);
      expect(second).toEqual(first);
      threadId = first.id;
      const list = await expectJson(await call(buildPath("listThreads", { name: wolf })), ROUTES.listThreads.response.schema);
      expect(list.threads.filter((t) => t.kind === "home")).toHaveLength(1);
      expect(list.threads.map((t) => t.id)).toContain(threadId);
    });

    it("POST threads {feature, workItemId} opens a feature thread, idempotently, listed beside home", async () => {
      const path = buildPath("createThread", { name: wolf });
      const first = await expectJson(await post(path, { kind: "feature", workItemId: "work-contract-feat1" }), ROUTES.createThread.response.schema, [201]);
      expect(first.kind).toBe("feature");
      expect(first.boundWorkItem).toBe("work-contract-feat1");
      expect(first.id).not.toBe(threadId);
      const again = await expectJson(await post(path, { kind: "feature", workItemId: "work-contract-feat1" }), ROUTES.createThread.response.schema, [200]);
      expect(again.id).toBe(first.id);
      const other = await expectJson(await post(path, { kind: "feature", workItemId: "work-contract-feat2" }), ROUTES.createThread.response.schema, [201]);
      expect(other.id).not.toBe(first.id);
      const list = await expectJson(await call(buildPath("listThreads", { name: wolf })), ROUTES.listThreads.response.schema);
      expect(list.threads.filter((t) => t.kind === "home")).toHaveLength(1);
      expect(list.threads.filter((t) => t.kind === "feature").map((t) => t.id).sort()).toEqual([first.id, other.id].sort());
      expect((await getThread(first.id)).kind).toBe("feature");
    });

    it("a feature thread runs turns on its own, apart from home", async () => {
      const f = await expectJson(await post(buildPath("createThread", { name: wolf }), { kind: "feature", workItemId: "work-contract-feat1" }), ROUTES.createThread.response.schema, [200]);
      const events = await runTurn(f.id, "from the feature");
      expect(events.every((e) => e.threadId === f.id)).toBe(true);
      expect(events.at(-1)?.type).toBe("turn-end");
      const detail = await getThread(f.id);
      expect(detail.messages.some((m) => m.role === "user" && m.text.includes("from the feature"))).toBe(true);
      expect((await getThread(threadId)).messages.some((m) => m.text.includes("from the feature"))).toBe(false);
    });

    it.runIf(!!options.closeFeatureThread)("a closed feature thread stays readable and refuses sends with 409 thread_closed", async () => {
      const f = await expectJson(await post(buildPath("createThread", { name: wolf }), { kind: "feature", workItemId: "work-contract-closed" }), ROUTES.createThread.response.schema, [200, 201]);
      await options.closeFeatureThread!("work-contract-closed");
      const detail = await getThread(f.id);
      expect(detail.closed).toBe(true);
      expect(detail.closedReason).toContain("graduated");
      const res = await post(buildPath("submit", { id: f.id }), { input: "more", whenBusy: "reject" });
      await expectError(res, "thread_closed");
    });

    it("create rejects bad bodies, a feature without a work item, subagents and unknown wolves", async () => {
      await expectError(await post(buildPath("createThread", { name: wolf }), { kind: "feature" }), "invalid_request");
      await expectError(await post(buildPath("createThread", { name: wolf }), { kind: "subagent", workItemId: "w" }), "invalid_request");
      await expectError(await post(buildPath("createThread", { name: wolf }), "not json"), "invalid_request");
      await expectError(await post(buildPath("createThread", { name: "no-such-wolf" }), { kind: "home" }), "not_found");
      await expectError(await call(buildPath("listThreads", { name: "no-such-wolf" })), "not_found");
    });

    it("children and ledger: a thread with no subagents lists none; a non-subagent has no ledger; unknown threads are not_found", async () => {
      const kids = await expectJson(await call(buildPath("listChildren", { id: threadId })), ROUTES.listChildren.response.schema);
      expect(kids.threads).toEqual([]);
      await expectError(await call(buildPath("getLedger", { id: threadId })), "not_found");
      await expectError(await call(buildPath("listChildren", { id: "nope/nope" })), "not_found");
      await expectError(await call(buildPath("getLedger", { id: "nope/nope" })), "not_found");
    });

    // ---- header git tree ----
    it("workspace status: a thread without a git workspace is not_found, one with it matches the schema; unknown threads are not_found", async () => {
      const r = await call(buildPath("getWorkspaceStatus", { id: threadId }));
      if (r.status === 200) await expectJson(r, ROUTES.getWorkspaceStatus.response.schema);
      else await expectError(r, "not_found");
      await expectError(await call(buildPath("getWorkspaceStatus", { id: "nope/nope" })), "not_found");
    });
    // ---- /header git tree ----

    it("GET thread returns ThreadDetail; unknown thread is a not_found envelope", async () => {
      const t = await getThread(threadId);
      expect(t.id).toBe(threadId);
      await expectError(await call(buildPath("getThread", { id: "nope/nope" })), "not_found");
      await expectError(await call(streamPath("nope/nope")), "not_found");
      await expectError(await submit("nope/nope", "x", "reject"), "not_found");
      await expectError(await post(buildPath("abort", { id: "nope/nope" }), {}), "not_found");
    });

    it("unknown routes are not_found envelopes", async () => {
      await expectError(await call("/v1/nothing"), "not_found");
    });

    it("submit validates its body; whenBusy is required", async () => {
      await waitIdle(threadId);
      await expectError(await submit(threadId, "hi"), "invalid_request");
      await expectError(await submit(threadId, "hi", "bogus"), "invalid_request");
      await expectError(await post(buildPath("submit", { id: threadId }), "not json"), "invalid_request");
      await expectError(await post(buildPath("submit", { id: threadId }), { whenBusy: "reject" }), "invalid_request");
      expect((await getThread(threadId)).busy).toBe(false);
    });

    describe("attachments", () => {
      const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
      const upload = (id: string, type: string | undefined, body: Uint8Array | string, name?: string) =>
        call(buildPath("uploadAttachment", { id }), {
          method: "POST",
          headers: { ...(type ? { "Content-Type": type } : {}), ...(name ? { [ATTACHMENT_NAME_HEADER]: encodeURIComponent(name) } : {}) },
          body: body as BodyInit,
        });
      const send = (refs: unknown, input = "look") => post(buildPath("submit", { id: threadId }), { input, whenBusy: "reject", attachments: refs });

      it("uploads an image, then submits with its ref (image-only input allowed)", async () => {
        await waitIdle(threadId);
        const att = await expectJson(await upload(threadId, "image/png", PNG, "shot.png"), ROUTES.uploadAttachment.response.schema, [201]);
        expect(att).toMatchObject({ mimeType: "image/png", size: PNG.length, name: "shot.png" });
        await expectJson(await send([{ id: att.id }], ""), ROUTES.submit.response.schema);
        expect((await readStream(streamPath(threadId))).done).toBe(true);
        await waitIdle(threadId);
      });

      it("serves an upload's bytes back (stored mime, nosniff) and lists it on the user message", async () => {
        await waitIdle(threadId);
        const att = await expectJson(await upload(threadId, "image/png", PNG, "again.png"), ROUTES.uploadAttachment.response.schema, [201]);
        const got = await call(buildPath("getAttachment", { id: threadId, attachmentId: att.id }));
        expect(got.status).toBe(200);
        expect(got.headers.get("content-type")).toBe("image/png");
        expect(got.headers.get("x-content-type-options")).toBe("nosniff");
        expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
        await expectJson(await send([{ id: att.id }], "with pic"), ROUTES.submit.response.schema);
        await readStream(streamPath(threadId));
        await waitIdle(threadId);
        const msg = (await getThread(threadId)).messages.find((m) => m.role === "user" && m.attachments?.some((a) => a.id === att.id));
        expect(msg?.attachments?.[0]).toMatchObject({ id: att.id, mimeType: "image/png", size: PNG.length });
      });

      it("refuses an unknown, malformed or traversal attachment id, and an unknown thread, as not_found", async () => {
        await waitIdle(threadId);
        for (const attachmentId of ["nope", "../../etc/passwd", "..\\..\\x", "%2e%2e", "00000000-0000-0000-0000-000000000000"]) {
          await expectError(await call(buildPath("getAttachment", { id: threadId, attachmentId })), "not_found");
        }
        await expectError(await call(buildPath("getAttachment", { id: "nope/nope", attachmentId: "x" })), "not_found");
      });

      it("refuses non-images, a missing content type, unknown refs and too many refs", async () => {
        await waitIdle(threadId);
        await expectError(await upload(threadId, "text/plain", "hi"), "invalid_request");
        await expectError(await upload(threadId, undefined, PNG), "invalid_request");
        await expectError(await send([{ id: "nope" }]), "invalid_request");
        await expectError(await send(Array.from({ length: 9 }, (_, i) => ({ id: `a${i}` }))), "invalid_request");
        await expectError(await upload("nope/nope", "image/png", PNG), "not_found");
        expect((await getThread(threadId)).busy).toBe(false);
      });
    });

    it("a turn streams monotonic server-minted ids, ends at turn-end with [DONE]", async () => {
      await waitIdle(threadId);
      const before = (await getThread(threadId)).lastEventId;
      const events = await runTurn(threadId, "hello");
      expect(events[0].type).toBe("turn-start");
      expect(events.at(-1)?.type).toBe("turn-end");
      expect(events.at(-1)).toMatchObject({ reason: "complete" });
      const types = new Set(events.map((e) => e.type));
      expect(types.has("text-delta")).toBe(true);
      for (let i = 0; i < events.length; i++) {
        expect(events[i].threadId).toBe(threadId);
        if (i > 0) expect(events[i].id).toBeGreaterThan(events[i - 1].id);
      }
      expect(events[0].id).toBeGreaterThan(before);
      await waitIdle(threadId);
      const t = await getThread(threadId);
      expect(t.lastEventId).toBe(events.at(-1)!.id);
      expect(t.messages.some((m) => m.role === "user" && m.text === "hello")).toBe(true);
      expect(t.messages.some((m) => m.role === "assistant")).toBe(true);
      // `tools` is optional (old servers omit it) and, when present, well-formed and assistant-only.
      for (const m of t.messages) {
        if (m.tools === undefined) continue;
        expect(m.role).toBe("assistant");
        for (const c of m.tools) {
          expect(typeof c.callId).toBe("string");
          expect(typeof c.name).toBe("string");
          if (c.textOffset !== undefined) expect(c.textOffset).toBeLessThanOrEqual(m.text.length);
        }
      }
    });

    it("stream with no cursor replays the most recent turn then ends", async () => {
      const events = await runTurn(threadId);
      const again = await readStream(streamPath(threadId));
      expect(again.done).toBe(true);
      expect(again.events).toEqual(events);
    });

    it("replays buffered events after Last-Event-ID (header and ?from=) within the current turn", async () => {
      const events = await runTurn(threadId);
      const cursor = events[2].id;
      const expected = events.filter((e) => e.id > cursor);
      const viaHeader = await readStream(streamPath(threadId), { "Last-Event-ID": String(cursor) });
      expect(viaHeader.events).toEqual(expected);
      expect(viaHeader.done).toBe(true);
      const viaQuery = await readStream(`${streamPath(threadId)}?from=${cursor}`);
      expect(viaQuery.events).toEqual(expected);
      const atEnd = await readStream(streamPath(threadId), { "Last-Event-ID": String(events.at(-1)!.id) });
      expect(atEnd.events).toEqual([]);
      expect(atEnd.done).toBe(true);
    });

    it("resumes mid-turn: replay then live, no gaps or duplicates", async () => {
      await waitIdle(threadId);
      await submit(threadId, "resume", "reject");
      const head = await readStream(streamPath(threadId), {}, 2);
      expect(head.events).toHaveLength(2);
      const tail = await readStream(streamPath(threadId), { "Last-Event-ID": String(head.events[1].id) });
      expect(tail.done).toBe(true);
      const all = [...head.events, ...tail.events];
      expect(all.at(-1)?.type).toBe("turn-end");
      all.forEach((e, i) => {
        if (i > 0) expect(e.id).toBe(all[i - 1].id + 1);
      });
      const full = await readStream(streamPath(threadId));
      expect(full.events).toEqual(all);
    });

    it("sends a snapshot when the cursor predates the current turn (turn finished)", async () => {
      const first = await runTurn(threadId, "one");
      const second = await runTurn(threadId, "two");
      expect(second[0].id).toBeGreaterThan(first[1].id + 1);
      const s = await readStream(streamPath(threadId), { "Last-Event-ID": String(first[1].id) });
      expect(s.done).toBe(true);
      expect(s.events).toHaveLength(1);
      const snap = s.events[0];
      expect(snap.type).toBe("snapshot");
      if (snap.type !== "snapshot") return;
      expect(snap.upToId).toBe(second.at(-1)!.id);
      expect(snap.thread.id).toBe(threadId);
      expect(snap.thread.busy).toBe(false);
      expect(snap.thread.lastEventId).toBe(snap.upToId);
      expect(snap.thread.messages.some((m) => m.text === "two")).toBe(true);
      expect(snap.inFlight).toBeUndefined();
    });

    it("snapshot then live when the stale cursor arrives mid-turn", async () => {
      const prev = await runTurn(threadId, "prev");
      await submit(threadId, "live", "reject");
      const s = await readStream(streamPath(threadId), { "Last-Event-ID": String(prev[1].id) });
      expect(s.done).toBe(true);
      const snap = s.events[0];
      expect(snap.type).toBe("snapshot");
      if (snap.type !== "snapshot") return;
      const rest = s.events.slice(1);
      expect(rest.at(-1)?.type).toBe("turn-end");
      for (const e of rest) expect(e.id).toBeGreaterThan(snap.upToId);
      if (snap.thread.busy) expect(snap.inFlight?.turnId).toBeTruthy();
    });

    it("whenBusy=reject on a busy thread is a 409 busy envelope", async () => {
      await waitIdle(threadId);
      await submit(threadId, "first", "reject");
      const res = await submit(threadId, "second", "reject");
      await expectError(res, "busy");
      await waitIdle(threadId);
    });

    it("whenBusy=steer on a busy thread is acked as steered", async () => {
      await waitIdle(threadId);
      await submit(threadId, "first", "reject");
      const ack = await expectJson(await submit(threadId, "steer me", "steer"), ROUTES.submit.response.schema);
      expect(ack.disposition).toBe("steered");
      expect(ack.messageId).toBeTruthy();
      await waitIdle(threadId);
    });

    it("whenBusy=followUp is queued and runs after the current turn", async () => {
      await waitIdle(threadId);
      const before = (await getThread(threadId)).messages.filter((m) => m.role === "assistant").length;
      await submit(threadId, "first", "reject");
      const ack = await expectJson(await submit(threadId, "later", "followUp"), ROUTES.submit.response.schema);
      expect(ack.disposition).toBe("queued");
      const deadline = Date.now() + timeout;
      for (;;) {
        const t = await getThread(threadId);
        if (!t.busy && t.messages.filter((m) => m.role === "assistant").length >= before + 2) break;
        if (Date.now() > deadline) throw new Error("follow-up never ran");
        await new Promise((r) => setTimeout(r, 10));
      }
    });

    it("whenBusy is ignored when idle: submit starts a turn", async () => {
      await waitIdle(threadId);
      for (const wb of ["steer", "followUp", "reject"]) {
        const ack = await expectJson(await submit(threadId, "idle", wb), ROUTES.submit.response.schema);
        expect(ack.disposition).toBe("started");
        await waitIdle(threadId);
      }
    });

    it("abort ends the turn with turn-end reason aborted", async () => {
      await waitIdle(threadId);
      await submit(threadId, "abort me", "reject");
      const res = await post(buildPath("abort", { id: threadId }), {});
      await expectJson(res, ROUTES.abort.response.schema);
      const s = await readStream(streamPath(threadId));
      expect(s.done).toBe(true);
      expect(s.events.at(-1)).toMatchObject({ type: "turn-end", reason: "aborted" });
      await waitIdle(threadId);
    });

    it("abort drops queued follow-ups", async () => {
      await waitIdle(threadId);
      await submit(threadId, "first", "reject");
      await submit(threadId, "queued", "followUp");
      await post(buildPath("abort", { id: threadId }), {});
      await waitIdle(threadId);
      await new Promise((r) => setTimeout(r, 100));
      expect((await getThread(threadId)).busy).toBe(false);
    });

    it("memory actions: unknown wolf is not_found; otherwise a valid result or a memory_unavailable envelope", async () => {
      await expectError(await post(buildPath("consolidateMemory", { name: "no-such-wolf" }), {}), "not_found");
      await expectError(await post(buildPath("promoteMemory", { name: "no-such-wolf" }), {}), "not_found");
      // A server may or may not run memory for this wolf: both outcomes are legal, nothing else is.
      const c = await post(buildPath("consolidateMemory", { name: wolf }), {});
      if (c.status === 200) ROUTES.consolidateMemory.response.schema.parse(await c.json());
      else expect(["memory_unavailable", "memory_busy"]).toContain(ErrorEnvelopeSchema.parse(await c.json()).code);
      const p = await post(buildPath("promoteMemory", { name: wolf }), {});
      if (p.status === 202) expect(["started", "already_running"]).toContain(ROUTES.promoteMemory.response.schema.parse(await p.json()).status);
      else {
        expect(p.status).toBe(409);
        expect(["memory_unavailable", "promote_unavailable"]).toContain(ErrorEnvelopeSchema.parse(await p.json()).code);
      }
    });

    it("memory read routes: unknown wolf is not_found; otherwise a valid status (any state), topic envelope or work error", async () => {
      for (const path of [buildPath("getMemoryStatus", { name: "no-such-wolf" }), buildPath("getMemoryTopic", { name: "no-such-wolf", id: "x" }), buildPath("getMemoryObservations", { name: "no-such-wolf" }), buildPath("getWorkRecord", { name: "no-such-wolf", id: "work-x-1234567" })]) {
        await expectError(await call(path), "not_found");
      }
      const s = await call(buildPath("getMemoryStatus", { name: wolf }));
      expect(s.status).toBe(200);
      ROUTES.getMemoryStatus.response.schema.parse(await s.json());
      const t = await call(buildPath("getMemoryTopic", { name: wolf, id: "no-such-topic" }));
      expect(t.status).toBeGreaterThanOrEqual(400);
      expect(["not_found", "memory_unavailable"]).toContain(ErrorEnvelopeSchema.parse(await t.json()).code);
      const o = await call(buildPath("getMemoryObservations", { name: wolf }));
      if (o.status === 200) {
        const pool = ROUTES.getMemoryObservations.response.schema.parse(await o.json());
        expect(pool.total).toBeGreaterThanOrEqual(pool.observations.length);
      } else {
        expect(o.status).toBe(409);
        expect(ErrorEnvelopeSchema.parse(await o.json()).code).toBe("memory_unavailable");
      }
      await expectError(await call(`${buildPath("getMemoryObservations", { name: wolf })}?limit=nope`), "invalid_request");
      const w = await call(buildPath("getWorkRecord", { name: wolf, id: "work-x-1234567" }));
      expect(w.status).toBeGreaterThanOrEqual(400);
      expect(["not_found", "memory_unavailable"]).toContain(ErrorEnvelopeSchema.parse(await w.json()).code);
    });

    it("cards: unknown wolf/thread/card are not_found, a bad answer body is invalid_request, the list is valid", async () => {
      await expectError(await call(buildPath("listCards", { name: "no-such-wolf" })), "not_found");
      const list = await call(buildPath("listCards", { name: wolf }));
      expect(list.status).toBe(200);
      ROUTES.listCards.response.schema.parse(await list.json());
      const answer = (id: string, body: unknown) => post(buildPath("answerCard", { id, callId: "call-x" }), body);
      await expectError(await answer("nope/nope", { answers: {} }), "not_found");
      await expectError(await answer(threadId, { nope: 1 }), "invalid_request");
      await expectError(await answer(threadId, { answers: { a: { value: "x" } } }), "not_found");
      const skip = (id: string) => post(buildPath("skipCard", { id, callId: "call-x" }), {});
      await expectError(await skip("nope/nope"), "not_found");
      await expectError(await skip(threadId), "not_found");
    });

    it("kb routes: unknown wolf is not_found; otherwise a valid graph / entry, or kb_unavailable when not the librarian", async () => {
      for (const path of [buildPath("getKbGraph", { name: "no-such-wolf" }), buildPath("getKbEntry", { name: "no-such-wolf", id: "kb-x-1234567" })]) {
        await expectError(await call(path), "not_found");
      }
      const g = await call(buildPath("getKbGraph", { name: wolf }));
      if (g.status === 200) ROUTES.getKbGraph.response.schema.parse(await g.json());
      else {
        expect(g.status).toBe(409);
        expect(ErrorEnvelopeSchema.parse(await g.json()).code).toBe("kb_unavailable");
      }
      const e = await call(buildPath("getKbEntry", { name: wolf, id: "no-such-entry" }));
      expect(e.status).toBeGreaterThanOrEqual(400);
      expect(["not_found", "kb_unavailable"]).toContain(ErrorEnvelopeSchema.parse(await e.json()).code);
    });

    it("kb pipeline: unknown wolf is not_found; otherwise a valid pipeline, or kb_unavailable when not the librarian", async () => {
      await expectError(await call(buildPath("kbPipeline", { name: "no-such-wolf" })), "not_found");
      const p = await call(buildPath("kbPipeline", { name: wolf }));
      if (p.status === 200) ROUTES.kbPipeline.response.schema.parse(await p.json());
      else {
        expect(p.status).toBe(409);
        expect(ErrorEnvelopeSchema.parse(await p.json()).code).toBe("kb_unavailable");
      }
    });

    it("protocol version: matching or absent is accepted, mismatch is 426 version_mismatch", async () => {
      const ok = await call(buildPath("listWolves"), { headers: { [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION) } });
      expect(ok.status).toBe(200);
      await ok.arrayBuffer();
      const bad = await call(buildPath("listWolves"), { headers: { [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION + 1) } });
      expect(bad.status).toBe(426);
      await expectError(bad, "version_mismatch");
      await expectError(await call(buildPath("listWolves"), { headers: { [PROTOCOL_VERSION_HEADER]: "abc" } }), "invalid_request");
    });
  });
}

export type { RouteName };
