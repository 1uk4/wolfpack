/**
 * Frozen prompt sections and the context-update notice (work-wolfpack-7nGjc28).
 *
 * pi-durable re-renders every extension section on each request and patches a changed one into the transcript as a
 * system message, which invalidates the prompt cache from that point on. The volatile sections (den topics, retired
 * notes, the KB outline, the active-task header) change mid-conversation, so a `frozen` section keeps the text the
 * conversation first showed: `freezeSection` returns that text while the fresh render is only remembered. What changed
 * reaches the model as ONE short line on the next user message that starts a turn ("Context update: kb_access changed
 * (+1: ...)"), the same way the task-update notice does. A compaction writes a new baseline, which shows the fresh text.
 *
 * pi-durable contract (pi-durable 1.4 harness/types.d.ts PromptInput, harness/prompt.js): `input.shown` maps a section
 * key to the TAGGED text in effect after replaying the transcript (`<key>\n...\n</key>`); it has no entry on the first
 * render and after a compaction (the baseline omits earlier system entries). pi-durable wraps whatever render returns,
 * so a frozen render returns the unwrapped text.
 *
 * State is in memory and small (a hash plus the list lines of each section): after a wolfd restart the first render of a
 * conversation compares the frozen text with the fresh one, so a change is announced at most once more. A deleted or
 * closed thread calls `forgetContext`. Counts in parentheses (entry counts in the KB outline) are not announced: they
 * drift with every sweep. Subagent children are never frozen (`excludeFromFreeze`).
 */
import { createHash } from "node:crypto";
import { UNBOUND_CONTEXT } from "@wolfpack/memory";

/** A section's digest: what is compared and described, instead of the whole text. */
interface Digest {
  hash: string;
  /** Normalized list lines ("- ..."), for "+N: ..." in the notice. */
  items: string[];
  /** active_task only: `work-<d>-<ID> "Title"` or `unbound`. */
  state?: string;
}

interface Seen {
  /** What the model was last told (the frozen text, or the fresh text at the last announcement). */
  announced: Digest;
  /** The latest fresh render. */
  fresh: Digest;
  /** Re-render now: a bind or unbind between turns renders no section by itself. */
  refresh?: () => Promise<string | undefined> | string | undefined;
}

const seen = new Map<string, Map<string, Seen>>();
const unfrozen = new Set<string>();
const keyOf = (den: string, conversationId: string | number) => `${den}\u0000${conversationId}`;

/** How the model re-reads what a section carries. The notice grammar below is built from these exact names and tails. */
const HINTS: Record<string, string> = {
  wolf_memory: "read the topic files",
  wolf_memory_retired: "read the entries with kb_access",
  kb_access: "re-read the domain _digest.json",
  active_task: "call task_current",
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PART = String.raw`(?:${Object.keys(HINTS).map(escapeRe).join("|")}) changed(?: \([^\n]*?\))?; (?:${Object.values(HINTS).map(escapeRe).join("|")})`;
/** The generated notice line at the head of a user message (one shared form for the strip in superseded-note and injected-text). */
export const CONTEXT_NOTICE_HEAD = new RegExp(String.raw`^Context update: ${PART}(?:; ${PART})*\n\n`);

function unwrap(name: string, tagged: string): string {
  const open = `<${name}>\n`;
  const close = `\n</${name}>`;
  return tagged.startsWith(open) && tagged.endsWith(close) ? tagged.slice(open.length, tagged.length - close.length) : tagged;
}

const norm = (line: string) => line.trim().replace(/\((\d+)( entries)?\)/g, "()");
const keys = (text: string) => text.split("\n").map(norm).filter(Boolean);

/**
 * `work-<d>-<ID> "Title"` from the active-task header; `unbound` ONLY for the real unbound text (UNBOUND_CONTEXT from
 * unified-tasks.ts); undefined for anything else (an unknown shape is not announced as an unbind).
 */
function activeState(text: string): string | undefined {
  if (text.includes(UNBOUND_CONTEXT)) return "unbound";
  const m = /\[(work-[^\]\s]+)\] (.+?) \(kind: [^)\n]*\)/.exec(text);
  return m ? `${m[1]} "${m[2]}"` : undefined;
}

function digest(name: string, text: string): Digest {
  const lines = keys(text);
  return {
    hash: createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 16),
    items: lines.filter((l) => l.startsWith("- ")),
    ...(name === "active_task" ? { state: activeState(text) } : {}),
  };
}

