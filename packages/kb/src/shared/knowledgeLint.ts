/**
 * Knowledge lint — deterministic checks that a piece of text is durable
 * knowledge, not changelog. One module, shared by the wolf side (distill at
 * promote) and Dewey (after produce). No LLM, no I/O.
 *
 * Findings carry a short machine-readable `code` and a human `message`.
 * `strippable` findings can be removed deterministically (stripKnowledge);
 * the rest need a rewrite (retry) or a hold-back.
 */

import { KB_TITLE_MAX } from "@wolfpack/engine";

export type LintCode =
  | "commit-hash"
  | "work-id"
  | "test-count"
  | "deploy-status"
  | "dated-heading"
  | "oversize"
  | "long-title"
  | "lede-repeat"
  | "broken-link"
  | "forbidden-property";

export interface LintFinding {
  code: LintCode;
  message: string;
  /** Offending text (clipped), for the retry prompt and logs. */
  sample?: string;
}

/** The one body size cap in chars, History excluded. Every size rule (lint, merge limit, split) derives from it. */
export const BODY_CAP = 6000;
/** Alias of BODY_CAP kept for existing importers. */
export const DEFAULT_BODY_CAP = BODY_CAP;

/** Property keys that carry progress noise, never knowledge. */
export const FORBIDDEN_PROPERTY = /^(?:commits?|commit-.+|.+-commits?|test-?counts?|tests?|tests?-.+|.+-tests?|scores?|.+-scores?|score-.+|tasks?|task-.+|work-?ids?|work-item.*)$/i;

export interface LintInput {
  title?: string;
  /** The lede (summary). Checked for repetition in the body. */
  summary?: string;
  body: string;
  properties?: Record<string, unknown>;
  /** Body cap override (chars, History excluded). */
  cap?: number;
  /** Chars outside `body` that count toward the cap (the rendered lede). */
  extraChars?: number;
  /**
   * Where a work id (work-<domain>-<id>) may appear. "history" (default): only
   * in History lines, where graduated work cites itself. "none": nowhere (a den
   * topic never carries one).
   */
  workIds?: "history" | "none";
  /**
   * Every live entry id (any domain). When given, a `[[target]]` whose target is
   * not in the set is a "broken-link" finding (placeholders included).
   */
  liveIds?: ReadonlySet<string>;
}

const HASH_TOKEN = /(?<![\w./~-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/g;
const HASH_CONTEXT = /\b(?:commits?|sha|hash(?:es)?|merged?|reverted?|cherry-?pick(?:ed)?|landed|rebased?|pushed|fixed (?:in|by)|shipped in)\b/i;
const WORK_ID = /\bwork-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7}\b/;
const TASK_ID = /\b[Tt]asks?\s+#?(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{7}\b/;
const TEST_COUNT: RegExp[] = [
  /\b\d{2,}\s+(?:(?:unit|vitest|integration|new|total)\s+)?tests?\s+(?:pass|passes|passing|passed|green|ok)\b/i,
  /\b(?:all\s+)?\d{2,}\s*(?:\/\s*\d+\s*)?tests?\b.*\b(?:pass|green)/i,
  /\b(?:suite|tests?|vitest|build)\s+(?:is\s+|are\s+)?green\b/i,
  /\(\s*\d{2,}\s+tests?\s*\)/i,
  /\btests?:\s*\d{2,}\b/i,
];
/** How `scrubDeployStatus` handles a form: drop a parenthetical, strip a leading label, drop the whole sentence, or leave it to the retry. */
type ScrubMode = "paren" | "lead" | "sentence" | "none";
const DEPLOY_STATUS: Array<{ re: RegExp; scrub: ScrubMode }> = [
  { re: /\((?:deployed|verified|shipped|merged on main|live)(?:\s+(?:to|on)\s+[^)]*)?\)/i, scrub: "paren" },
  { re: /\b(?:deployed|shipped|rolled out|released)\s+(?:to|on|in)\s+(?:the\s+)?(?:vps|prod(?:uction)?|dewey|live|hal|mirror)\b/i, scrub: "sentence" },
  { re: /\bverified\s+(?:live|on the vps|in prod(?:uction)?|end-to-end|working|green)\b/i, scrub: "sentence" },
  { re: /\b(?:status|state)\s*:\s*(?:deployed|verified|shipped|done|complete[d]?)\b/i, scrub: "sentence" },
  { re: /^\W*(?:\*\*)?(?:deployed|verified|shipped|live)\b(?:\*\*)?\s*[:\-–—]/i, scrub: "lead" },
  { re: /\b(?:needs?|awaiting|pending)\s+(?:a\s+)?(?:deploy|sync|restart)\b/i, scrub: "sentence" },
];
const hasDeployStatus = (line: string) => DEPLOY_STATUS.some((e) => e.re.test(line));
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATED_HEADING = new RegExp(`^#{2,6}\\s.*(?:\\d{4}-\\d{2}-\\d{2}|\\b${MONTH}\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+${MONTH}\\b|\\bweek\\s+\\d{1,2}\\b)`, "i");

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Split a body into the part before its final `## History` section, and the History. */
export function splitHistory(body: string): { main: string; history: string } {
  const m = /^## History[ \t]*$/m.exec(body);
  if (!m) return { main: body, history: "" };
  return { main: body.slice(0, m.index), history: body.slice(m.index) };
}

