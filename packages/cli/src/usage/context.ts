/**
 * Main-context share — which tools' output lands in the context, per session
 * kind. Pure: feed it parsed session entries, get rows back (a dashboard can
 * reuse it). Streaming the files is context-read.ts.
 */

/** The tool that spawns a subagent. */
export const SPAWN_TOOL = "subagent";

export interface ToolContextRow {
  tool: string;
  calls: number;
  /** Chars of tool-result text that landed in context. */
  chars: number;
  /** Share of all tool-result chars in this group, 0–100. */
  charShare: number;
  /** Share of all tool calls in this group, 0–100. */
  callShare: number;
}

export interface ContextGroup {
  sessions: number;
  toolCalls: number;
  /** Calls of the subagent tool. */
  spawns: number;
  resultChars: number;
  tools: ToolContextRow[];
}

export interface ContextReport {
  since?: string;
  main: ContextGroup;
  subagent: ContextGroup;
}

/** The slice of a session entry this stat reads. */
export interface ContextEntry {
  type?: string;
  timestamp?: string;
  message?: { role?: string; toolName?: string; content?: unknown };
}

export interface ContextAccumulator {
  sessions: number;
  calls: Map<string, number>;
  chars: Map<string, number>;
}

export function newAccumulator(): ContextAccumulator {
  return { sessions: 0, calls: new Map(), chars: new Map() };
}

const bump = (m: Map<string, number>, k: string, n: number): void => void m.set(k, (m.get(k) ?? 0) + n);

/** Chars of text in a tool result's content (a string, or an array of text parts). */
export function resultChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const p of content as Array<{ type?: string; text?: unknown }>) {
    if (p?.type === "text" && typeof p.text === "string") n += p.text.length;
  }
  return n;
}

/** Count one entry (a tool call or a tool result) into the accumulator, if it is at/after `since`. */
export function addEntry(acc: ContextAccumulator, entry: ContextEntry, since?: Date): void {
  if (entry.type !== "message" || !entry.message) return;
  if (since) {
    const t = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!(t >= since.getTime())) return;
  }
  const m = entry.message;
  if (m.role === "assistant" && Array.isArray(m.content)) {
    for (const part of m.content as Array<{ type?: string; name?: unknown }>) {
      if (part?.type === "toolCall" && typeof part.name === "string") bump(acc.calls, part.name, 1);
    }
  } else if (m.role === "toolResult") {
    bump(acc.chars, typeof m.toolName === "string" ? m.toolName : "(unknown)", resultChars(m.content));
  }
}

const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/** Turn an accumulator into rows, biggest chars first. */
export function summarize(acc: ContextAccumulator): ContextGroup {
  let toolCalls = 0;
  let resultCharsTotal = 0;
  for (const n of acc.calls.values()) toolCalls += n;
  for (const n of acc.chars.values()) resultCharsTotal += n;
  const names = new Set([...acc.calls.keys(), ...acc.chars.keys()]);
  const tools = [...names]
    .map((tool) => ({
      tool,
      calls: acc.calls.get(tool) ?? 0,
      chars: acc.chars.get(tool) ?? 0,
      charShare: pct(acc.chars.get(tool) ?? 0, resultCharsTotal),
      callShare: pct(acc.calls.get(tool) ?? 0, toolCalls),
    }))
    .sort((a, b) => b.chars - a.chars || b.calls - a.calls || a.tool.localeCompare(b.tool));
  return {
    sessions: acc.sessions,
    toolCalls,
    spawns: acc.calls.get(SPAWN_TOOL) ?? 0,
    resultChars: resultCharsTotal,
    tools,
  };
}
