/**
 * crawl-wizard — the select prompt behind the pi TUI crawl commands
 * (/wolf:crawl-run, /wolf:crawl-release and friends).
 *
 * One function, `wizardSingleChoice`, shows a titled list and resolves with the
 * picked value, a typed custom value, or null when the user backs out. It is
 * written as a small pure state machine (`reduce`) plus a renderer, mounted
 * through ctx.ui.custom, so the behaviour can be tested without a terminal.
 */
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface WizardOption {
  label: string;
  value: string;
  description?: string;
}

/** A row in the list: a caller option, or the synthetic free-text row. */
type Row = { kind: "option"; option: WizardOption; number: number } | { kind: "custom" };

/** Everything the prompt remembers between key presses. */
export interface WizardState {
  cursor: number;
  /** null while browsing the list; the text typed so far while entering a custom value. */
  typing: string | null;
}

export type WizardKey = "up" | "down" | "enter" | "escape" | "backspace" | { text: string };

export type WizardStep =
  | { state: WizardState }
  | { done: string | null };

function buildRows(options: WizardOption[], allowCustom: boolean): Row[] {
  const rows: Row[] = options.map((option, i) => ({ kind: "option", option, number: i + 1 }));
  if (allowCustom) rows.push({ kind: "custom" });
  return rows;
}

/** Advance the prompt by one key. Pure: returns the next state, or the final answer. */
export function reduce(
  state: WizardState,
  key: WizardKey,
  options: WizardOption[],
  allowCustom: boolean,
): WizardStep {
  const rows = buildRows(options, allowCustom);

  if (state.typing !== null) {
    if (key === "escape") return { state: { ...state, typing: null } };
    if (key === "enter") {
      const text = state.typing.trim();
      return text ? { done: text } : { state };
    }
    if (key === "backspace") return { state: { ...state, typing: state.typing.slice(0, -1) } };
    if (typeof key === "object") return { state: { ...state, typing: state.typing + key.text } };
    return { state };
  }

  if (key === "up") return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
  if (key === "down") return { state: { ...state, cursor: Math.min(rows.length - 1, state.cursor + 1) } };
  if (key === "escape") return { done: null };
  if (key === "enter") {
    const row = rows[state.cursor];
    if (!row) return { state };
    return row.kind === "custom" ? { state: { ...state, typing: "" } } : { done: row.option.value };
  }
  return { state };
}

/** Map a raw terminal chunk to a WizardKey, or null for keys the prompt ignores. */
function toKey(data: string): WizardKey | null {
  if (matchesKey(data, Key.up)) return "up";
  if (matchesKey(data, Key.down)) return "down";
  if (matchesKey(data, Key.enter)) return "enter";
  if (matchesKey(data, Key.escape)) return "escape";
  if (matchesKey(data, Key.backspace)) return "backspace";
  // Printable input or a paste: anything free of control characters.
  if (data.length > 0 && !/[\u0000-\u001f\u007f]/.test(data)) return { text: data };
  return null;
}

/** Wrap `text` to the width and push each line, indented, onto `out`. */
function pushWrapped(out: string[], text: string, width: number, indent = ""): void {
  const room = Math.max(1, width - indent.length);
  for (const line of wrapTextWithAnsi(text, room)) out.push(truncateToWidth(indent + line, width));
}

/** Draw the prompt for a state. `theme.fg(color, text)` is pi's colouring hook. */
export function renderWizard(
  theme: { fg: (color: string, text: string) => string },
  width: number,
  title: string,
  context: string | undefined,
  options: WizardOption[],
  allowCustom: boolean,
  state: WizardState,
): string[] {
  const out: string[] = [];
  const rule = theme.fg("accent", "\u2500".repeat(width));
  out.push(rule);
  pushWrapped(out, theme.fg("text", ` ${title}`), width);
  if (context) {
    out.push("");
    pushWrapped(out, theme.fg("muted", ` ${context}`), width);
  }
  out.push("");

  buildRows(options, allowCustom).forEach((row, i) => {
    const on = i === state.cursor;
    const text = row.kind === "custom" ? "Other\u2026" : `${row.number}. ${row.option.label}`;
    out.push(truncateToWidth(`${on ? theme.fg("accent", "> ") : "  "}${theme.fg(on ? "accent" : "text", text)}`, width));
    if (row.kind === "option" && row.option.description) {
      pushWrapped(out, theme.fg("muted", row.option.description), width, "     ");
    }
  });

  out.push("");
  if (state.typing !== null) {
    out.push(truncateToWidth(theme.fg("muted", " Type a custom value:"), width));
    out.push(truncateToWidth(` ${state.typing}\u2588`, width));
    out.push("");
    out.push(truncateToWidth(theme.fg("dim", " Enter to submit \u00b7 Esc to go back"), width));
  } else {
    out.push(truncateToWidth(theme.fg("dim", " \u2191\u2193 move \u00b7 Enter choose \u00b7 Esc cancel"), width));
  }
  out.push(rule);
  return out;
}

/**
 * Ask the user to pick one option. Resolves with the chosen option's `value`,
 * the text typed into the "Other\u2026" row (when `allowOther`), or null if the
 * user cancelled with Esc.
 */
export function wizardSingleChoice(
  ctx: any,
  question: string,
  context: string | undefined,
  options: WizardOption[],
  allowOther = false,
): Promise<string | null> {
  return ctx.ui.custom((tui: any, theme: any, _keys: any, finish: (answer: string | null) => void) => {
    let state: WizardState = { cursor: 0, typing: null };

    return {
      render: (width: number) => renderWizard(theme, width, question, context, options, allowOther, state),
      invalidate: () => {},
      handleInput: (data: string) => {
        const key = toKey(data);
        if (key === null) return;
        const step = reduce(state, key, options, allowOther);
        if ("done" in step) {
          finish(step.done);
          return;
        }
        state = step.state;
        tui.requestRender();
      },
    };
  });
}
