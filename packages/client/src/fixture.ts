import type { ThreadSummary, WolfSummary } from "./types.js";

export const FIXTURE_WOLF: WolfSummary = { id: "1uk4", name: "1uk4", host: "local", status: "online" };

export const FIXTURE_THREAD: ThreadSummary = {
  id: "1uk4/home",
  wolf: "1uk4",
  kind: "home",
  title: "Home",
};

/** One scripted turn: the sequence the mock streams on submit(). */
export type ScriptStep =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: unknown; updates: string[]; result: string };

export const FIXTURE_SCRIPT: ScriptStep[] = [
  { kind: "thinking", text: "The user wants me to look at a file. " },
  { kind: "thinking", text: "I should read it before answering." },
  { kind: "text", text: "Let me take a look " },
  { kind: "text", text: "at that file." },
  {
    kind: "tool",
    name: "read",
    args: { path: "README.md" },
    updates: ["# Wolfpack\n", "A pack of durable agents.\n"],
    result: "# Wolfpack\nA pack of durable agents.\n",
  },
  { kind: "text", text: "It describes " },
  { kind: "text", text: "a pack of durable agents." },
];
