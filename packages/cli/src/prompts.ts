/**
 * Interactive prompts — minimal readline-based prompts
 */

import readline from "node:readline";

function createRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createRl();
  const q = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(q, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

export async function select<T>(
  question: string,
  options: Array<{ label: string; value: T }>,
): Promise<T> {
  console.log(`\n${question}`);
  options.forEach((opt, i) => {
    console.log(`  ${i + 1}) ${opt.label}`);
  });

  const rl = createRl();
  return new Promise((resolve) => {
    rl.question(`\nSelect (1-${options.length}): `, (answer) => {
      rl.close();
      const idx = parseInt(answer.trim()) - 1;
      if (idx >= 0 && idx < options.length) {
        resolve(options[idx]!.value);
      } else {
        console.error(`Invalid selection, defaulting to 1`);
        resolve(options[0]!.value);
      }
    });
  });
}

/**
 * Interactive multi-select checkbox menu.
 *   \u2191/\u2193 (or k/j) move \u00b7 space toggles \u00b7 a toggles all \u00b7 Enter confirms \u00b7 Esc/Ctrl-C cancels
 *
 * Falls back to a plain numeric toggle prompt when stdin is not a TTY.
 * Returns the selected values (preserving option order).
 */
export async function multiSelect<T>(
  question: string,
  options: Array<{ label: string; value: T; selected?: boolean }>,
): Promise<T[]> {
  const selected = options.map((o) => !!o.selected);

  if (!process.stdin.isTTY) {
    return options.filter((_, i) => selected[i]).map((o) => o.value);
  }

  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

  let cursor = 0;
  const stdin = process.stdin;
  const stdout = process.stdout;

  const header = `${question}\n${dim("  \u2191/\u2193 move \u00b7 space toggle \u00b7 a all \u00b7 enter confirm")}`;

  function render(first: boolean): void {
    if (!first) {
      // Move cursor up over the previously drawn option lines
      stdout.write(`\x1b[${options.length}A`);
    }
    for (let i = 0; i < options.length; i++) {
      const isCursor = i === cursor;
      const box = selected[i] ? green("\u25c9") : "\u25ef";
      const pointer = isCursor ? cyan("\u276f") : " ";
      const label = isCursor ? cyan(options[i]!.label) : options[i]!.label;
      stdout.write(`\x1b[2K ${pointer} ${box} ${label}\n`);
    }
  }

  console.log(`\n${header}`);
  render(true);

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    function cleanup(): void {
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }

    function finish(): void {
      cleanup();
      stdout.write("\n");
      resolve(options.filter((_, i) => selected[i]).map((o) => o.value));
    }

    function onData(key: string): void {
      switch (key) {
        case "\x1b[A": // up
        case "k":
          cursor = (cursor - 1 + options.length) % options.length;
          render(false);
          break;
        case "\x1b[B": // down
        case "j":
          cursor = (cursor + 1) % options.length;
          render(false);
          break;
        case " ": // toggle
          selected[cursor] = !selected[cursor];
          render(false);
          break;
        case "a": {
          // toggle all: if any unselected, select all; else clear all
          const target = selected.some((s) => !s);
          for (let i = 0; i < selected.length; i++) selected[i] = target;
          render(false);
          break;
        }
        case "\r":
        case "\n":
          finish();
          break;
        case "\x03": // Ctrl-C
        case "\x1b": // Esc
          cleanup();
          stdout.write("\n");
          process.exit(130);
          break;
      }
    }

    stdin.on("data", onData);
  });
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = createRl();
  return new Promise((resolve) => {
    rl.question(`${question} ${hint}: `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (!a) resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}