/**
 * Active_task text that is not a state: the placeholder while the item loads into the cache, and the "Error: ..." text of a
 * failed render. Never frozen, never announced; the last good state is kept.
 */
const isTransient = (name: string, text: string) =>
  name === "active_task" && (/^## Active Task\n\nBound to \S+ \(loading\.\.\.\)/.test(text) || text.startsWith("## Active Task\n\nError:"));

/** Subagent children keep the old per-request behaviour: no freezing, no notice. */
export function excludeFromFreeze(den: string, conversationId: string | number): void {
  unfrozen.add(keyOf(den, conversationId));
}

/**
 * The text a frozen section renders now: the text the transcript already shows (`shown`, the tagged text) or, when the
 * conversation shows none yet (first request, after a compaction) or only the loading placeholder, the fresh render.
 * `refresh` re-renders the section later, when a notice is built.
 */
export function freezeSection(
  den: string,
  conversationId: string | number,
  name: string,
  fresh: string | undefined,
  shown: string | undefined,
  refresh?: Seen["refresh"],
): string | undefined {
  const k = keyOf(den, conversationId);
  if (unfrozen.has(k)) return fresh;
  const sections = seen.get(k) ?? new Map<string, Seen>();
  seen.set(k, sections);
  const prev = sections.get(name);
  const freshOk = fresh !== undefined && !isTransient(name, fresh);
  const freshDigest = freshOk ? digest(name, fresh) : undefined;
  const frozen = shown === undefined ? undefined : unwrap(name, shown);
  const r = refresh ? { refresh } : {};
  if (frozen === undefined || isTransient(name, frozen)) {
    // Nothing usable shown (first request, after a compaction, a placeholder or an error text): the fresh render is shown.
    if (freshDigest) sections.set(name, { announced: freshDigest, fresh: freshDigest, ...r });
    else if (prev) sections.set(name, { ...prev, ...r });
    return fresh;
  }
  // After a restart there is no memory of what was announced: the frozen text is what the model has.
  const announced = prev?.announced ?? digest(name, frozen);
  sections.set(name, { announced, fresh: freshDigest ?? prev?.fresh ?? announced, ...r });
  return frozen;
}

const head = (line: string) => line.replace(/^- /, "").replace(/\s+/g, " ").slice(0, 60);

function describe(name: string, a: Digest, f: Digest): string {
  if (name === "active_task") return `${name} changed${f.state ? ` (now ${f.state})` : ""}; ${HINTS[name]}`;
  const before = new Set(a.items);
  const after = new Set(f.items);
  const added = f.items.filter((l) => !before.has(l));
  const removed = a.items.filter((l) => !after.has(l));
  const counts = [added.length ? `+${added.length}` : "", removed.length ? `-${removed.length}` : ""].filter(Boolean).join(" ");
  const shown = added.slice(0, 3).map(head).join(", ");
  const detail = [counts, shown ? `: ${shown}` : ""].join("");
  return `${name} changed${detail ? ` (${detail})` : ""}; ${HINTS[name] ?? "re-read it"}`;
}

export interface PendingContextNotice {
  /** One line, "" when nothing changed. */
  text: string;
  /** Mark what was described as told; call after the message carrying the notice was accepted. */
  commit(): void;
}

/**
 * The notice due for this conversation: every frozen section whose fresh render differs from what the model was told.
 * The sections are re-rendered first (local file reads), so a bind or unbind between turns is seen.
 */
export async function pendingContextNotice(den: string, conversationId: string | number): Promise<PendingContextNotice> {
  const sections = seen.get(keyOf(den, conversationId));
  if (!sections) return { text: "", commit() {} };
  for (const [name, s] of sections) {
    if (!s.refresh) continue;
    try {
      const text = await s.refresh();
      if (text !== undefined && !isTransient(name, text)) s.fresh = digest(name, text);
    } catch { /* keep the last render */ }
  }
  const due = [...sections].filter(([, s]) => s.announced.hash !== s.fresh.hash);
  if (due.length === 0) return { text: "", commit() {} };
  const lines = due.map(([name, s]) => describe(name, s.announced, s.fresh));
  const fresh = due.map(([name, s]) => [name, s.fresh] as const);
  return {
    text: `Context update: ${lines.join("; ")}`,
    commit() {
      for (const [name, d] of fresh) {
        const s = sections.get(name);
        if (s) s.announced = d;
      }
    },
  };
}

/** A deleted or closed conversation frees its memory. */
export function forgetContext(den: string, conversationId: string | number): void {
  seen.delete(keyOf(den, conversationId));
  unfrozen.delete(keyOf(den, conversationId));
}
