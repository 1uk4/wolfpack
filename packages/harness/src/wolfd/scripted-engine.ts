/**
 * ScriptedEngine: a deterministic fake of the engine-conversation surface (submit/abort/watch/configure) that plays
 * a scripted turn as REAL engine-shaped events (run_start .. message_update .. tool_execution_* .. turn_end, run_end,
 * submission), in the same order pi-durable 1.4.0 emits them (spike evidence: message_end, turn_end, run_end,
 * submission last). Used to run the /v1 contract suite against WolfServer in CI without a model.
 *
 * Semantics: one run at a time; submit while running -> reject throws EngineBusyError, followUp queues (starts a new
 * run after a COMPLETE one), steer lands as an extra user entry; abort ends the run (message_end stopReason aborted,
 * submission unanswered/aborted) and drops queued follow-ups. Events are delivered asynchronously (a started submit
 * returns before run_start is observed), like the real engine.
 */
import type { ScriptStep } from "@wolfpack/protocol/stub";
import { DEFAULT_FIXTURE } from "@wolfpack/protocol/stub";
import {
  EngineBusyError,
  type ConfigureOptions,
  type EngineConversation,
  type EngineEvent,
  type EngineSnapshot,
  type EngineWatch,
  type SubmitOptions,
  type SubmitResult,
} from "../engine/index.js";

export interface ScriptedEngineOptions {
  script?: ScriptStep[];
  /** Delay between scripted events in ms. Default 10. */
  delayMs?: number;
}

interface Run {
  inputs: number[];
  aborted: boolean;
  wake?: () => void;
  done: Promise<void>;
  /** Text of the assistant round in flight. */
  round?: { text: string; tail?: string };
}

const ev = (e: unknown) => e as EngineEvent;

export class ScriptedEngine implements EngineConversation {
  readonly id = "scripted";
  readonly configured: ConfigureOptions[] = [];
  private readonly script: ScriptStep[];
  private readonly delayMs: number;
  private nextId = 1;
  private entries: unknown[] = [];
  private run: Run | null = null;
  private followUps: string[] = [];
  private finalOverride: string | undefined;
  private restream: { head: string; tail: string } | undefined;
  private readonly watchers = new Set<(batch: readonly EngineEvent[]) => void>();

  constructor(opts: ScriptedEngineOptions = {}) {
    this.script = opts.script ?? DEFAULT_FIXTURE.script;
    this.delayMs = opts.delayMs ?? 10;
  }

  async configure(opts: ConfigureOptions): Promise<void> {
    this.configured.push(opts);
  }

  async submit({ input: raw, whenBusy }: SubmitOptions): Promise<SubmitResult> {
    // The scripted engine drops image parts (text only).
    const input = typeof raw === "string" ? raw : raw.map((p) => (p.type === "text" ? p.text : "")).join("");
    const id = this.nextId++;
    if (!this.run) {
      this.startRun(id, input);
      return { messageId: String(id), disposition: "started" };
    }
    if (whenBusy === "reject") throw new EngineBusyError();
    if (whenBusy === "followUp") {
      this.followUps.push(input);
      return { messageId: String(id), disposition: "queued" };
    }
    this.emit([...this.userEntry(input), ev({ type: "submission", record: { type: "input", status: "placed", id } })]);
    return { messageId: String(id), disposition: "steered" };
  }

  async abort(): Promise<void> {
    this.followUps = [];
    const run = this.run;
    if (!run) return;
    run.aborted = true;
    run.wake?.();
    await run.done;
  }

  /** The next closed assistant round carries `text` as its final content, whatever streamed (a diverged provider retry). */
  divergeNextFinal(text: string): void {
    this.finalOverride = text;
  }

  /**
   * The next assistant round opens with a `text_start` block already holding `head` (a restream, as pi-claude-bridge
   * produces) and its final content carries an extra `tail` the stream never showed.
   */
  restreamNext(head: string, tail = ""): void {
    this.restream = { head, tail };
  }

  /** Push a mid-stream engine snapshot (what the engine does after an overflow); the mapper turns it into a resync. */
  forceSnapshot(): void {
    this.emit([this.snapshot()]);
  }

  async watch(): Promise<EngineWatch> {
    const queue: (readonly EngineEvent[])[] = [];
    let wake: (() => void) | undefined;
    let stopped = false;
    const push = (b: readonly EngineEvent[]) => {
      queue.push(b);
      wake?.();
    };
    const snapshot = this.snapshot();
    this.watchers.add(push);
    const watchers = this.watchers;
    async function* batches() {
      while (true) {
        const next = queue.shift();
        if (next) yield next;
        else if (stopped) return;
        else await new Promise<void>((r) => (wake = r));
      }
    }
    return {
      snapshot,
      batches: batches(),
      stop: async () => {
        stopped = true;
        watchers.delete(push);
        wake?.();
      },
    };
  }

  // ---------------------------------------------------------------- internals

