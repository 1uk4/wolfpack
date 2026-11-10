/**
 * Section editing of a work item body, shared by hubd and the sandbox Work API: fence-aware replace of one `## <Heading>` section
 * and the check that the replacement text cannot restructure the body. Pure functions; failures are `SectionTextError`.
 */

/** A refused section edit (bad text, or a body with duplicate headings). Callers map it to their own `invalid_request`. */
export class SectionTextError extends Error {}

export type SectionName = "plan" | "notes" | "record";
const SECTION_HEADING: Record<SectionName, string> = { plan: "## Plan", notes: "## Notes", record: "## Record" };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_H12 = /^ {0,3}#{1,2}(?:[ \t]|$)/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const ATX_ANY = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const CONTAINER_PREFIX = /^(?: {0,3}>[ \t]?| {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))/;

/** CRLF / lone CR -> LF. The body is stored and compared with LF only. */
function toLf(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/**
 * Per line: is it inside a fenced code block (``` or ~~~, CommonMark rules: closing fence is the same char, at least as long,
 * nothing else on the line). The fence lines themselves count as fenced. `unclosed` is true when the last fence never closes.
 */
function fenceMap(lines: string[]): { fenced: boolean[]; unclosed: boolean } {
  const fenced: boolean[] = [];
  let open: { ch: string; len: number } | undefined;
  for (const l of lines) {
    if (open) {
      fenced.push(true);
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
      if (m && m[1][0] === open.ch && m[1].length >= open.len) open = undefined;
      continue;
    }
    const m = FENCE_OPEN.exec(l);
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      open = { ch: m[1][0], len: m[1].length };
      fenced.push(true);
    } else fenced.push(false);
  }
  return { fenced, unclosed: open !== undefined };
}

/** Is line `i` (outside a fence) an H1/H2, ATX (also inside a quote / list-item prefix) or setext (underline under a text line)? */
function isHeading12(lines: string[], fenced: boolean[], i: number): boolean {
  if (fenced[i]) return false;
  let l = lines[i];
  for (let n = 0; n < 8; n++) {
    if (ATX_H12.test(l)) return true;
    const m = CONTAINER_PREFIX.exec(l);
    if (!m) break;
    l = l.slice(m[0].length);
  }
  // Setext: an underline right below a non-blank, non-fenced line turns that line into a heading. (After a blank line `---` is
  // a thematic break and `===` plain text, both harmless.)
  if (i === 0 || fenced[i - 1] || !SETEXT_UNDERLINE.test(lines[i])) return false;
  const prev = lines[i - 1];
  // Only a plain paragraph line can be a setext heading's text: not blank, an ATX heading, a list item, a quote, a table row,
  // or another underline / thematic break.
  return prev.trim() !== "" && !ATX_ANY.test(prev) && !CONTAINER_PREFIX.test(prev) && !prev.includes("|") && !SETEXT_UNDERLINE.test(prev) && !/^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(prev);
}

/**
 * Reject section text that could restructure the body. `stripGeneratedLog` cuts the body at a column-0 `## Log` + list item, and
 * any CommonMark parser would see an H1/H2 (ATX with 0-3 spaces indent or a bare `##`, setext `Log\n---` / `Log\n===`) as a new
 * section. Headings inside fenced code are legitimate content; an unclosed fence would swallow the next real heading, so it is refused.
 */
export function assertSectionText(text: string): void {
  const lines = toLf(text).split("\n");
  const { fenced, unclosed } = fenceMap(lines);
  if (unclosed) throw new SectionTextError("section text has an unclosed code fence");
  for (let i = 0; i < lines.length; i++) {
    if (isHeading12(lines, fenced, i)) {
      throw new SectionTextError(`section text must not contain level-1 or level-2 headings (line ${i + 1}); put them in a code fence`);
    }
  }
}

/**
 * Replace one `## <Heading>` section of a body, up to the next H1/H2 outside a code fence (or the end). Fence-aware for both the
 * start and the end heading; CRLF is normalised to LF. A missing section is added (Plan before Notes, else appended). Duplicate
 * headings are REJECTED (`invalid_request`): which one to replace would be a guess; an operator can fix the body with a `body` op.
 */
export function replaceSection(body: string, name: SectionName, text: string): string {
  const heading = SECTION_HEADING[name];
  const lines = toLf(body).split("\n");
  const { fenced } = fenceMap(lines);
  // `## Plan`, also with a closing hash sequence (`## Plan ##`), outside code fences.
  const at = (h: string) => {
    const re = new RegExp(`^ {0,3}##[ \\t]+${h.slice(3)}(?:[ \\t]+#+)?[ \\t]*$`);
    return lines.flatMap((l, i) => (!fenced[i] && re.test(l) ? [i] : []));
  };
  const starts = at(heading);
  if (starts.length > 1) throw new SectionTextError(`the body has more than one "${heading}" heading; fix it with a body replace`);
  const block = [heading, "", ...(text.trim() ? [toLf(text).trim(), ""] : [])];
  const join_ = (parts: string[][]) => parts.flat().join("\n").trim() + "\n";
  if (starts.length === 1) {
    const start = starts[0];
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (isHeading12(lines, fenced, i)) {
        // A setext heading starts at its text line, one above the underline.
        end = !ATX_H12.test(lines[i]) && SETEXT_UNDERLINE.test(lines[i]) ? i - 1 : i;
        break;
      }
    }
    return join_([lines.slice(0, start), block, lines.slice(end)]);
  }
  const notes = name === "plan" ? at(SECTION_HEADING.notes) : [];
  if (notes.length >= 1) return join_([lines.slice(0, notes[0]), block, lines.slice(notes[0])]);
  const head = [...lines];
  while (head.length && head[head.length - 1].trim() === "") head.pop();
  return join_([head, head.length ? [""] : [], block]);
}

