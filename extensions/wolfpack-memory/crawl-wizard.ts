/**
 * crawl-wizard — a single-choice picker for the crawl-run wizard.
 *
 * The interaction (keyboard-driven option list + inline "Other" free-text
 * editor, rendered through ctx.ui.custom) is borrowed from the
 * ask-user-question extension's askSingleChoice, trimmed down to return a plain
 * string value. We vendor it here so /wolf:crawl-run can present a proper
 * wizard before starting a run without taking a hard dependency on that
 * extension being loaded.
 */
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface WizardOption {
  label: string;
  value: string;
  description?: string;
}

interface DisplayOption extends WizardOption {
  id: string;
  index?: number;
  isOther?: boolean;
}

function createEditorTheme(theme: any): EditorTheme {
  return {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
}

function addWrapped(
  lines: string[],
  text: string,
  width: number,
  indent = ""
): void {
  const contentWidth = Math.max(1, width - indent.length);
  for (const line of wrapTextWithAnsi(text, contentWidth)) {
    lines.push(truncateToWidth(`${indent}${line}`, width));
  }
}

/**
 * Show a single-choice question. Returns the chosen option's `value`, a custom
 * string typed via "Other", or null if the user cancelled (Esc).
 *
 * `allowOther` appends an "Other…" row that opens an inline editor.
 */
export function wizardSingleChoice(
  ctx: any,
  question: string,
  context: string | undefined,
  options: WizardOption[],
  allowOther = false
): Promise<string | null> {
  const allOptions: DisplayOption[] = options.map((o, index) => ({
    ...o,
    id: `option:${index}`,
    index: index + 1,
  }));
  if (allowOther)
    allOptions.push({
      id: "other",
      label: "Other\u2026",
      value: "__other__",
      isOther: true,
    });

  return ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (result: string | null) => void) => {
      let optionIndex = 0;
      let editMode = false;
      let cachedLines: string[] | undefined;
      let cachedWidth = -1;
      const editor = new Editor(tui, createEditorTheme(theme));

      editor.onSubmit = (value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return;
        done(trimmed);
      };

      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function handleInput(data: string) {
        if (editMode) {
          if (matchesKey(data, Key.escape)) {
            editMode = false;
            editor.setText("");
            refresh();
            return;
          }
          editor.handleInput(data);
          refresh();
          return;
        }
        if (matchesKey(data, Key.up)) {
          optionIndex = Math.max(0, optionIndex - 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.down)) {
          optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const selected = allOptions[optionIndex];
          if (selected.isOther) {
            editMode = true;
            editor.setText("");
            refresh();
            return;
          }
          done(selected.value);
          return;
        }
        if (matchesKey(data, Key.escape)) {
          done(null);
        }
      }

      function render(width: number): string[] {
        // Cache keyed on width: pi-tui calls requestRender() but not
        // invalidate() on resize, so render() can re-enter with a new width.
        if (cachedLines && cachedWidth === width) return cachedLines;

        const lines: string[] = [];
        const add = (text: string) => lines.push(truncateToWidth(text, width));

        add(theme.fg("accent", "\u2500".repeat(width)));
        addWrapped(lines, theme.fg("text", ` ${question}`), width);
        if (context) {
          lines.push("");
          addWrapped(lines, theme.fg("muted", ` ${context}`), width);
        }
        lines.push("");

        for (let i = 0; i < allOptions.length; i++) {
          const option = allOptions[i];
          const selected = i === optionIndex;
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          const label = option.isOther
            ? option.label
            : `${option.index}. ${option.label}`;
          const styled = selected
            ? theme.fg("accent", label)
            : theme.fg("text", label);
          add(`${prefix}${styled}`);
          if (option.description) {
            addWrapped(lines, theme.fg("muted", option.description), width, "     ");
          }
        }

        if (editMode) {
          lines.push("");
          add(theme.fg("muted", " Type a custom value:"));
          for (const line of editor.render(Math.max(1, width - 2))) {
            add(` ${line}`);
          }
          lines.push("");
          add(theme.fg("dim", " Enter to submit \u00b7 Esc to go back"));
        } else {
          lines.push("");
          add(theme.fg("dim", " \u2191\u2193 navigate \u00b7 Enter select \u00b7 Esc cancel"));
        }

        add(theme.fg("accent", "\u2500".repeat(width)));
        cachedLines = lines;
        cachedWidth = width;
        return lines;
      }

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
        },
        handleInput,
      };
    }
  );
}
