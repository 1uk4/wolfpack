/**
 * Crawl planning mode for durable wolves, per conversation: while a crawl interview/plan is in progress the observer
 * skips that conversation's turns (pi's `crawlPlanMode`), so reading source files never lands in the den.
 * Shared between the crawl tools (unified-crawl.ts) and the observer (unified.ts) through this module.
 *
 * State lives in a small file per conversation, `<den>/.memory/crawl-planning/<conversationId>.json`, and nowhere else:
 * it survives a wolfd restart mid-interview, and a second process on the same den sees the same state.
 *   planning  the observer skips the conversation.
 *   reseed    planning is over; the first observation afterwards moves the watermark past everything committed so far
 *             (the planning turns) and observes from the next response on.
 * Ways out of planning: crawl_finalize (approved), crawl_cancel, a failed draft (crawl_start / crawl_plan throwing),
 * and an idle timeout: planning ends by itself when no crawl_* / ask_user_question call touched it for IDLE_MS.
 * (A failed finalize gate keeps planning: the user is expected to fix the plan and finalize again, or cancel.)
 * A user message that is not a card answer does NOT end planning; the idle timeout is the backstop.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const IDLE_MS = 30 * 60_000;

let now = (): number => Date.now();
let idleMs = IDLE_MS;

type State = "planning" | "reseed";
const file = (den: string, conv: number) => join(den, ".memory", "crawl-planning", `${conv}.json`);

function read(den: string, conv: number): { state: State; at: number } | undefined {
  try {
    const v = JSON.parse(readFileSync(file(den, conv), "utf8")) as { state?: State; at?: number };
    if (v.state === "planning" || v.state === "reseed") return { state: v.state, at: typeof v.at === "number" ? v.at : 0 };
  } catch {
    // none (or unreadable: treated as none)
  }
  return undefined;
}

function write(den: string, conv: number, state: State): void {
  const f = file(den, conv);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ state, at: now() }));
}

/** The current state; an idle planning window is closed here (becomes `reseed`). */
function status(den: string, conv: number): State | undefined {
  const s = read(den, conv);
  if (s?.state === "planning" && now() - s.at > idleMs) {
    write(den, conv, "reseed");
    return "reseed";
  }
  return s?.state;
}

export const crawlMode = {
  /** Start (or refresh) planning. */
  begin: (den: string, conv: number): void => write(den, conv, "planning"),
  /** Planning is over; the first observation afterwards re-seeds past the planning turns. No-op unless planning. */
  end(den: string, conv: number): void {
    if (status(den, conv) === "planning") write(den, conv, "reseed");
  },
  /** Reset the idle clock of a planning conversation (a crawl_* / ask_user_question call happened). */
  touch(den: string, conv: number): void {
    if (status(den, conv) === "planning") write(den, conv, "planning");
  },
  active: (den: string, conv: number): boolean => status(den, conv) === "planning",
  /** Planning is active or waiting for its re-seed: an observation already in flight must be dropped. */
  pending: (den: string, conv: number): boolean => status(den, conv) !== undefined,
  /** True once after planning ended (consumes the marker). */
  takeReseed(den: string, conv: number): boolean {
    if (status(den, conv) !== "reseed") return false;
    rmSync(file(den, conv), { force: true });
    return true;
  },
  /** @internal test seam: clock and idle window. */
  configure(opts: { now?: () => number; idleMs?: number } = {}): void {
    now = opts.now ?? (() => Date.now());
    idleMs = opts.idleMs ?? IDLE_MS;
  },
};

/**
 * The model's tool calls of one response, noted at hook time (before the tools run, so before any observation of that
 * response can be classified): crawl_start / crawl_plan begin planning, any other crawl_* or ask_user_question call
 * refreshes the idle clock of a conversation already planning.
 */
export function noteToolCalls(den: string, conv: number, names: readonly string[]): void {
  if (names.some((n) => n === "crawl_start" || n === "crawl_plan")) crawlMode.begin(den, conv);
  else if (names.some((n) => n.startsWith("crawl_") || n === "ask_user_question")) crawlMode.touch(den, conv);
}
