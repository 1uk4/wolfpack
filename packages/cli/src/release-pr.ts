/**
 * Title and body of a release PR from a wolf branch into `stable` (`wolfpack pr prepare`).
 * Pure: structured inputs in, markdown out. Git, gh and the work API live in pr-prepare.ts.
 * A missing input renders as an explicit "not provided" line, never silently dropped.
 */

/** GitHub rejects PR bodies and comments above this size. We count UTF-8 bytes, which is never less than the characters it counts. */
export const PR_BODY_LIMIT = 65_536;
/** Headroom under the limit, so a counting difference on GitHub's side cannot reject the body. */
const BODY_MARGIN = 512;
const BODY_BUDGET = PR_BODY_LIMIT - BODY_MARGIN;

export interface ReleaseFeature {
  /** Feature work item, `work-<domain>-<id>`. */
  id: string;
  title: string;
  /** From the feature document's `## Release notes` section; undefined = not provided. */
  risk?: string;
  manualChecks?: string[];
  /** Mermaid source without the fence; undefined = not provided. */
  diagram?: string;
  /** Image URLs; empty = not provided. */
  screenshots: string[];
  /** Set instead of `screenshots` when screenshot files exist but cannot be linked. */
  screenshotsNote?: string;
  /** The full feature document; undefined or blank = not provided. */
  document?: string;
}

export interface ReleaseInput {
  wolf: string;
  /** YYYY-MM-DD */
  date: string;
  /** stable's tip before this release, for the rollback line. */
  previousStable: string;
  features: ReleaseFeature[];
  /** One line per commit not tied to a feature. */
  otherCommits: string[];
  /** Test and build results; undefined = not provided. */
  tests?: string;
  /** CI result; undefined = not provided. */
  ci?: string;
  /** Work items that could not be read (network or status error, not "unknown"); named in the Decide header. */
  unreadable?: string[];
  /** What ran of the live/eval gates, as a short phrase. */
  liveEval: string;
}

const NOT_PROVIDED = "_not provided_";
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

