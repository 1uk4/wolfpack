/**
 * Knowledge lint — deterministic checks that a piece of text is durable
 * knowledge, not changelog. One module, shared by the wolf side (distill at
 * promote) and Dewey (after produce). No LLM, no I/O.
 *
 * Findings carry a short machine-readable `code` and a human `message`.
 * `strippable` findings can be removed deterministically (stripKnowledge);
 * the rest need a rewrite (retry) or a hold-back.
 */

export type LintCode =
  | "commit-hash"
  | "work-id"
  | "test-count"
  | "deploy-status"
  | "dated-heading"
  | "oversize"
  | "lede-repeat"
  | "forbidden-property";

export interface LintFinding {
  code: LintCode;
  message: string;
  /** Offending text (clipped), for the retry prompt and logs. */
  sample?: string;
}

/** Body size cap in chars, History excluded. */
export const DEFAULT_BODY_CAP = 6000;

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
const DEPLOY_STATUS: RegExp[] = [
  /\((?:deployed|verified|shipped|merged on main|live)(?:\s+(?:to|on)\s+[^)]*)?\)/i,
  /\b(?:deployed|shipped|rolled out|released)\s+(?:to|on|in)\s+(?:the\s+)?(?:vps|prod(?:uction)?|dewey|live|hal|mirror)\b/i,
  /\bverified\s+(?:live|on the vps|in prod(?:uction)?|end-to-end|working|green)\b/i,
  /\b(?:status|state)\s*:\s*(?:deployed|verified|shipped|done|complete[d]?)\b/i,
  /^\W*(?:\*\*)?(?:deployed|verified|shipped|live)\b(?:\*\*)?\s*[:\-–—]/i,
  /\b(?:needs?|awaiting|pending)\s+(?:a\s+)?(?:deploy|sync|restart)\b/i,
];
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

/** True when `line` holds a commit-hash-like token in commit context. */
function hashIn(line: string): string | undefined {
  for (const m of line.matchAll(HASH_TOKEN)) {
    const at = m.index ?? 0;
    const wrapped = /[`(]/.test(line[at - 1] ?? "") || /(?:^|[(;,]\s*(?:follow-up\s+)?)$/.test(line.slice(0, at)) && /[`);,]/.test(line[at + m[0].length] ?? "");
    if (wrapped || HASH_CONTEXT.test(line)) return m[0];
  }
  return undefined;
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
  const deployLine = lines.find((l) => DEPLOY_STATUS.some((r) => r.test(l)));
  if (deployLine) add("deploy-status", "deploy/verified status line", deployLine.trim());
  const heads = lines.filter((l) => DATED_HEADING.test(l));
  if (heads.length) add("dated-heading", `${heads.length} dated heading(s) in the body (dates belong in History)`, heads[0].trim());

  const cap = input.cap ?? DEFAULT_BODY_CAP;
  const size = main.length + (input.extraChars ?? 0);
  if (size > cap) add("oversize", `body is ${size} chars (History excluded), cap is ${cap}`);

  if (input.summary && ledeRepeated(input.summary, main)) add("lede-repeat", "the lede paragraph is repeated in the body", input.summary);

  for (const key of Object.keys(input.properties ?? {})) {
    if (FORBIDDEN_PROPERTY.test(key)) add("forbidden-property", `property "${key}" carries progress noise`, key);
  }
  return findings;
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
export const HARD_CODES: ReadonlySet<LintCode> = new Set<LintCode>(["commit-hash", "work-id", "test-count", "deploy-status", "dated-heading"]);

export const hardFindings = (f: LintFinding[]): LintFinding[] => f.filter((x) => HARD_CODES.has(x.code));

/** One line per finding, for a retry prompt. */
export function describeFindings(f: LintFinding[]): string {
  return f.map((x) => `- ${x.code}: ${x.message}${x.sample ? ` (e.g. "${x.sample}")` : ""}`).join("\n");
}
