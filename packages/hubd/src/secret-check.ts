/**
 * The hub-side secret check on incoming contributions.
 *
 * SEAM (work-wolfpack-VO2wX3I): today this reuses the work-item scanner (`scanSecrets` from @wolfpack/memory); the shared secret-block
 * module will replace `patternsIn` and nothing else here. Results are pattern NAMES and field paths, never matched text.
 *
 * The scanner's credential-assignment pattern backtracks quadratically on a long run of `a.a.a.` or `a-a-a-` (measured: 8 KB 0.16 s,
 * 32 KB 2.4 s, 128 KB 39 s), and the contribution body cap is 8 MiB. So text is scanned in small overlapping windows (cost linear in
 * the length, each window bounded), and a field past MAX_SCAN_CHARS is not scanned at all but reported as `unscanned (too long)`, which
 * a strict caller treats as a finding (fail closed).
 */
import { scanSecrets } from "@wolfpack/memory";

/** Window and overlap, chars. The overlap exceeds the longest minimal span any pattern needs, so a secret cut by a window edge is whole in the next. */
export const SCAN_WINDOW = 2048;
export const SCAN_OVERLAP = 256;
/** Largest string scanned; a longer one is reported, not scanned. A crawl topic body is capped at 8000 chars. */
export const MAX_SCAN_CHARS = 128 * 1024;
export const UNSCANNED = "unscanned (too long)";

/** Pattern names found in `text` (unique), scanning window by window. */
export function patternsIn(text: string): string[] {
  if (text.length > MAX_SCAN_CHARS) return [UNSCANNED];
  const kinds = new Set<string>();
  for (let i = 0; i < text.length; i += SCAN_WINDOW - SCAN_OVERLAP) {
    for (const f of scanSecrets(text.slice(i, i + SCAN_WINDOW)).findings) kinds.add(f.kind);
    if (i + SCAN_WINDOW >= text.length) break;
  }
  return [...kinds];
}

export interface SecretFinding {
  /** Dotted path of the string that held it, e.g. "body", "sourcePath". */
  field: string;
  /** Pattern kind, e.g. "token"; never the value. */
  pattern: string;
}

/** Every string leaf of `value` (objects and arrays walked), scanned; findings carry the field path. */
export function secretFindings(value: unknown, path = ""): SecretFinding[] {
  if (typeof value === "string") return patternsIn(value).map((pattern) => ({ field: path || "(value)", pattern }));
  if (Array.isArray(value)) return value.flatMap((v, i) => secretFindings(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => secretFindings(v, path ? `${path}.${k}` : k));
  return [];
}

/** Text kept for diagnosis (the `_bad/` quarantine copy): the text itself, or a placeholder naming the patterns when it holds a possible secret (or is too long to scan). */
export function safeToKeep(text: string): string {
  const kinds = patternsIn(text);
  return kinds.length ? `[withheld: possible secret (${kinds.join(", ")}); ${text.length} chars]` : text;
}
