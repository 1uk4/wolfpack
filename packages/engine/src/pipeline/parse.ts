/**
 * Parse — split markdown into YAML frontmatter fields + body. Pure code, no LLM.
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Normalize a scalar frontmatter value for the in-memory model: strip wrapping
 * quotes and Obsidian wikilink brackets so links round-trip to bare ids.
 * On disk link fields are stored as `"[[kb-...]]"` (Obsidian-native, navigable);
 * in memory the pipeline only ever sees the bare `kb-...` id.
 */
export function unwrapScalar(value: string): string {
  let v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  if (v.startsWith("[[") && v.endsWith("]]")) {
    v = v.slice(2, -2).trim();
  }
  return v;
}

/**
 * Parse YAML-ish frontmatter. Intentionally minimal — supports flat key: value
 * and array fields (both inline [a, b] and multi-line - item). No YAML dep.
 */
export function parseFrontmatter(
  raw: string
): { fields: Record<string, unknown>; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { fields: {}, body: raw };

  const fields: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    // Multi-line array item
    if (line.match(/^\s+-\s+/) && currentKey && currentArray) {
      currentArray.push(unwrapScalar(line.replace(/^\s+-\s+/, "")));
      continue;
    }

    // Flush pending array
    if (currentKey && currentArray) {
      fields[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Strip quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Inline array: [a, b, c]  (but NOT a wikilink like [[id]])
    if (
      value.startsWith("[") &&
      value.endsWith("]") &&
      !value.startsWith("[[")
    ) {
      fields[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => unwrapScalar(s))
        .filter(Boolean);
      continue;
    }

    // Empty value might start a multi-line array
    if (value === "") {
      currentKey = key;
      currentArray = [];
      continue;
    }

    fields[key] = unwrapScalar(value);
  }

  // Flush final pending array
  if (currentKey && currentArray) {
    fields[currentKey] = currentArray;
  }

  return { fields, body: match[2] };
}