export interface ParsedFeatureDoc {
  diagram: string | undefined;
  risk: string | undefined;
  manualChecks: string[] | undefined;
  /** The document without the diagram block; undefined when there is no document. */
  document: string | undefined;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Split a feature's working document into the parts the PR shows: the first line-anchored ```mermaid block that is not
 * inside another fence (the diagram), and `Risk:` / `Manual checks:` from the first `## Release notes` heading outside any
 * fence. CRLF is tolerated. The notes stay in the document. `Risk:` is one line.
 */
export function parseFeatureDoc(markdown: string | null | undefined): ParsedFeatureDoc {
  if (markdown == null) return { diagram: undefined, risk: undefined, manualChecks: undefined, document: undefined };
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");

  // One pass: which lines are plain text (outside every fence, and not a fence line), and where the first mermaid block sits.
  const plain: boolean[] = [];
  let open: { ch: string; len: number } | null = null;
  let start = -1;
  let block: { start: number; end: number } | null = null;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    const m = FENCE.exec(line);
    if (open === null) {
      plain[k] = !m;
      if (m) {
        open = { ch: m[1]![0]!, len: m[1]!.length };
        if (block === null && start < 0 && /^```mermaid[ \t]*$/.test(line)) start = k;
      }
    } else {
      plain[k] = false;
      if (m && m[1]![0] === open.ch && m[1]!.length >= open.len && m[2]!.trim() === "") {
        if (start >= 0 && block === null) block = { start, end: k };
        open = null;
      }
    }
  }

  const diagram = block ? lines.slice(block.start + 1, block.end).join("\n").trim() || undefined : undefined;
  let kept = block ? [...lines.slice(0, block.start), ...lines.slice(block.end + 1)] : lines;
  if (block && kept[block.start]?.trim() === "") kept = [...kept.slice(0, block.start), ...kept.slice(block.start + 1)];
  const document = kept.join("\n").trim() || undefined;

  // Release notes: from the heading to the next level 1-2 heading, both outside fences.
  const from = lines.findIndex((l, k) => plain[k] && /^##[ \t]+Release notes[ \t]*$/i.test(l));
  const section: string[] = [];
  if (from >= 0) {
    for (let k = from + 1; k < lines.length; k++) {
      if (plain[k] && /^#{1,2}[ \t]/.test(lines[k]!)) break;
      if (plain[k]) section.push(lines[k]!);
    }
  }
  const risk = section.map((l) => /^Risk:[ \t]*(.+)$/i.exec(l)?.[1]?.trim()).find(Boolean);
  let manualChecks: string[] | undefined;
  const at = section.findIndex((l) => /^Manual checks:[ \t]*$/i.test(l));
  if (at >= 0) {
    const items: string[] = [];
    for (const line of section.slice(at + 1)) {
      const item = /^\s*[-*][ \t]+(.+)$/.exec(line)?.[1]?.trim();
      if (item) items.push(item);
      else if (line.trim() || items.length) break;
    }
    if (items.length) manualChecks = items;
  }
  return { diagram, risk, manualChecks, document };
}

export function releaseTitle(i: Pick<ReleaseInput, "wolf" | "date" | "features">): string {
  const n = i.features.length;
  return `Release ${i.wolf} ${i.date}: ${n} ${n === 1 ? "feature" : "features"}`;
}

const label = (f: ReleaseFeature) => `${f.title} (${f.id})`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function riskLines(i: ReleaseInput): string[] {
  return i.features.length ? ["- **Risk:**", ...i.features.map((f) => `  - ${label(f)}: ${f.risk ?? NOT_PROVIDED}`)] : ["- **Risk:** no features"];
}

function checkLines(i: ReleaseInput): string[] {
  return i.features.length
    ? ["- **Manual checks:**", ...i.features.flatMap((f) => (f.manualChecks?.length ? [`  - ${label(f)}:`, ...f.manualChecks.map((c) => `    - ${c}`)] : [`  - ${label(f)}: ${NOT_PROVIDED}`]))]
    : ["- **Manual checks:** no features"];
}

/** How much of the header's growing lists lives in the first comment: nothing, the Risk/Manual checks lists, or those and the unreadable IDs. */
type Moved = 0 | 1 | 2;

function decideHeader(i: ReleaseInput, moved: Moved): string {
  const n = i.features.length;
  return [
    "## Decide",
    `- **Merging does:** brings ${plural(n, "feature", "features")} and ${i.otherCommits.length} other commit(s) from \`wolf/${i.wolf}\` into \`stable\`, the branch the wolves run from. Merge with a **merge commit**.`,
    ...(i.unreadable?.length
      ? [
          moved === 2
            ? `- ⚠ ${i.unreadable.length} work ${i.unreadable.length === 1 ? "item" : "items"} could not be read; IDs in the first comment (their commits are under Other commits)`
            : `- ⚠ ${i.unreadable.length} work ${i.unreadable.length === 1 ? "item" : "items"} could not be read: ${i.unreadable.join(", ")}; their commits are under Other commits`,
        ]
      : []),
    ...(moved ? [`- Risk and manual checks for ${plural(n, "feature", "features")}: see the first comment`] : riskLines(i)),
    `- **Rollback:** \`git revert -m 1 <merge sha>\`. Previous stable (at prepare time): \`${i.previousStable}\`.`,
    ...(moved ? [] : checkLines(i)),
  ].join("\n");
}

function totals(i: ReleaseInput): string {
  return ["## Tests and CI", `- Tests: ${i.tests ?? NOT_PROVIDED}`, `- CI: ${i.ci ?? NOT_PROVIDED}`, `- live/eval: ${i.liveEval}`].join("\n");
}

function featureSection(f: ReleaseFeature, doc: string): string {
  const diagram = f.diagram?.trim() ? "```mermaid\n" + f.diagram.trim() + "\n```" : `Diagram: ${NOT_PROVIDED}`;
  const shots = f.screenshots.length ? f.screenshots.map((s) => `![${f.id} screenshot](${s})`).join("\n") : `Screenshots: ${f.screenshotsNote ?? NOT_PROVIDED}`;
  // An author's unclosed fence must not swallow whatever comes after this section.
  const open = openFence(doc.split("\n"));
  return [`### ${label(f)}`, diagram, shots, open ? `${doc}\n${open.ch.repeat(open.len)}` : doc].join("\n\n");
}

function otherCommits(i: ReleaseInput): string {
  return ["## Other commits", ...(i.otherCommits.length ? i.otherCommits.map((c) => `- ${c}`) : ["none"])].join("\n");
}

/** The longest prefix of `s` that fits in `max` UTF-8 bytes, cut on a code point (never inside a surrogate pair). */
function cutBytes(s: string, max: number): string {
  let used = 0;
  let end = 0;
  for (const ch of s) {
    const b = bytes(ch);
    if (used + b > max) break;
    used += b;
    end += ch.length;
  }
  return s.slice(0, end);
}

interface Fence {
  /** The opening line as written, e.g. "```mermaid"; reopened verbatim in the next comment. */
  line: string;
  ch: string;
  len: number;
}

/** The fence still open after these lines, or null when every fence is closed. A closing fence carries no info string. */
function openFence(lines: string[]): Fence | null {
  let open: Fence | null = null;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const ch = m[1]![0]!;
    if (open === null) open = { line, ch, len: m[1]!.length };
    else if (ch === open.ch && m[1]!.length >= open.len && m[2]!.trim() === "") open = null;
  }
  return open;
}

/**
 * One section that does not fit in a single comment, cut at line boundaries into parts that each fit. A fence open at a cut
 * is closed at the end of the part and reopened, with the same opener line, at the start of the next. A single line longer
 * than a comment is cut on a code point. Every part starts with "_<label> (part i/n)_".
 */
function splitSection(label: string, text: string): string[] {
  const queue = text.split("\n");
  const parts: { reopen: Fence | null; lines: string[] }[] = [];
  let carry: Fence | null = null;
  while (queue.length) {
    const reopen = carry;
    // Room for the part marker line (9 spare bytes cover "part 99/99"), the reopened opener and the closing fence.
    const overhead = bytes(label) + 40 + (reopen ? bytes(reopen.line) + 1 : 0) + (reopen ? reopen.len : 16) + 2;
    const room = Math.max(1_000, BODY_BUDGET - overhead);
    const lines: string[] = [];
    let used = 0;
    while (queue.length) {
      const line = queue[0]!;
      const add = bytes(line) + (lines.length ? 1 : 0);
      if (used + add <= room) {
        lines.push(queue.shift()!);
        used += add;
        continue;
      }
      if (!lines.length) {
        const piece = cutBytes(line, room) || String.fromCodePoint(line.codePointAt(0)!);
        lines.push(piece);
        queue[0] = line.slice(piece.length);
        if (queue[0] === "") queue.shift();
      }
      break;
    }
    carry = openFence(reopen ? [reopen.line, ...lines] : lines);
    parts.push({ reopen, lines });
    if (carry) parts[parts.length - 1]!.lines.push(carry.ch.repeat(carry.len));
  }
  const n = parts.length;
  return parts.map((p, k) => [`_${label} (part ${k + 1}/${n})_`, "", ...(p.reopen ? [p.reopen.line] : []), ...p.lines].join("\n"));
}

export interface ReleaseBuild {
  /** The PR body: always within the limit unless the Decide header alone is larger. */
  body: string;
  /** Whatever did not fit in the body, in order, each within the limit. Empty when everything fits. */
  comments: string[];
}

interface Item {
  label: string;
  title: string;
  text: string;
}

/** Items packed into comments in order; an item too big for one comment is split, and always starts a new comment. */
function packComments(items: Item[]): string[] {
  const comments: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) comments.push(cur);
    cur = "";
  };
  for (const it of items) {
    if (bytes(it.text) > BODY_BUDGET) {
      flush();
      comments.push(...splitSection(it.label, it.text));
    } else if (cur && bytes(cur) + 2 + bytes(it.text) <= BODY_BUDGET) cur += "\n\n" + it.text;
    else {
      flush();
      cur = it.text;
    }
  }
  flush();
  return comments;
}