  private snapshot(): EngineSnapshot {
    const round = this.run?.round;
    return {
      type: "snapshot",
      entries: [...this.entries],
      ...(this.run ? { run: { inputs: this.run.inputs } } : {}),
      ...(round ? { generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: round.text }] } } } : {}),
      tools: [],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    } as unknown as EngineSnapshot;
  }

  private emit(batch: readonly EngineEvent[]): void {
    for (const w of this.watchers) w(batch);
  }

  private entry(kind: string, message: unknown): unknown {
    const entry = { id: this.nextId++, conversationId: 1, kind, model: [message] };
    this.entries.push(entry);
    return entry;
  }

  private userEntry(input: string): EngineEvent[] {
    const message = { role: "user", content: input, timestamp: Date.now() };
    return [ev({ type: "message_start", message }), ev({ type: "message_end", entry: this.entry("pi.user", message) })];
  }

  private startRun(subId: number, input: string): void {
    let resolveDone!: () => void;
    const run: Run = { inputs: [subId], aborted: false, done: new Promise((r) => (resolveDone = r)) };
    this.run = run;
    void this.play(run, subId, input).finally(() => {
      this.run = null;
      resolveDone();
      const next = this.followUps.shift();
      if (next !== undefined && !run.aborted) this.startRun(this.nextId++, next);
    });
  }

  /** Resolves true after the delay, false if the run was aborted meanwhile. */
  private pause(run: Run): Promise<boolean> {
    if (run.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        run.wake = undefined;
        resolve(!run.aborted);
      }, this.delayMs);
      run.wake = () => {
        clearTimeout(timer);
        run.wake = undefined;
        resolve(false);
      };
    });
  }

  private async play(run: Run, subId: number, input: string): Promise<void> {
    const inputs = run.inputs;
    if (!(await this.pause(run))) return this.finish(run, subId, "aborted");
    this.emit([
      ...this.userEntry(input),
      ev({ type: "submission", record: { type: "input", status: "placed", id: subId } }),
      ev({ type: "run_start", inputs }),
      ev({ type: "turn_start" }),
    ]);

    let toolN = 0;
    const closeRound = (stopReason: string, extra: unknown[] = []) => {
      const round = run.round;
      if (!round) return;
      run.round = undefined;
      const finalText = this.finalOverride ?? round.text + (round.tail ?? "");
      this.finalOverride = undefined;
      const content = [...(finalText ? [{ type: "text", text: finalText }] : []), ...extra];
      const message = { role: "assistant", content, stopReason };
      this.emit([ev({ type: "message_end", entry: this.entry("pi.assistant", message) })]);
    };
    const openRound = () => {
      if (run.round) return;
      run.round = { text: "" };
      this.emit([ev({ type: "message_start", message: { role: "assistant", content: [] } })]);
      const restream = this.restream;
      if (restream) {
        this.restream = undefined;
        run.round.text = restream.head;
        run.round.tail = restream.tail;
        this.emit([
          ev({ type: "message_update", usage: {}, changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: restream.head } }] }),
        ]);
      }
    };

    for (const step of this.script) {
      if (!(await this.pause(run))) {
        closeRound("aborted");
        return this.finish(run, subId, "aborted");
      }
      if (step.kind === "thinking" || step.kind === "text") {
        openRound();
        if (step.kind === "text") run.round!.text += step.text;
        this.emit([
          ev({
            type: "message_update",
            usage: {},
            changes: [{ type: step.kind === "text" ? "text_delta" : "thinking_delta", contentIndex: 0, delta: step.text }],
          }),
        ]);
        continue;
      }
      const toolCallId = `call-${subId}-${++toolN}`;
      openRound();
      closeRound("toolUse", [{ type: "toolCall", id: toolCallId, name: step.name, arguments: step.args }]);
      this.emit([ev({ type: "tool_execution_start", toolCallId, toolName: step.name, args: step.args })]);
      for (const output of step.updates) {
        if (!(await this.pause(run))) return this.finish(run, subId, "aborted");
        this.emit([ev({ type: "tool_execution_update", toolCallId, toolName: step.name, output: { append: output } })]);
      }
      if (!(await this.pause(run))) return this.finish(run, subId, "aborted");
      const message = { role: "toolResult", toolCallId, toolName: step.name, content: [{ type: "text", text: step.result }], isError: false };
      this.emit([ev({ type: "tool_execution_end", toolCallId, toolName: step.name, entry: this.entry("pi.tool_result", message) })]);
    }
    closeRound("stop");
    return this.finish(run, subId, "done");
  }

  private finish(run: Run, subId: number, outcome: "done" | "aborted"): void {
    if (outcome === "aborted" && run.round) {
      const message = { role: "assistant", content: run.round.text ? [{ type: "text", text: run.round.text }] : [], stopReason: "aborted" };
      run.round = undefined;
      this.emit([ev({ type: "message_end", entry: this.entry("pi.assistant", message) })]);
    }
    const record =
      outcome === "done"
        ? { type: "input", status: "done", id: subId }
        : { type: "input", status: "unanswered", reason: "aborted", id: subId };
    this.emit([ev({ type: "turn_end" }), ev({ type: "run_end", inputs: run.inputs }), ev({ type: "submission", record })]);
  }
}
