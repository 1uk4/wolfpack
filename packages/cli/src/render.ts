/**
 * Terminal rendering helpers — zero dependencies.
 * Ported from legacy/cli/src/render.ts.
 */

export const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visibleLen = (s: string) => stripAnsi(s).length;

/** Render a left-aligned table with header row */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? ""))),
  );
  const pad = (s: string, w: number) =>
    s + " ".repeat(Math.max(0, w - visibleLen(s)));
  const line = (cells: string[]) =>
    cells.map((cell, i) => pad(cell ?? "", widths[i]!)).join("  ");
  return [c.bold(line(headers)), ...rows.map((r) => line(r))].join("\n");
}
