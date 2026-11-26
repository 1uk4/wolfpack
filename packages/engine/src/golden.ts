/**
 * Golden-file helper for the prompt snapshot tests (work-wolfpack-rruLly7). Test-only: not part of the engine's public API,
 * imported by the snapshot tests as `@wolfpack/engine/dist/golden.js`.
 *
 * `expectGolden(dir, name, actual)` compares `actual` byte for byte with `<dir>/<name>`. A mismatch throws with the first
 * differing line and the update command. With `UPDATE_PROMPT_GOLDEN=1` it rewrites the fixture instead, so a deliberate
 * prompt edit shows up as a reviewable diff in git:
 *
 *   UPDATE_PROMPT_GOLDEN=1 wolfpack test run <the snapshot test file>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const UPDATE_ENV = "UPDATE_PROMPT_GOLDEN";

export function expectGolden(dir: string, name: string, actual: string): void {
  const file = join(dir, name);
  const text = actual.endsWith("\n") ? actual : `${actual}\n`;
  if (process.env[UPDATE_ENV] === "1") {
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
    return;
  }
  const hint = `Prompt text changed? Review the diff, then run: ${UPDATE_ENV}=1 wolfpack test run <this test file>, and commit the fixture.`;
  if (!existsSync(file)) throw new Error(`golden fixture missing: ${file}\n${hint}`);
  const want = readFileSync(file, "utf8");
  if (want === text) return;
  const a = want.split("\n");
  const b = text.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  throw new Error(`golden mismatch: ${file}\nfirst difference at line ${i + 1}:\n  fixture: ${JSON.stringify(a[i] ?? "(end)")}\n  actual:  ${JSON.stringify(b[i] ?? "(end)")}\n${hint}`);
}
