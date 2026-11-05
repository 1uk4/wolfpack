/** Receipt / decision text redaction shared by pipeline.ts and activity.ts. */
// kb cannot import @wolfpack/memory's scanSecrets (memory depends on kb), so receipt text is redacted with the
// same conservative patterns here.
export const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]{3,}(@)/gi,
  /(\b[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|credential)s?["']?\s*[:=]\s*["']?)[^\s"'<>{}$,;]{8,}/gi,
];

/** First non-empty line, secrets redacted, whitespace collapsed, capped. */
export const oneLine = (s: string, max = 200): string => {
  let line = s.split("\n").find((l) => l.trim() !== "") ?? "";
  for (const re of SECRET_PATTERNS) line = line.replace(re, (m, a, b) => (a !== undefined && typeof a === "string" && a.length < m.length ? `${a}[REDACTED]${typeof b === "string" ? b : ""}` : "[REDACTED]"));
  line = line.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
