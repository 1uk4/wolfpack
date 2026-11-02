#!/usr/bin/env node
// Secret guard for release artifacts. Fails (exit 1) if the artifact holds a .env file or a token-like string.
//   node scripts/release-guard.mjs <artifact.tar.gz | directory>
// Hard rule: templates only (*.env.example etc.), never a value.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TOKEN_PATTERNS = [
  ["anthropic key", /sk-ant-[A-Za-z0-9_-]{16,}/],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["github fine-grained pat", /github_pat_[A-Za-z0-9_]{30,}/],
  ["private key block", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{20,}/],
];

/** `.env`, `.env.local`, `hubd.env` are secret-bearing names; `*.example|sample|template|dist` are templates. */
export function isEnvFile(path) {
  const b = basename(path);
  if (/\.(example|sample|template|dist)$/i.test(b)) return false;
  return b === ".env" || b.startsWith(".env.") || b.endsWith(".env");
}

export function scanContent(buf) {
  const text = buf.toString("latin1");
  const hits = [];
  for (const [name, re] of TOKEN_PATTERNS) if (re.test(text)) hits.push(name);
  return hits;
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Scan a directory; returns findings [{file, reason}] (paths relative to dir). Never prints matched text. */
export function scanDir(dir) {
  const findings = [];
  for (const f of walk(dir)) {
    const rel = f.slice(dir.length + 1);
    if (isEnvFile(rel)) findings.push({ file: rel, reason: "env file" });
    if (lstatSync(f).isSymbolicLink()) continue;
    for (const r of scanContent(readFileSync(f))) findings.push({ file: rel, reason: `token-like string (${r})` });
  }
  return findings;
}

export function scanArtifact(path) {
  if (statSync(path).isDirectory()) return scanDir(path.replace(/\/$/, ""));
  const tmp = mkdtempSync(join(tmpdir(), "release-guard-"));
  try {
    // list first: catches .env even if it is empty or a special member
    const names = execFileSync("tar", ["-tzf", path], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean);
    const pre = names.filter((n) => isEnvFile(n)).map((n) => ({ file: n, reason: "env file" }));
    execFileSync("tar", ["-xzf", path, "-C", tmp]);
    const seen = new Set(pre.map((f) => f.file + f.reason));
    return [...pre, ...scanDir(tmp).filter((f) => !seen.has(f.file + f.reason))];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2];
  if (!target) { console.error("usage: release-guard.mjs <artifact.tar.gz|dir>"); process.exit(2); }
  const findings = scanArtifact(target);
  if (findings.length) {
    for (const f of findings) console.error(`GUARD FAIL: ${f.file}: ${f.reason}`);
    process.exit(1);
  }
  console.log(`release guard OK: ${basename(target)} has no .env files or token-like strings`);
}
