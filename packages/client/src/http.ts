import {
  ATTACHMENT_NAME_HEADER,
  ErrorEnvelopeSchema,
  LAST_EVENT_ID_HEADER,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  ROUTES,
  type RouteDef,
  SSE_DONE,
  buildPath,
  parseMemoryEvent,
  parseThreadEvent,
  parseWolfEvent,
  parseHubEvent,
  type BindThreadResponse,
  type ThreadContext,
  type ThreadSettingsPatch,
  type ThreadSettingsResponse,
  type PromptView,
  type ListPromptsResponse,
  type WolfSettingsView,
  type RevealResponse,
  type RestartResponse,
  type RouteName,
  type KbCommitRequest,
  type KbCommitResponse,
  DeviceList,
  MintPairingCodeResponse,
  type CommandKind,
  type CommandResponse,
} from "@wolfpack/protocol";
import {
  BusyError,
  NotFoundError,
  ProtocolError,
  type CardAnswers,
  type CreateThreadBody,
  type ConsoleClient,
  type ConsolidateResponse,
  type KbEntryDetail,
  type KbGraph,
  type MemoryStatus,
  type MemoryTopic,
  type MemoryObservations,
  type MemoryTree,
  type MemoryNodeObservations,
  type WorkRecordResponse,
  type WorkItemResponse,
  type GraduationJob,
  type GraduationObservations,
  type GraduationStatus,
  type WorkListResponse,
  type HubSettings,
  type KbActivityResponse,
  type KbActivityQuery,
  type PendingCard,
  type PromoteResponse,
  type MemoryEvent,
  type WolfEvent,
  type HubEvent,
  type Attachment,
  type SubmitAck,
  type SubmitOptions,
  type UploadOptions,
  type ThreadDetail,
  type ThreadEvent,
  type ThreadSummary,
  type LedgerEntry,
  type WatchOptions,
  type WolfSummary,
  type WorkspaceStatus,
} from "./types.js";

export interface HttpClientOptions {
  /** Server origin (optionally with a path prefix), e.g. `http://127.0.0.1:4100`. */
  baseUrl: string;
  /**
   * A hub (hubd) to read work from. When set, `listWork` / `getWorkRecord` go to the hub's hub-scoped routes
   * (`/v1/work`, `/v1/work/:id/record`; the `wolf` argument is ignored) with `Authorization: Bearer token` (no token = no credentials, so the hub answers 401); everything else still goes to `baseUrl`.
   */
  hub?: { baseUrl: string; /** Per-device bearer token. */ token?: string;
    /**
     * Relay mode: wolf-scoped requests (threads, memory, streams, ...) go to the HUB too, with the same credentials; the hub tunnels them to the
     * wolf's host over its worker link. With this set `baseUrl` is not contacted (pass the hub's URL). A wolf whose host is asleep/offline
     * fails at once with ProtocolError `engine_error` (retryable) naming the state.
     */
    relay?: boolean };
  /** Injectable fetch (tests, auth wrappers). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Consecutive failed stream reconnects tolerated before giving up. Default 5. */
  maxStreamRetries?: number;
  /** Base reconnect backoff in ms (doubles per attempt, capped at 2s). Default 50. */
  retryDelayMs?: number;
  /** Ms a non-stream request may wait for the server's response headers before failing with a retryable engine_error (`timedOut`). Default 20000. SSE routes are exempt. */
  requestTimeoutMs?: number;
}

interface Frame {
  id?: string;
  data: string;
}

/** ConsoleClient over the /v1 HTTP+SSE protocol. Interchangeable with MockConsoleClient. */
export class HttpConsoleClient implements ConsoleClient {
  private readonly base: string;
  private readonly hub?: { base: string; token?: string; relay?: boolean };
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;

  constructor(opts: HttpClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    if (opts.hub) this.hub = { base: opts.hub.baseUrl.replace(/\/+$/, ""), token: opts.hub.token, relay: opts.hub.relay };
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.maxRetries = opts.maxStreamRetries ?? 5;
    this.retryDelayMs = opts.retryDelayMs ?? 50;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
  }

  async listWolves(): Promise<WolfSummary[]> {
    const r = await this.json("listWolves", {}, ROUTES.listWolves.response.schema);
    return (r as { wolves: WolfSummary[] }).wolves;
  }

  async listThreads(wolf: string): Promise<ThreadSummary[]> {
    const r = await this.json("listThreads", { name: wolf }, ROUTES.listThreads.response.schema);
    return (r as { threads: ThreadSummary[] }).threads;
  }

  async createThread(wolf: string, body: CreateThreadBody): Promise<ThreadSummary> {
    return (await this.json("createThread", { name: wolf }, ROUTES.createThread.response.schema, body, undefined)) as ThreadSummary;
  }

