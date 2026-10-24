/**
 * Legacy math delimiter preprocessing — the \(...\)/\[...\] reader.
 *
 * Current authoring uses `$...$` inline and `$$...$$` on separate lines for
 * display (owner, 2026-10-12). This pure transform keeps correctly formed
 * old backslash-delimited content readable; dollar math passes through to
 * Streamdown's native parser. Escape restoration below recognizes both
 * syntaxes while retaining the existing recovery rules.
 *
 * Rules:
 * - `\(...\)` → `$$...$$` (two-dollar inline, still accepted by micromark),
 *   `\[...\]` → `$$\n...\n$$` (block form: flow math).
 * - An escaped delimiter (`\\(` = literal backslash + paren) is left alone.
 * - Nothing inside fenced code blocks or inline code spans is touched.
 * - Unbalanced delimiters are left untouched: Streamdown streams chunks, and
 *   an incomplete `\[` completes on a later chunk (the whole text is
 *   re-transformed each render).
 *
 * Pure string → string. No markdown parsing — a single linear scan with a
 * code-state machine, cheap enough to run in the render path of a memo'd
 * component.
 */
export declare function transformMathDelimiters(markdown: string): string;
/** Shared display-only repair. Keep raw arguments and model history unchanged. */
export declare function repairMathForDisplay(text: string): string;
export declare function restoreMathEscapes(text: string): string;
export declare function healOverescapedCommands(text: string): string;
//# sourceMappingURL=math-delims.d.ts.map