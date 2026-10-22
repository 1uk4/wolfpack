/**
 * Den-topic durability gate — deterministic, no LLM.
 *
 * Den topics are promoted into the shared KB as durable knowledge (what is
 * true / how it works / what was decided). Session logs ("Week 43 planning",
 * per-workout logs, "today we fixed X") must stay in the den as private working
 * memory. This scores a topic on cheap log signals; the threshold is
 * conservative so a normal topic that merely mentions a date or a commit never
 * trips it — it takes several signals together.
 */

export interface TopicQuality {
  /** True when the topic reads as durable knowledge and may be promoted. */
  promotable: boolean;
  /** Why it failed (empty when promotable). */
  reason: string;
  score: number;
}

/** A topic scoring at or above this is treated as a session log. */
export const LOG_SCORE_THRESHOLD = 4;

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const ISO_DATE = "\\d{4}-\\d{2}-\\d{2}";
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b`, "i");
const DATED = new RegExp(`${ISO_DATE}|${MONTH_DAY.source}|\\bweek\\s+\\d{1,2}\\b|\\bday\\s+\\d+\\b`, "i");
const ISO_TIMESTAMP = new RegExp(`${ISO_DATE}[ T]\\d{2}:\\d{2}`, "g");
const SESSION_WORDS = /\b(?:today|yesterday|tonight|this (?:session|morning|afternoon|evening)|earlier today|just now|just (?:fixed|added|shipped))\b/gi;
const COMMIT_HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
const DATE_LABEL_LINE = /^\W*(?:date|started|ended|finished|session|time)\W*:/i;
const PAST_BULLET = /^\s*[-*]\s+(?:\*\*)?(?:fixed|added|removed|implemented|created|updated|deployed|merged|ran|completed|renamed|moved|changed|refactored|wrote|built|tested|committed|pushed|installed|configured|deleted|investigated|debugged|discovered|found)\b/i;
const BULLET = /^\s*[-*]\s+\S/;

/** Score a topic. Title and summary are checked too: a dated title is the clearest tell. */
export function assessTopic(topic: { title?: string; summary?: string; body: string }): TopicQuality {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  const title = topic.title ?? "";
  const lines = topic.body.split("\n");
  let inFence = false;
  const prose: string[] = [];
  for (const l of lines) {
    if (/^\s*```/.test(l)) { inFence = !inFence; continue; }
    if (!inFence) prose.push(l);
  }
  const text = prose.join("\n");

  if (DATED.test(title) || /\b(?:session|workout|daily|standup|diary)\s+log\b|\blog\b.*\b(?:session|workout)\b/i.test(title)) {
    add(2.5, `dated/log-style title ${JSON.stringify(title)}`);
  }

  const datedHeadings = prose.filter((l) => /^#{1,6}\s/.test(l) && DATED.test(l) && !/^#\s/.test(l)).length;
  if (datedHeadings > 0) add(Math.min(datedHeadings, 4) * 1.5, `${datedHeadings} dated heading(s)`);

  const labels = prose.filter((l) => DATE_LABEL_LINE.test(l.replace(/^\s*(?:[-*]\s+|#{1,6}\s+)/, "")) && DATED.test(l)).length;
  if (labels > 0) add(1.5, "date/session label line");
  if (prose.some((l) => /^#{1,6}\s+session\b/i.test(l))) add(1, "session heading");

  const stamps = text.match(ISO_TIMESTAMP)?.length ?? 0;
  if (stamps > 0) add(Math.min(stamps, 4), `${stamps} ISO timestamp(s)`);

  const rel = text.match(SESSION_WORDS)?.length ?? 0;
  if (rel > 0) add(Math.min(rel, 4) * 0.75, `${rel} session-relative phrase(s)`);

  const hashes = text.match(COMMIT_HASH)?.length ?? 0;
  if (hashes >= 5) add(2, `${hashes} commit-hash-like token(s)`);

  const bullets = prose.filter((l) => BULLET.test(l)).length;
  const past = prose.filter((l) => PAST_BULLET.test(l)).length;
  if (bullets >= 6 && past >= 5 && past / bullets >= 0.6) add(LOG_SCORE_THRESHOLD, `${past}/${bullets} bullets are past-tense actions`);

  const promotable = score < LOG_SCORE_THRESHOLD;
  return { promotable, reason: promotable ? "" : `reads as a session log: ${reasons.join("; ")}`, score };
}

// ── Trivial re-promote detection ─────────────────────────────────────────────

/** Whitespace/punctuation/case-insensitive form of a body. */
export function normalizeBody(body: string): string {
  return body.toLowerCase().replace(/[^\p{L}\p{N}\n]+/gu, " ").replace(/ *\n */g, "\n").replace(/\n+/g, "\n").trim();
}

/** Share of changed lines at or below which a re-promote is not worth emitting. */
export const TRIVIAL_CHANGE_RATIO = 0.05;

/**
 * True when `next` differs from `prev` only trivially: identical after
 * normalization, or (for bodies of 30+ lines) at most 5% of lines changed.
 */
export function isTrivialChange(prev: string, next: string): boolean {
  const a = normalizeBody(prev);
  const b = normalizeBody(next);
  if (a === b) return true;
  const al = a.split("\n");
  const bl = b.split("\n");
  const total = Math.max(al.length, bl.length);
  if (total < 30) return false;
  const counts = new Map<string, number>();
  for (const l of al) counts.set(l, (counts.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of bl) {
    const n = counts.get(l) ?? 0;
    if (n > 0) { common++; counts.set(l, n - 1); }
  }
  return (total - common) / total <= TRIVIAL_CHANGE_RATIO;
}