/**
 * The PR body and, when it does not fit, the overflow comments. Nothing is ever cut or dropped: the body holds the Decide
 * header, the tests and CI totals, then as many whole feature sections as fit, then Other commits if they fit. Everything
 * after the first section that does not fit goes to comments in order, and the body ends with a line naming it.
 */
export function releaseBody(i: ReleaseInput): ReleaseBuild {
  const items: Item[] = i.features.map((f) => ({
    label: label(f),
    title: f.title,
    text: featureSection(f, f.document?.trim() ? f.document.trim() : `Feature document: ${NOT_PROVIDED}`),
  }));
  const other: Item = { label: "Other commits", title: "Other commits", text: otherCommits(i) };
  /** The first comment: what the header gave up. At level 2 the unreadable IDs follow the Risk and manual checks lists. */
  const leadItem = (moved: Moved): Item => {
    const parts = ["## Risk and manual checks", ...riskLines(i), ...checkLines(i)];
    if (moved === 2) parts.push("", "## Work items that could not be read", ...(i.unreadable ?? []).map((id) => `- ${id}`));
    const title = moved === 2 && i.unreadable?.length ? "Risk and manual checks, unreadable work items" : "Risk and manual checks";
    return { label: title, title, text: parts.join("\n") };
  };
  const n = items.length;
  const join = (parts: string[]) => parts.join("\n\n") + "\n";

  /** Lay the body out; what `moved` names goes at the front of the comments. */
  const layout = (moved: Moved): ReleaseBuild => {
    const lead = moved ? [leadItem(moved)] : [];
    const compose = (k: number, withOther: boolean, rest: string[]) =>
      join([
        decideHeader(i, moved),
        totals(i),
        "## Features",
        ...(n ? items.slice(0, k).map((x) => x.text) : ["none"]),
        ...(withOther ? [other.text] : []),
        ...(rest.length ? [`Continued in comments: ${rest.join(", ")}`] : []),
      ]);
    for (let k = n; k >= 0; k--) {
      const rest = [...lead, ...items.slice(k)].map((x) => x.title);
      if (bytes(compose(k, true, rest)) <= BODY_BUDGET) return { body: compose(k, true, rest), comments: packComments([...lead, ...items.slice(k)]) };
      if (bytes(compose(k, false, [...rest, other.title])) <= BODY_BUDGET || k === 0) {
        return { body: compose(k, false, [...rest, other.title]), comments: packComments([...lead, ...items.slice(k), other]) };
      }
    }
    throw new Error("unreachable");
  };

  // The fixed part (Decide header, totals, the continued line) cannot be split. When it alone is too big, what grows with
  // the release moves to the first comment, in two steps: the per-feature Risk and Manual checks lists, then the list of
  // unreadable work item IDs. What stays (Merging does, the rollback, one warning line, one pointer line) is a few hundred
  // bytes whatever the release size, so the body always fits. The caller still checks every text before it pushes, as a
  // guard that should never fire.
  for (const level of [0, 1] as const) {
    const built = layout(level);
    if (bytes(built.body) <= BODY_BUDGET) return built;
  }
  return layout(2);
}