  async getThread(threadId: string, opts: { limit?: number; before?: string } = {}): Promise<ThreadDetail> {
    const q = new URLSearchParams();
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts.before !== undefined) q.set("before", opts.before);
    return (await this.json("getThread", { id: threadId }, ROUTES.getThread.response.schema, undefined, threadId, q.toString() ? `?${q}` : "")) as ThreadDetail;
  }

  async listChildren(threadId: string): Promise<ThreadSummary[]> {
    const r = await this.json("listChildren", { id: threadId }, ROUTES.listChildren.response.schema, undefined, threadId);
    return (r as { threads: ThreadSummary[] }).threads;
  }

  async getLedger(threadId: string): Promise<LedgerEntry[]> {
    const r = await this.json("getLedger", { id: threadId }, ROUTES.getLedger.response.schema, undefined, threadId);
    return (r as { entries: LedgerEntry[] }).entries;
  }

  // ---- header git tree ----
  async getWorkspaceStatus(threadId: string): Promise<WorkspaceStatus> {
    return (await this.json("getWorkspaceStatus", { id: threadId }, ROUTES.getWorkspaceStatus.response.schema, undefined, threadId)) as WorkspaceStatus;
  }
  // ---- /header git tree ----

  async submit(threadId: string, input: string, opts: SubmitOptions = {}): Promise<SubmitAck> {
    const body = {
      input,
      whenBusy: opts.whenBusy ?? "reject",
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    };
    return (await this.json("submit", { id: threadId }, ROUTES.submit.response.schema, body, threadId)) as SubmitAck;
  }

  async uploadAttachment(threadId: string, data: Uint8Array | Blob, opts: UploadOptions): Promise<Attachment> {
    const headers: Record<string, string> = { "Content-Type": opts.mimeType };
    if (opts.name) headers[ATTACHMENT_NAME_HEADER] = encodeURIComponent(opts.name);
    const res = await this.request("uploadAttachment", { id: threadId }, { headers, body: data as BodyInit }, threadId);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ProtocolError("engine_error", "response is not JSON", false);
    }
    const parsed = ROUTES.uploadAttachment.response.schema.safeParse(json);
    if (!parsed.success) throw new ProtocolError("engine_error", `unexpected response shape: ${parsed.error.message}`, false);
    return parsed.data as Attachment;
  }

  async getAttachment(threadId: string, attachmentId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const res = await this.request("getAttachment", { id: threadId, attachmentId }, {}, threadId);
    return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  async answerCard(threadId: string, callId: string, answers: CardAnswers): Promise<SubmitAck> {
    return (await this.json("answerCard", { id: threadId, callId }, ROUTES.answerCard.response.schema, { answers }, threadId)) as SubmitAck;
  }

  async saveCardPage(threadId: string, callId: string, page: number, answers: CardAnswers, opts: { goto?: number; stepsKey?: string } = {}): Promise<void> {
    await this.json("saveCardPage", { id: threadId, callId, page: String(page) }, ROUTES.saveCardPage.response.schema, { answers, ...(opts.goto !== undefined ? { goto: opts.goto } : {}), ...(opts.stepsKey ? { stepsKey: opts.stepsKey } : {}) }, threadId);
  }

  async submitCard(threadId: string, callId: string, body: { answers?: CardAnswers; note?: { text?: string; attachments?: string[] }; stepsKey?: string } = {}): Promise<SubmitAck> {
    return (await this.json("submitCard", { id: threadId, callId }, ROUTES.submitCard.response.schema, body, threadId)) as SubmitAck;
  }

  async putCardNote(threadId: string, callId: string, note: { text?: string; attachments?: string[] }): Promise<void> {
    await this.json("putCardNote", { id: threadId, callId }, ROUTES.putCardNote.response.schema, { ...(note.text ? { text: note.text } : {}), ...(note.attachments?.length ? { attachments: note.attachments } : {}) }, threadId);
  }

  async bindCardText(threadId: string, callId: string, qid: string, text: string, attachments?: string[], multi?: { picked: string[]; others: string[] }, stepsKey?: string): Promise<void> {
    // Empty text and empty attachments are left out of the body, so "neither" reaches the server as `{}` and is refused there (400).
    await this.json("bindCardText", { id: threadId, callId, qid }, ROUTES.bindCardText.response.schema, { ...(text ? { text } : {}), ...(attachments?.length ? { attachments } : {}), ...(multi ?? {}), ...(stepsKey ? { stepsKey } : {}) }, threadId);
  }

  async getDiagram(threadId: string, diagramId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const res = await this.request("getDiagram", { id: threadId, diagramId }, {}, threadId);
    return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  async skipCard(threadId: string, callId: string): Promise<SubmitAck> {
    return (await this.json("skipCard", { id: threadId, callId }, ROUTES.skipCard.response.schema, undefined, threadId)) as SubmitAck;
  }

  /** Start the work-creation flow on the wolf's home thread with the wolf's own resolved prompts. */

  async listPrompts(wolf: string): Promise<PromptView[]> {
    return ((await this.json("listPrompts", { name: wolf }, ROUTES.listPrompts.response.schema, undefined, wolf)) as ListPromptsResponse).prompts;
  }

  /** `ifMatch`: the etag the caller loaded; a stale one is a ProtocolError `conflict`. */
  async putPrompt(wolf: string, id: string, text: string, ifMatch: string): Promise<PromptView> {
    return (await this.json("putPrompt", { name: wolf, id }, ROUTES.putPrompt.response.schema, { text }, wolf, "", { "If-Match": ifMatch })) as PromptView;
  }

  async resetPrompt(wolf: string, id: string, ifMatch: string): Promise<PromptView> {
    return (await this.json("resetPrompt", { name: wolf, id }, ROUTES.resetPrompt.response.schema, undefined, wolf, "", { "If-Match": ifMatch })) as PromptView;
  }

  async getWolfSettings(wolf: string): Promise<WolfSettingsView> {
    return (await this.json("getWolfSettings", { name: wolf }, ROUTES.getWolfSettings.response.schema, undefined, wolf)) as WolfSettingsView;
  }

  async putWolfSettings(wolf: string, set: Record<string, unknown>, ifMatch: string): Promise<WolfSettingsView> {
    return (await this.json("putWolfSettings", { name: wolf }, ROUTES.putWolfSettings.response.schema, { set }, wolf, "", { "If-Match": ifMatch })) as WolfSettingsView;
  }

  async revealWolfSetting(wolf: string, source: "env" | "config", name: string): Promise<RevealResponse> {
    return (await this.json("revealWolfSetting", { name: wolf }, ROUTES.revealWolfSetting.response.schema, { source, name }, wolf)) as RevealResponse;
  }

  async restartWolf(wolf: string): Promise<RestartResponse> {
    return (await this.json("restartWolf", { name: wolf }, ROUTES.restartWolf.response.schema, undefined, wolf)) as RestartResponse;
  }

  async getThreadSettings(threadId: string): Promise<ThreadSettingsResponse> {
    return (await this.json("getThreadSettings", { id: threadId }, ROUTES.getThreadSettings.response.schema, undefined, threadId)) as ThreadSettingsResponse;
  }

  async putThreadSettings(threadId: string, patch: ThreadSettingsPatch): Promise<ThreadSettingsResponse> {
    return (await this.json("putThreadSettings", { id: threadId }, ROUTES.putThreadSettings.response.schema, patch, threadId)) as ThreadSettingsResponse;
  }

  async getThreadContext(threadId: string): Promise<ThreadContext> {
    return (await this.json("getThreadContext", { id: threadId }, ROUTES.getThreadContext.response.schema, undefined, threadId)) as ThreadContext;
  }

  async compactThread(threadId: string, instructions?: string): Promise<void> {
    await this.json("compactThread", { id: threadId }, ROUTES.compactThread.response.schema, instructions ? { instructions } : {}, threadId);
  }

  // --- feature progress: bind ---
  async bindThread(threadId: string, workItemId: string): Promise<BindThreadResponse> {
    return (await this.json("bindThread", { id: threadId }, ROUTES.bindThread.response.schema, { workItemId }, threadId)) as BindThreadResponse;
  }
  // --- end feature progress ---

  async listCards(wolf: string): Promise<PendingCard[]> {
    const r = await this.json("listCards", { name: wolf }, ROUTES.listCards.response.schema, undefined, wolf);
    return (r as { cards: PendingCard[] }).cards;
  }

  async abort(threadId: string): Promise<void> {
    await this.json("abort", { id: threadId }, ROUTES.abort.response.schema, undefined, threadId);
  }

  async *watch(threadId: string, opts: WatchOptions = {}): AsyncGenerator<ThreadEvent> {
    // lastId: highest id yielded (or the snapshot baseline); events <= it are dropped.
    let lastId: number | undefined = opts.from;
    let failures = 0;

    for (;;) {
      const ctl = new AbortController();
      try {
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (lastId !== undefined) headers[LAST_EVENT_ID_HEADER] = String(lastId);
        const res = await this.request("streamThread", { id: threadId }, { headers, signal: ctl.signal }, threadId);
        if (!res.body) throw new TypeError("stream response has no body");

        for await (const frame of sseFrames(res.body)) {
          if (frame.data === SSE_DONE) return;
          let json: unknown;
          try {
            json = JSON.parse(frame.data);
          } catch {
            throw new ProtocolError("invalid_request", "stream frame is not JSON", false);
          }
          const parsed = parseThreadEvent(json);
          if (parsed.kind === "unknown") continue;
          if (parsed.kind === "invalid") throw new ProtocolError("invalid_request", `invalid stream event: ${parsed.error.message}`, false);
          const ev = parsed.event;
          if (ev.type === "snapshot") {
            opts.onSnapshot?.(ev);
            lastId = ev.upToId;
            failures = 0;
            continue;
          }
          if (lastId !== undefined && ev.id <= lastId) continue;
          lastId = ev.id;
          failures = 0;
          yield ev as ThreadEvent;
          if (ev.type === "turn-end") return;
        }
        // Clean EOF without [DONE]: treat as a dropped connection.
        throw new TypeError("stream ended without [DONE]");
      } catch (e) {
        if (e instanceof ProtocolError || e instanceof BusyError || e instanceof NotFoundError) throw e;
        if (++failures > this.maxRetries) {
          throw new ProtocolError("engine_error", `stream lost: ${e instanceof Error ? e.message : String(e)}`, true);
        }
        await sleep(Math.min(2000, this.retryDelayMs * 2 ** (failures - 1)));
      } finally {
        ctl.abort();
      }
    }
  }

  /**
   * A wolf's activity (thread status + card changes). Reconnects on a dropped stream, resuming with Last-Event-ID;
   * the server answers a stale cursor with `resync` + a baseline, which are yielded like any event (the consumer refetches).
   */
  async *watchActivity(wolf: string, opts: { from?: string; signal?: AbortSignal; idleMs?: number } = {}): AsyncGenerator<WolfEvent> {
    const { signal } = opts;
    const idleMs = opts.idleMs ?? 60_000; // the server sends a keepalive every 20s
    let cursor = opts.from;
    let failures = 0;
    while (!signal?.aborted) {
      const ctl = new AbortController();
      const stop = () => ctl.abort();
      signal?.addEventListener("abort", stop);
      try {
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (cursor !== undefined) headers[LAST_EVENT_ID_HEADER] = cursor;
        const res = await this.request("streamWolfActivity", { name: wolf }, { headers, signal: ctl.signal }, wolf);
        if (!res.body) throw new TypeError("stream response has no body");
        // Half-open guard: any bytes (frame or keepalive) re-arm it; silence aborts the request and we reconnect.
        let idle: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          clearTimeout(idle);
          idle = setTimeout(() => ctl.abort(), idleMs);
        };
        arm();
        try {
        for await (const frame of sseFrames(res.body, arm)) {
          failures = 0;
          let json: unknown;
          try {
            json = JSON.parse(frame.data);
          } catch {
            throw new ProtocolError("invalid_request", "stream frame is not JSON", false);
          }
          const parsed = parseWolfEvent(json);
          if (parsed.kind === "unknown") continue;
          if (parsed.kind === "invalid") throw new ProtocolError("invalid_request", `invalid stream event: ${parsed.error.message}`, false);
          if (frame.id) cursor = frame.id; // opaque `<boot>:<seq>`
          yield parsed.event;
        }
        } finally {
          clearTimeout(idle);
        }
        throw new TypeError("stream ended");
      } catch (e) {
        if (signal?.aborted) return;
        if (e instanceof ProtocolError || e instanceof BusyError || e instanceof NotFoundError) throw e;
        if (++failures > this.maxRetries) {
          throw new ProtocolError("engine_error", `stream lost: ${e instanceof Error ? e.message : String(e)}`, true);
        }
        await sleep(Math.min(2000, this.retryDelayMs * 2 ** (failures - 1)));
      } finally {
        signal?.removeEventListener("abort", stop);
        ctl.abort();
      }
    }
  }

  /**
   * The pack's hub events (`work.changed`, `kb.changed`, `wolf.presence`; `resync` = refetch). Needs `HttpClientOptions.hub`.
   * Reconnects on a dropped stream, resuming with Last-Event-ID (the opaque `<boot>:<seq>` of the last frame, resync included);
   * a cursor the hub cannot replay is answered with `resync`, which is yielded like any event. Never ends on its own: stop with `signal`.
   */
  async *watchHubEvents(opts: { from?: string; signal?: AbortSignal; idleMs?: number } = {}): AsyncGenerator<HubEvent> {
    const { signal } = opts;
    const idleMs = opts.idleMs ?? 60_000; // the hub sends a keepalive every 20s
    const STABLE_MS = 10_000; // a stream that stayed up this long (or delivered STABLE_FRAMES) was healthy: reset the backoff
    const STABLE_FRAMES = 5;
    let cursor = opts.from;
    let failures = 0;
    while (!signal?.aborted) {
      const ctl = new AbortController();
      const stop = () => ctl.abort();
      signal?.addEventListener("abort", stop);
      const startedAt = Date.now();
      let frames = 0;
      try {
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (cursor !== undefined) headers[LAST_EVENT_ID_HEADER] = cursor;
        const res = await this.request("hubEvents", {}, { headers, signal: ctl.signal });
        if (!res.body) throw new TypeError("stream response has no body");
        let idle: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          clearTimeout(idle);
          idle = setTimeout(() => ctl.abort(), idleMs);
        };
        arm();
        try {
          for await (const frame of sseFrames(res.body, arm)) {
            frames++;
            if (frames >= STABLE_FRAMES || Date.now() - startedAt >= STABLE_MS) failures = 0;
            let json: unknown;
            try {
              json = JSON.parse(frame.data);
            } catch {
              throw new ProtocolError("invalid_request", "stream frame is not JSON", false);
            }
            const parsed = parseHubEvent(json);
            if (parsed.kind === "unknown") continue;
            if (parsed.kind === "invalid") throw new ProtocolError("invalid_request", `invalid stream event: ${parsed.error.message}`, false);
            if (frame.id) cursor = frame.id;
            yield parsed.event;
          }
        } finally {
          clearTimeout(idle);
        }
        throw new TypeError("stream ended");
      } catch (e) {
        if (signal?.aborted) return;
        // Busy (stream cap, hub shutting down) is retryable here, like a transport error. Other protocol errors are final.
        if (e instanceof ProtocolError || e instanceof NotFoundError) throw e;
        if (Date.now() - startedAt >= STABLE_MS) failures = 0;
        failures++;
        // Unlimited retries, capped exponential backoff 50ms -> 30s with jitter; abort cuts the wait short.
        const base = Math.min(30_000, Math.max(1, this.retryDelayMs) * 2 ** Math.min(failures - 1, 20));
        await abortableSleep(base / 2 + Math.random() * (base / 2), signal);
      } finally {
        signal?.removeEventListener("abort", stop);
        ctl.abort();
      }
    }
  }

  async consolidateMemory(wolf: string): Promise<ConsolidateResponse> {
    return (await this.json("consolidateMemory", { name: wolf }, ROUTES.consolidateMemory.response.schema, undefined, wolf)) as ConsolidateResponse;
  }

  /** Never waits for the job. `already_running` (the running job's id) is a normal 202 answer, not an error. */
  async promoteMemory(wolf: string): Promise<PromoteResponse> {
    return (await this.json("promoteMemory", { name: wolf }, ROUTES.promoteMemory.response.schema, undefined, wolf)) as PromoteResponse;
  }

  async getMemoryStatus(wolf: string, opts: { thread?: string } = {}): Promise<MemoryStatus> {
    const query = opts.thread ? `?thread=${encodeURIComponent(opts.thread)}` : "";
    return (await this.json("getMemoryStatus", { name: wolf }, ROUTES.getMemoryStatus.response.schema, undefined, wolf, query)) as MemoryStatus;
  }

  async getMemoryTopic(wolf: string, topicId: string, opts: { scope?: "den" | "session" } = {}): Promise<MemoryTopic> {
    const query = opts.scope ? `?scope=${opts.scope}` : "";
    return (await this.json("getMemoryTopic", { name: wolf, id: topicId }, ROUTES.getMemoryTopic.response.schema, undefined, wolf, query)) as MemoryTopic;
  }

  async getMemoryObservations(wolf: string, opts: { limit?: number } = {}): Promise<MemoryObservations> {
    const query = opts.limit !== undefined ? `?limit=${encodeURIComponent(String(opts.limit))}` : "";
    return (await this.json("getMemoryObservations", { name: wolf }, ROUTES.getMemoryObservations.response.schema, undefined, wolf, query)) as MemoryObservations;
  }

  async getMemoryTree(wolf: string): Promise<MemoryTree> {
    return (await this.json("getMemoryTree", { name: wolf }, ROUTES.getMemoryTree.response.schema, undefined, wolf)) as MemoryTree;
  }

  async getMemoryNodeObservations(wolf: string, workId: string, opts: { limit?: number } = {}): Promise<MemoryNodeObservations> {
    const query = opts.limit !== undefined ? `?limit=${encodeURIComponent(String(opts.limit))}` : "";
    return (await this.json("getMemoryNodeObservations", { name: wolf, workId }, ROUTES.getMemoryNodeObservations.response.schema, undefined, wolf, query)) as MemoryNodeObservations;
  }

  async listWork(wolf: string, opts: { domain: string; graduated?: boolean }): Promise<WorkListResponse> {
    const query = `?domain=${encodeURIComponent(opts.domain)}${opts.graduated ? "&graduated=true" : ""}`;
    if (this.hub) return (await this.json("hubListWork", {}, ROUTES.hubListWork.response.schema, undefined, undefined, query)) as WorkListResponse;
    return (await this.json("listWork", { name: wolf }, ROUTES.listWork.response.schema, undefined, wolf, query)) as WorkListResponse;
  }

  async getWorkRecord(wolf: string, workId: string): Promise<WorkRecordResponse> {
    if (this.hub) return (await this.json("hubGetWorkRecord", { id: workId }, ROUTES.hubGetWorkRecord.response.schema)) as WorkRecordResponse;
    return (await this.json("getWorkRecord", { name: wolf, id: workId }, ROUTES.getWorkRecord.response.schema, undefined, wolf)) as WorkRecordResponse;
  }

  /** Hub only: the paired console/browser devices (label, lastUsedAt, `self`; never a secret). */
  async listDevices(): Promise<DeviceList> {
    if (!this.hub) throw new ProtocolError("invalid_request", "listDevices needs a hub client", false);
    return (await this.json("hubListDevices", {}, ROUTES.hubListDevices.response.schema)) as DeviceList;
  }

  /**
   * Hub only: run one command on a machine (POST /v1/machines/:id/commands). The hub answers 409 (not_sent_*) and 504 (timeout) with a
   * CommandResponse body: those come back as a result, not an error. Any other refusal (400, 401, ...) still throws.
   */
  async machineCommand(hostId: string, cmd: { kind: CommandKind; args?: unknown; sealed?: string }): Promise<CommandResponse> {
    if (!this.hub) throw new ProtocolError("invalid_request", "machineCommand needs a hub client", false);
    return (await this.json("hubMachineCommand", { id: hostId }, ROUTES.hubMachineCommand.response.schema, { kind: cmd.kind, args: cmd.args ?? {}, ...(cmd.sealed !== undefined ? { sealed: cmd.sealed } : {}) }, undefined, "", {}, [409, 504], MACHINE_COMMAND_TIMEOUT_MS)) as CommandResponse;
  }

  /** Hub only: revoke a device (may be this one); `cascade` also revokes the devices it added. 409 `conflict` when it would remove the last console token. */
  async revokeDevice(id: string, opts: { cascade?: boolean } = {}): Promise<{ revoked: string; self: boolean; cascaded: string[] }> {
    if (!this.hub) throw new ProtocolError("invalid_request", "revokeDevice needs a hub client", false);
    return (await this.json("hubRevokeDevice", { id }, ROUTES.hubRevokeDevice.response.schema, undefined, undefined, opts.cascade ? "?cascade=1" : "")) as { revoked: string; self: boolean; cascaded: string[] };
  }

  /** Hub only: mint a single-use browser pairing code for a new device. */
  async mintPairingCode(label?: string): Promise<MintPairingCodeResponse> {
    if (!this.hub) throw new ProtocolError("invalid_request", "mintPairingCode needs a hub client", false);
    return (await this.json("hubMintPairingCode", {}, ROUTES.hubMintPairingCode.response.schema, label ? { label } : {})) as MintPairingCodeResponse;
  }

  /** Hub only: one single-field PATCH of a work item (the caller passes the op; the hub gates it by the token's identity). */
  async patchWork(workId: string, op: { assignee: string } | { moveTo: string | null }): Promise<WorkItemResponse> {
    if (!this.hub) throw new ProtocolError("invalid_request", "patchWork needs a hub client", false);
    return (await this.json("hubPatchWork", { id: workId }, ROUTES.hubPatchWork.response.schema, op)) as WorkItemResponse;
  }

  /** `wolf`: which wolf a worker token acts for (sent as the `{wolf}` body); omit for operator tokens. */
  async claimWork(workId: string, wolf?: string): Promise<WorkItemResponse> {
    if (!this.hub) throw new ProtocolError("invalid_request", "claimWork needs a hub client", false);
    return (await this.json("hubClaimWork", { id: workId }, ROUTES.hubClaimWork.response.schema, wolf === undefined ? undefined : { wolf })) as WorkItemResponse;
  }

  /** Hub only: commit a KB batch (operator actor; the hub's all-or-nothing POST /v1/kb/commits). 409 `conflict` on a stale prevHash. */
  async commitKb(req: KbCommitRequest): Promise<KbCommitResponse> {
    if (!this.hub) throw new ProtocolError("invalid_request", "commitKb needs a hub client", false);
    return (await this.json("hubKbCommit", {}, ROUTES.hubKbCommit.response.schema, req)) as KbCommitResponse;
  }

  async releaseWork(workId: string, wolf?: string): Promise<WorkItemResponse> {
    if (!this.hub) throw new ProtocolError("invalid_request", "releaseWork needs a hub client", false);
    return (await this.json("hubUnclaimWork", { id: workId }, ROUTES.hubUnclaimWork.response.schema, wolf === undefined ? undefined : { wolf })) as WorkItemResponse;
  }

  async startGraduationPreview(wolf: string, workId: string): Promise<GraduationJob> {
    return (await this.json("previewGraduation", { name: wolf, id: workId }, ROUTES.previewGraduation.response.schema, {}, wolf)) as GraduationJob;
  }

  async startGraduationConfirm(wolf: string, workId: string, token: string): Promise<GraduationJob> {
    return (await this.json("confirmGraduation", { name: wolf, id: workId }, ROUTES.confirmGraduation.response.schema, { token }, wolf)) as GraduationJob;
  }

  async graduationStatus(wolf: string, workId: string): Promise<GraduationStatus> {
    return (await this.json("graduationStatus", { name: wolf, id: workId }, ROUTES.graduationStatus.response.schema, undefined, wolf)) as GraduationStatus;
  }

  async graduationObservations(wolf: string, workId: string): Promise<GraduationObservations> {
    return (await this.json("graduationObservations", { name: wolf, id: workId }, ROUTES.graduationObservations.response.schema, undefined, wolf)) as GraduationObservations;
  }

  async getKbGraph(wolf: string, opts: { domain?: string; archivedWork?: boolean; denTopics?: boolean } = {}): Promise<KbGraph> {
    const q = new URLSearchParams();
    if (opts.domain) q.set("domain", opts.domain);
    for (const k of ["archivedWork", "denTopics"] as const) if (opts[k] !== undefined) q.set(k, String(opts[k]));
    const query = q.size ? `?${q}` : "";
    return (await this.json("getKbGraph", { name: wolf }, ROUTES.getKbGraph.response.schema, undefined, wolf, query)) as KbGraph;
  }

  /** True in relay mode: the KB graph is served by the hub from its own KB copy (see getHubKbGraph). */
  get kbFromHub(): boolean {
    return this.hub?.relay === true;
  }

  /** The KB graph from the HUB's read-only KB copy, limited to the domains this token may read (GET /v1/kb/graph). */
  async getHubKbGraph(opts: { domain?: string; archivedWork?: boolean } = {}): Promise<KbGraph> {
    const q = new URLSearchParams();
    if (opts.domain) q.set("domain", opts.domain);
    if (opts.archivedWork !== undefined) q.set("archivedWork", String(opts.archivedWork));
    return (await this.json("hubKbGraph", {}, ROUTES.hubKbGraph.response.schema, undefined, undefined, q.size ? `?${q}` : "")) as KbGraph;
  }

  /** The hub curator's KB activity from the hub's own ledger (GET /v1/kb/activity). Hub clients only. */
  async getHubSettings(): Promise<HubSettings> {
    if (!this.hub) throw new ProtocolError("invalid_request", "getHubSettings needs a hub client", false);
    return (await this.json("hubSettings", {}, ROUTES.hubSettings.response.schema)) as HubSettings;
  }

  async getKbActivity(query: KbActivityQuery = {}): Promise<KbActivityResponse> {
    if (!this.hub) throw new ProtocolError("invalid_request", "getKbActivity needs a hub client", false);
    const q = new URLSearchParams();
    if (query.since) q.set("since", query.since);
    if (query.before) q.set("before", query.before);
    if (query.limit !== undefined) q.set("limit", String(query.limit));
    if (query.domain) q.set("domain", query.domain);
    return (await this.json("hubKbActivity", {}, ROUTES.hubKbActivity.response.schema, undefined, undefined, q.size ? `?${q}` : "")) as KbActivityResponse;
  }

  /** One KB entry from the HUB's read-only KB copy (GET /v1/kb/entries/:id), scoped to the token's readable domains. */
  async getHubKbEntry(id: string): Promise<KbEntryDetail> {
    return (await this.json("hubKbEntry", { id }, ROUTES.hubKbEntry.response.schema)) as KbEntryDetail;
  }

  async getKbEntry(wolf: string, id: string): Promise<KbEntryDetail> {
    return (await this.json("getKbEntry", { name: wolf, id }, ROUTES.getKbEntry.response.schema, undefined, wolf)) as KbEntryDetail;
  }

  /** Live, metadata-only MemoryEvents of a wolf. Reconnects on a dropped stream (no replay: events in the gap are lost). */
  async *watchMemory(wolf: string, opts: { signal?: AbortSignal } = {}): AsyncGenerator<MemoryEvent> {
    const { signal } = opts;
    let failures = 0;
    while (!signal?.aborted) {
      const ctl = new AbortController();
      const stop = () => ctl.abort();
      signal?.addEventListener("abort", stop);
      try {
        const res = await this.request("streamWolfEvents", { name: wolf }, { headers: { Accept: "text/event-stream" }, signal: ctl.signal }, wolf);
        if (!res.body) throw new TypeError("stream response has no body");
        for await (const frame of sseFrames(res.body)) {
          failures = 0; // only a received frame proves the connection worked
          let json: unknown;
          try {
            json = JSON.parse(frame.data);
          } catch {
            throw new ProtocolError("invalid_request", "stream frame is not JSON", false);
          }
          const parsed = parseMemoryEvent(json);
          if (parsed.kind === "unknown") continue;
          if (parsed.kind === "invalid") throw new ProtocolError("invalid_request", `invalid stream event: ${parsed.error.message}`, false);
          yield parsed.event;
        }
        // Clean EOF: the server went away; reconnect.
        throw new TypeError("stream ended");
      } catch (e) {
        if (signal?.aborted) return;
        if (e instanceof ProtocolError || e instanceof BusyError || e instanceof NotFoundError) throw e;
        if (++failures > this.maxRetries) {
          throw new ProtocolError("engine_error", `stream lost: ${e instanceof Error ? e.message : String(e)}`, true);
        }
        await sleep(Math.min(2000, this.retryDelayMs * 2 ** (failures - 1)));
      } finally {
        signal?.removeEventListener("abort", stop);
        ctl.abort();
      }
    }
  }

  // ------------------------------------------------------------ plumbing

  /** Credentials for a request that goes to the hub: the bearer token only. Without one nothing is sent and the hub's 401 becomes a ProtocolError. */
  private hubHeaders(viaHub: boolean): Record<string, string> {
    if (!viaHub || !this.hub?.token) return {};
    return { Authorization: `Bearer ${this.hub.token}` };
  }

  private async request(name: RouteName, params: Record<string, string>, init: RequestInit & { headers?: Record<string, string> } = {}, threadId?: string, query = "", accept: number[] = [], timeoutMs: number = this.requestTimeoutMs): Promise<Response> {
    const route: RouteDef = ROUTES[name];
    const hubRoute = route.scope === "hub";
    if (hubRoute && !this.hub) throw new ProtocolError("engine_error", `${name} needs a hub (HttpClientOptions.hub)`, false);
    const viaHub = hubRoute || this.hub?.relay === true; // relay mode: every route goes through the hub
    const origin = viaHub ? this.hub!.base : this.base;
    // Streams (SSE routes) are long-lived and run their own idle timeouts; every other request is bounded.
    const bounded = route.response.kind !== "sse";
    const timer = bounded ? new AbortController() : undefined;
    let timedOut = false;
    const handle = timer ? setTimeout(() => { timedOut = true; timer.abort(); }, timeoutMs) : undefined;
    const signal = timer ? (init.signal ? AbortSignal.any([init.signal, timer.signal]) : timer.signal) : init.signal;
    let res: Response;
    try {
      res = await this.fetchFn(origin + buildPath(name, params) + query, {
        ...init,
        ...(signal ? { signal } : {}),
        method: route.method,
        headers: { ...init.headers, ...this.hubHeaders(viaHub), [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION) },
      });
    } catch (e) {
      if (timedOut) throw Object.assign(new ProtocolError("engine_error", `wolf did not answer in time (${timeoutMs} ms)`, true), { timedOut: true });
      throw e;
    } finally {
      if (handle) clearTimeout(handle);
    }
    if (res.ok || accept.includes(res.status)) return res;
    if (viaHub && res.status === 401) {
      // A hub 401 is ALWAYS "unauthorized", whatever the body (a proxy or old hub may send none): callers re-pair on this code.
      const err = await this.toError(res, threadId);
      throw err instanceof ProtocolError && err.code === "unauthorized" ? err : new ProtocolError("unauthorized", err instanceof Error && err.message ? err.message : "hub rejected the token (HTTP 401)", false);
    }
    throw await this.toError(res, threadId);
  }

  private async json(name: RouteName, params: Record<string, string>, schema: { parse(x: unknown): unknown }, body?: unknown, threadId?: string, query = "", extraHeaders: Record<string, string> = {}, accept: number[] = [], timeoutMs?: number): Promise<unknown> {
    const headers: Record<string, string> = { ...extraHeaders };
    const init: RequestInit & { headers: Record<string, string> } = { headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.request(name, params, init, threadId, query, accept, timeoutMs);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new ProtocolError("engine_error", "response is not JSON", false);
    }
    try {
      return schema.parse(data);
    } catch (e) {
      throw new ProtocolError("engine_error", `unexpected response shape: ${e instanceof Error ? e.message : String(e)}`, false);
    }
  }

  /** Map by envelope code, never by HTTP status. */
  private async toError(res: Response, threadId?: string): Promise<Error> {
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      raw = undefined;
    }
    let env = ErrorEnvelopeSchema.safeParse(raw);
    if (!env.success) {
      // An envelope whose code this client does not know (additive growth): generic failure, server's words kept.
      const l = raw as { code?: unknown; message?: unknown; retryable?: unknown } | null;
      if (l && typeof l.code === "string" && typeof l.message === "string" && typeof l.retryable === "boolean") {
        return new ProtocolError("engine_error", l.message, l.retryable);
      }
    }
    if (!env.success) return new ProtocolError("engine_error", `HTTP ${res.status} without error envelope`, res.status >= 500);
    const { code, message, retryable, details } = env.data;
    if (code === "busy") return new BusyError(threadId ?? message, details);
    if (code === "not_found") return new NotFoundError(message);
    return new ProtocolError(code, message, retryable, details);
  }
}

/** A machine command waits longer than the hub's own per-command limit (COMMAND_TIMEOUT_MS, at most 20 s), so the hub's 504 "outcome unknown" reaches the caller instead of this client aborting first. */
const MACHINE_COMMAND_TIMEOUT_MS = 30_000;

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimal SSE parser: frames separated by blank lines; `id:`/`data:` fields, comments ignored. */
async function* sseFrames(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function parseFrame(raw: string): Frame | undefined {
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? "" : line.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { id, data: data.join("\n") } : undefined;
}