/** Lines outside code fences, with their text. */
function proseLines(text: string): string[] {
  let fenced = false;
  const out: string[] = [];
  for (const l of text.split("\n")) {
    if (/^\s*```/.test(l)) { fenced = !fenced; continue; }
    if (!fenced) out.push(l);
  }
  return out;
}

/** The commit-hash-like tokens of one line that the lint counts (wrapped, or the line is in commit context), with their offsets. */
function hashMatches(line: string): Array<{ token: string; at: number }> {
  const out: Array<{ token: string; at: number }> = [];
  for (const m of line.matchAll(HASH_TOKEN)) {
    const at = m.index ?? 0;
    const wrapped = /[`(]/.test(line[at - 1] ?? "") || /(?:^|[(;,]\s*(?:follow-up\s+)?)$/.test(line.slice(0, at)) && /[`);,]/.test(line[at + m[0].length] ?? "");
    if (wrapped || HASH_CONTEXT.test(line)) out.push({ token: m[0], at });
  }
  return out;
}

/** True when `line` holds a commit-hash-like token in commit context. */
function hashIn(line: string): string | undefined {
  return hashMatches(line)[0]?.token;
}

/** The commit hashes the lint would flag in `text` (prose lines, outside code fences). */
export function findCommitHashes(text: string): string[] {
  return proseLines(text).flatMap((l) => hashMatches(l).map((h) => h.token));
}

/** Replace every commit hash the lint would flag with `replacement`; fenced code is left as is. */
export function scrubCommitHashes(text: string, replacement = "a commit"): string {
  let fenced = false;
  return text
    .split("\n")
    .map((l) => {
      if (/^\s*```/.test(l)) { fenced = !fenced; return l; }
      if (fenced) return l;
      let out = l;
      for (const h of hashMatches(l).reverse()) out = out.slice(0, h.at) + replacement + out.slice(h.at + h.token.length);
      return out;
    })
    .join("\n");
}

// A leading label: a prefix (quote, heading or bullet marks), the status word with optional bold, a colon (or a spaced dash).
const LEAD_LABEL = /^(\W*?)(\*\*)?(?:deployed|verified|shipped|live)(\*\*)?\s*(?::|[-–—](?=\s))\s*(\*\*)?\s*/i;
const LINE_PREFIX = /^\s*(?:(?:[-*+>]|#{1,6}|\d+[.)])\s+)*/;
const inCode = (s: string, at: number) => (s.slice(0, at).match(/`/g)?.length ?? 0) % 2 === 1;

/** Remove each status parenthetical (and the space before it) outside inline code. */
function dropParens(line: string, re: RegExp): string {
  const g = new RegExp(`\\s*${re.source}`, "gi");
  const out = line.replace(g, (m, off: number) => (inCode(line, off + m.length - m.trimStart().length) ? m : ""));
  return out !== line && !/^\s/.test(line) ? out.trimStart() : out;
}

/** Strip a leading status label, keeping the line prefix and any `**` that was not the label's own. */
function stripLead(line: string): string {
  const m = LEAD_LABEL.exec(line);
  if (!m) return line;
  const [all, pre, open, close, after] = m;
  const keepBold = after && !(open && !close) ? "**" : "";
  let rest = line.slice(all.length);
  if (!keepBold && /^[a-z][a-z]/.test(rest)) rest = rest[0].toUpperCase() + rest.slice(1);
  return pre + keepBold + rest;
}

/** Drop the whole sentence around the first match of `re` outside inline code. Null when nothing matched. */
function dropSentence(line: string, re: RegExp): string | null {
  if (/^\s*\|/.test(line)) return null;
  const m = new RegExp(re.source, "i").exec(line);
  if (!m || inCode(line, m.index)) return null;
  const prefixLen = LINE_PREFIX.exec(line)![0].length;
  let start = prefixLen;
  for (const b of line.slice(prefixLen, m.index).matchAll(/[.!?]\s+/g)) start = prefixLen + (b.index ?? 0) + b[0].length;
  const from = m.index + m[0].length;
  const stop = /[.!?](?=\s|$)/.exec(line.slice(from));
  const rest = stop ? line.slice(from + stop.index + 1) : "";
  const before = line.slice(0, start);
  if (rest.trim() === "") return (start > prefixLen ? before.trimEnd() : before) + rest;
  return before + rest.trimStart();
}

/** "needs a restart" is usually a real fact: reworded to "takes effect after a restart" (the lint's restart form), never dropped. */
function rewordRestart(line: string): string {
  return line.replace(/\b(needs?)\s+(?:a\s+)?restart\b/gi, (_m, verb: string) => {
    const take = verb.toLowerCase() === "needs" ? "takes" : "take";
    return `${verb[0] === verb[0].toUpperCase() ? take[0].toUpperCase() + take.slice(1) : take} effect after a restart`;
  });
}

function scrubStatusLine(line: string): string {
  let out = rewordRestart(line);
  for (let pass = 0; pass < 6 && hasDeployStatus(out); pass++) {
    let next = out;
    for (const e of DEPLOY_STATUS) if (e.scrub === "paren") next = dropParens(next, e.re);
    if (DEPLOY_STATUS.some((e) => e.scrub === "lead" && e.re.test(next))) next = stripLead(next);
    if (next === out) {
      for (const e of DEPLOY_STATUS) {
        if (e.scrub !== "sentence") continue;
        const dropped = dropSentence(next, e.re);
        if (dropped !== null) { next = dropped; break; }
      }
    }
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Remove the deploy/verified status wording the lint flags from the current-state
 * part of `text` (everything before `## History`; fenced code is left as is).
 * Only forms that come out clean are edited: a status parenthetical, a leading
 * `Shipped:` label, or the whole sentence holding the phrase. Text is never cut
 * out of the middle of a clause, and "needs a restart" is left for the retry. A
 * line left with nothing but marks is dropped.
 */
export function scrubDeployStatus(text: string): string {
  const { main, history } = splitHistory(text);
  let fenced = false;
  const kept: string[] = [];
  for (const l of main.split("\n")) {
    if (/^\s*```/.test(l)) { fenced = !fenced; kept.push(l); continue; }
    if (fenced) { kept.push(l); continue; }
    const out = scrubStatusLine(l);
    if (out !== l && !/[\p{L}\p{N}]/u.test(out)) continue;
    kept.push(out);
  }
  return kept.join("\n") + history;
}

export function lintKnowledge(input: LintInput): LintFinding[] {
  const findings: LintFinding[] = [];
  const add = (code: LintCode, message: string, sample?: string) =>
    findings.push({ code, message, ...(sample ? { sample: clip(sample) } : {}) });
  const { main } = splitHistory(input.body);

  // Commit hashes and task ids are noise anywhere, History included. A work id
  // is allowed in History lines only (graduated work cites itself there); in the
  // body, title, summary and properties it is noise.
  const all = proseLines(input.body);
  const hashes = new Set<string>();
  let workId: string | undefined;
  const historyAt = input.workIds === "none" ? -1 : input.body.search(/^## History[ \t]*$/m);
  const historyStart = historyAt < 0 ? Infinity : proseLines(input.body.slice(0, historyAt)).length;
  all.forEach((l, i) => {
    const h = hashIn(l);
    if (h) hashes.add(h);
    const w = (i < historyStart ? WORK_ID.exec(l) : null) ?? TASK_ID.exec(l);
    if (w && !workId) workId = w[0];
  });
  if (!workId) {
    const others = [input.title ?? "", input.summary ?? "", ...Object.entries(input.properties ?? {}).flatMap(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v ?? "")])];
    workId = others.map((t) => WORK_ID.exec(t)?.[0]).find(Boolean);
  }
  if (hashes.size) add("commit-hash", `${hashes.size} commit-hash-like token(s): ${[...hashes].slice(0, 3).join(", ")}`, [...hashes][0]);
  if (workId) add("work-id", `task/work id in the text: ${workId}`, workId);

  // Progress lines and dated headings belong to the current-state part; a
  // History line is allowed to carry a date.
  const lines = proseLines(main);
  const testLine = lines.find((l) => TEST_COUNT.some((r) => r.test(l)));
  if (testLine) add("test-count", "test-count / suite-status line", testLine.trim());
  const deployLine = lines.find(hasDeployStatus);
  if (deployLine) add("deploy-status", "deploy/verified status line", deployLine.trim());
  const heads = lines.filter((l) => DATED_HEADING.test(l));
  if (heads.length) add("dated-heading", `${heads.length} dated heading(s) in the body (dates belong in History)`, heads[0].trim());

  const cap = input.cap ?? DEFAULT_BODY_CAP;
  const size = main.length + (input.extraChars ?? 0);
  if (size > cap) add("oversize", `body is ${size} chars (History excluded), cap is ${cap}`);

  if (input.title && input.title.length > KB_TITLE_MAX) add("long-title", `title is ${input.title.length} chars, the limit is ${KB_TITLE_MAX}: make it a short noun phrase`, input.title);

  if (input.summary && ledeRepeated(input.summary, main)) add("lede-repeat", "the lede paragraph is repeated in the body", input.summary);

  if (input.liveIds) {
    const broken = brokenLinks([input.summary ?? "", input.body].join("\n"), input.liveIds);
    if (broken.length) add("broken-link", `${broken.length} wikilink(s) to no existing entry: ${broken.slice(0, 3).join(", ")}`, broken[0]);
  }

  for (const key of Object.keys(input.properties ?? {})) {
    if (FORBIDDEN_PROPERTY.test(key)) add("forbidden-property", `property "${key}" carries progress noise`, key);
  }
  return findings;
}

const WIKILINK = /\[\[([^\]\n]*)\]\]/g;
const linkTarget = (inner: string) => inner.split("|")[0].split("#")[0].trim();

function linkTargetsIn(text: string, keepEmpty: boolean): string[] {
  const out: string[] = [];
  for (const l of proseLines(text)) {
    for (const m of l.matchAll(WIKILINK)) {
      const t = linkTarget(m[1]);
      if ((t || keepEmpty) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** Targets of the `[[…]]` links in `text` (outside code fences), in order, unique; empty targets are skipped. */
export const wikilinkTargets = (text: string): string[] => linkTargetsIn(text, false);

/** Targets of the `[[…]]` links in `text` (outside code fences) that are not in `live`; an empty `[[]]` target is flagged. */
export function brokenLinks(text: string, live: ReadonlySet<string>): string[] {
  return linkTargetsIn(text, true).filter((t) => !live.has(t));
}

/**
 * Replace each `[[target|text]]` whose target is not in `live` by its text
 * (`[[target]]` → target), leaving the rest. Lines in `keep` (carried over from
 * the previous entry) and code fences are left alone.
 */
export function stripBrokenLinks(text: string, live: ReadonlySet<string>, keep?: ReadonlySet<string>): { text: string; stripped: string[] } {
  const stripped: string[] = [];
  let fenced = false;
  const out = text.split("\n").map((l) => {
    if (/^\s*```/.test(l)) { fenced = !fenced; return l; }
    if (fenced || keep?.has(l.trim())) return l;
    return l.replace(WIKILINK, (all, inner: string) => {
      if (live.has(linkTarget(inner))) return all;
      stripped.push(linkTarget(inner));
      const alias = inner.includes("|") ? inner.split("|").slice(1).join("|").trim() : "";
      return alias || linkTarget(inner);
    });
  });
  return { text: out.join("\n"), stripped };
}

/** True when a paragraph of `body` equals the lede (normalized). */
function ledeRepeated(summary: string, body: string): boolean {
  const lede = norm(summary);
  if (lede.length < 30) return false;
  return body.split(/\n\s*\n/).some((p) => !p.trimStart().startsWith("#") && norm(p) === lede);
}

/** Drop forbidden property keys. */
export function stripProperties<T extends Record<string, unknown>>(props: T | undefined): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) if (!FORBIDDEN_PROPERTY.test(k)) out[k] = v;
  return out as T;
}

/** Drop the paragraphs of `body` that repeat the lede. */
export function stripLedeRepeat(summary: string, body: string): string {
  const lede = norm(summary);
  if (lede.length < 30) return body;
  return body
    .split(/\n\s*\n/)
    .filter((p) => p.trimStart().startsWith("#") || norm(p) !== lede)
    .join("\n\n")
    .replace(/^\s+/, "");
}

/** Drop a `## Detail` wrapper heading line (the renderer adds its own). */
export function stripDetailHeading(body: string): string {
  return body.replace(/^## Detail[ \t]*\n+/m, "");
}

/** Codes that need a rewrite or a hold-back (not safely strippable). */
export const HARD_CODES: ReadonlySet<LintCode> = new Set<LintCode>(["commit-hash", "work-id", "test-count", "deploy-status", "dated-heading", "broken-link"]);

export const hardFindings = (f: LintFinding[]): LintFinding[] => f.filter((x) => HARD_CODES.has(x.code));

/** One line per finding, for a retry prompt. */
export function describeFindings(f: LintFinding[]): string {
  return f.map((x) => `- ${x.code}: ${x.message}${x.sample ? ` (e.g. "${x.sample}")` : ""}`).join("\n");
}
