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

type Looks = (v: string) => boolean;
const PATTERNS: Array<{ kind: string; re: RegExp; replace?: (m: RegExpExecArray, looks: Looks) => string }> = [
  { kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "token", re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/g },
  { kind: "token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g },
  { kind: "token", re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  { kind: "token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  // Telegram bot token: <8-10 digit bot id>:<35 chars>
  { kind: "telegram bot token", re: /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
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
    replace: (m, looks) => (looks(m[2]) ? `${m[1]}[REDACTED:credential assignment]` : m[0]),
  },
];

/** A value that is a word or a placeholder is not a secret; one mixing character kinds is. */
function looksSecret(v: string): boolean {
  if (/redacted|example|placeholder|changeme|your[-_]|xxxx|\*{3,}|^\.{3}/i.test(v)) return false;
  if (/^https?:\/\//i.test(v) || v.startsWith("/") || v.startsWith("~")) return false;
  return /\d/.test(v) || /[^A-Za-z]/.test(v);
}

/** A letters-only value (optionally dotted) that has the shape of an identifier or a word, not of a passphrase / random string. */
function isIdentifierShaped(v: string): boolean {
  const segs = v.split(".");
  if (segs.length > 3 || v.length > 32) return false;
  if (segs.length > 1 && segs.some((x) => x.length < 3)) return false; // Zx.Qw.Lk.Pr
  return segs.every((x) => {
    if (x.length > 24) return false;
    if (/^[a-z]+$/.test(x) || /^[A-Z]+$/.test(x)) return x.length <= 20; // one word, one case
    const rest = x.slice(1);
    if (/^[a-z]+$/.test(rest)) return x.length <= 20; // Capitalised word
    const transitions = (x.match(/[a-z][A-Z]/g) ?? []).length; // camelCase / PascalCase humps
    return transitions <= x.length / 6;
  });
}

/**
 * Crawl variant of the credential-assignment value test (the hub's hard-400 path for crawl contributions). A key name like `token:` / `secret=`
 * followed by one of these is NOT a credential, because crawled prose is full of them. Every exemption is BOUNDED, so a passphrase does not hide in one:
 *   - a work-item id (`work-<domain>-<id>`) or a KB id (`kb-<domain>-<id>`)
 *   - an env-var NAME: ALL_CAPS segments joined by underscores (at least one), at most 2 digits, each segment <= 12 chars, whole name <= 40 (HUBD_TOKEN)
 *   - a real path: lowercase letters with - _ . / ~ and NO digits, containing `/` or starting with `~` (~/.wolfpack/hub.json)
 *   - letters only, optionally dotted (apiKey.value): at most 3 dotted segments of >= 3 chars, each <= 24, whole <= 32; a single-case or Capitalised word
 *     is <= 20 chars; camelCase/PascalCase has at most len/6 lower->upper humps
 *   - a short kebab/snake word: lowercase letters only (no digits), <= 3 segments split on - _ . each <= 12 chars, whole value <= 14 (per-wolf, hub-token-file)
 *   - a placeholder: <masked>, <redacted>, ***, xxx, ${VAR}, $VAR, or the words masked/redacted/hidden
 * Markdown/code punctuation around the value (backticks, *, parentheses, trailing .,;:) is ignored.
 * Anything that is letters-only (or lowercase words) but outside those bounds IS flagged (correct-horse-battery-staple, my_secret_phrase, a 21+ char
 * single-case word, Zx.Qw.Lk.Pr). Everything else falls through to the work-item rule (a digit or any non-letter makes it a secret), and every
 * non-assignment pattern (private keys, bearer, JWT, URL credentials, token prefixes) is untouched.
 * Known gap: a short mixed-case word within bounds (e.g. "Hunterxy") is indistinguishable from an identifier and passes.
 */
export function looksSecretForCrawl(raw: string): boolean {
  const v = raw.replace(/^[`*(.,:;]+|[`*().,:;]+$/g, "");
  if (v === "") return false;
  if (/^(?:<[^<>\s]*>|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\*{3,}|x{3,}|masked|redacted|hidden)$/i.test(v)) return false;
  if (/^(?:work|kb)-[a-z0-9][a-z0-9-]*-[A-Za-z0-9]{4,}$/.test(v)) return false;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) return v.length > 40 || (v.match(/\d/g) ?? []).length > 2 || v.split("_").some((x) => x.length > 12);
  if (/^[a-z~./_-]+$/.test(v) && (v.includes("/") || v.startsWith("~"))) return false;
  if (/^[A-Za-z]+(?:\.[A-Za-z]+)*$/.test(v)) return !isIdentifierShaped(v);
  if (/^[a-z_.-]+$/.test(v)) {
    const segs = v.split(/[-_.]/);
    return !(segs.length <= 3 && segs.every((x) => x.length <= 12) && v.length <= 14);
  }
  return looksSecret(v);
}

export function scanSecrets(input: string): SecretScan {
  return scan(input, looksSecret);
}

/** Like `scanSecrets`, but with the stricter crawl credential-assignment rule (`looksSecretForCrawl`). Only the hub's crawl check uses it. */
export function scanSecretsForCrawl(input: string): SecretScan {
  return scan(input, looksSecretForCrawl);
}

function scan(input: string, looks: Looks): SecretScan {
  let text = input;
  const counts = new Map<string, number>();
  for (const p of PATTERNS) {
    text = text.replace(p.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const out = p.replace ? p.replace(m, looks) : `[REDACTED:${p.kind}]`;
      if (out !== m[0]) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
      return out;
    });
  }
  return { text, findings: [...counts].map(([kind, count]) => ({ kind, count })) };
}
