/**
 * secrets — a conservative scan for credentials in text that is about to be
 * stored verbatim in the shared knowledge base. Matches are redacted in place;
 * the caller reports what was found. It errs toward redacting: a false positive
 * costs a placeholder, a miss publishes a credential.
 */

export interface SecretScan {
  /** The text with every match replaced by `[REDACTED:<kind>]`. */
  text: string;
  /** What was found: kind and number of matches. */
  findings: Array<{ kind: string; count: number }>;
}

const KEY_NAME = String.raw`[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|passphrase|private[_-]?key|credential)s?`;

const PATTERNS: Array<{ kind: string; re: RegExp; replace?: (m: RegExpExecArray) => string }> = [
  { kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "token", re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/g },
  { kind: "token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g },
  { kind: "token", re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  { kind: "token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "token", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "token", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: "bearer token", re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, replace: (m) => `${m[1]}[REDACTED:bearer token]` },
  // user:password@ inside a URL
  { kind: "url credentials", re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]{3,}(@)/gi, replace: (m) => `${m[1]}[REDACTED:url credentials]${m[2]}` },
  // name = value / name: value, where the name says it is a credential
  {
    kind: "credential assignment",
    re: new RegExp(String.raw`(\b${KEY_NAME}["']?\s*[:=]\s*["']?)([^\s"'<>{}$,;]{8,})`, "gi"),
    replace: (m) => (looksSecret(m[2]) ? `${m[1]}[REDACTED:credential assignment]` : m[0]),
  },
];

/** A value that is a word or a placeholder is not a secret; one mixing character kinds is. */
function looksSecret(v: string): boolean {
  if (/redacted|example|placeholder|changeme|your[-_]|xxxx|\*{3,}|^\.{3}/i.test(v)) return false;
  if (/^https?:\/\//i.test(v) || v.startsWith("/") || v.startsWith("~")) return false;
  return /\d/.test(v) || /[^A-Za-z]/.test(v);
}

export function scanSecrets(input: string): SecretScan {
  let text = input;
  const counts = new Map<string, number>();
  for (const p of PATTERNS) {
    text = text.replace(p.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const out = p.replace ? p.replace(m) : `[REDACTED:${p.kind}]`;
      if (out !== m[0]) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
      return out;
    });
  }
  return { text, findings: [...counts].map(([kind, count]) => ({ kind, count })) };
}
