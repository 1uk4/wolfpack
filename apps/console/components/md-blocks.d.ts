/**
 * MARKDOWN BLOCKS, MELTED INTO THE MESSAGE (owner wave, 2026-09-19): the
 * boxed streamdown chrome — the double-framed tables (border + sidebar bg +
 * a second inner border + copy/download/fullscreen button rows), the mermaid
 * container (border box + mono label header + action pill + inner border +
 * in-chart zoom buttons), the code header bars — is REPLACED by this
 * component set, wired into Streamdown via its `components` prop:
 *
 * - Tables: a plain PROSE table (no box, no sidebar bg, no buttons bar) —
 *   hairline row rules + a stronger header underline (globals.css), wide
 *   tables scroll inside the column.
 * - Mermaid: the bare chart, part of the message — no label, no container,
 *   no zoom pill (zoom/pan lives in the session-scoped focus overlay now).
 * - Code: streamdown's CodeBlock skeleton keeps the shiki plumbing, but the
 *   container melts (subtle bg tint, no border, no header — globals.css) and
 *   the buttons go.
 * - Display math: untouched visually, but gains the corner copy.
 *
 * THE ONE AFFORDANCE (user-decided): a small muted COPY icon at each block's
 * top-right corner, revealed on hover — copying the SOURCE (table →
 * Markdown, code → text, mermaid → chart source, math → the raw TeX). It
 * never fakes a table column or shifts layout, and hover-reveal keeps the
 * reading surface clean — the whole point of the melt. Text selection stays
 * free: the icon lives in dead corner space. Mermaid additionally gets an
 * EXPAND icon (opens the session overlay) when a chat page is mounted.
 */
import { type ComponentProps, type ReactNode } from "react";
import type { ExtraProps } from "streamdown";
/** A small muted copy icon for a block's top-right corner. The CONSUMER'S
 *  wrapper carries `group/md relative` (a NAMED group — the message container
 *  is also a `group`, and an unnamed group-hover would light EVERY corner in
 *  the message at once, the all-at-once the owner saw) and positions this
 *  via className; the icon self-hides until hover (opacity-0 →
 *  group-hover/md:opacity-100). Copies getText() on click; the icon flips
 *  to a check for a beat — enough feedback on its own (a "Copied" pill was
 *  tried and removed by owner ask, 2026-09-19). */
export declare function CopyCorner({ getText, label, className, }: {
    getText: () => string;
    label: string;
    className?: string;
}): any;
/** The fence source from a code element's children — a bare string in the
 *  common case; an element wrapping a string when rehype nests it. Pure. */
export declare function codeSource(children: ReactNode): string;
/** The Streamdown `code` override: inline code passes through with the
 *  house inline classes; block fences split — mermaid renders as the bare
 *  chart above, everything else delegates to streamdown's exported
 *  CodeBlock (shiki highlighting + line numbers preserved) inside a
 *  hover-copy wrapper, with NO children so its sticky button row never
 *  mounts. The container/look is CSS-melted in globals.css
 *  (data-streamdown="code-block"…). */
export declare function MarkdownCode(props: ComponentProps<"code"> & ExtraProps): any;
export interface ParsedAlert {
    kind: string;
    /** The blockquote children with the marker line stripped — prose intact. */
    children: ReactNode;
}
/** Pure: does this blockquote open with a GitHub alert marker? Returns the
 *  kind and the children with the marker line removed (the marker's own
 *  paragraph dropped entirely when it stands alone — `> [!IMPORTANT]` then
 *  a blank quote line then content; a standalone marker also drops the
 *  <br> hard-break artifact that carried its line break). Non-alert
 *  blockquotes pass through untouched. Exported for hermetic tests. */
export declare function parseAlertMarker(children: ReactNode): ParsedAlert | null;
/** The key-idea callout (owner rulings, 2026-10-07): SHARP corners, a white
 *  stroke, NO background, NO label, NO icon — just the outline. The box
 *  hugs its text (width: fit-content, capped at the column) instead of
 *  stretching full-width into empty space. */
export declare function MarkdownBlockquote(props: ComponentProps<"blockquote"> & ExtraProps): any;
/** A plain PROSE table: no wrapper box, no button rows — just the table
 *  (streamdown's inner cells keep their padding/typography; the hairline
 *  rules live in globals.css on the data-streamdown attributes) inside a
 *  horizontal-scroller for wide ones, with the corner copy. The copy
 *  serializes the REAL DOM table (the library's own extractor → Markdown). */
export declare function MarkdownTable(props: ComponentProps<"table"> & ExtraProps): any;
/** KaTeX display equations are wrapped in a SPAN.katex-display (rehype-katex
 *  renders them as spans with display:block CSS — NOT divs; verified in the
 *  static render). They gain the corner copy (the raw TeX — KaTeX embeds it
 *  in the MathML <annotation>; read from the DOM on click, no re-parse).
 *  Every other span passes through untouched. */
export declare function MathDisplay(props: ComponentProps<"span"> & ExtraProps): any;
/** Bold as the REAL element (appearance fix, 2026-09-23): streamdown's
 *  default `strong` renders `<span class="font-semibold" data-streamdown=
 *  "strong">` — and `.lh-prose :where(strong, b)` matches strong/b
 *  ELEMENTS, so neither the factory ink (#ee928c) nor a settings
 *  boldColor ever landed on bold text (italic worked: streamdown leaves
 *  `em` native). Rendering the semantic element restores screen-reader
 *  emphasis AND lets the designed token rule apply unmodified — color
 *  --lh-ink-strong, weight 700 (beating the old 600 utility). */
export declare function MarkdownStrong(props: ComponentProps<"strong"> & ExtraProps): any;
export declare const mdComponents: {
    code: typeof MarkdownCode;
    table: typeof MarkdownTable;
    span: typeof MathDisplay;
    strong: typeof MarkdownStrong;
    blockquote: typeof MarkdownBlockquote;
};
//# sourceMappingURL=md-blocks.d.ts.map