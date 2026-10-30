/**
 * kb-compare: a strictly READ-ONLY comparison of the Syncthing KB copy with workerd's hub KB mirror, per domain.
 * Nothing here writes, renames or deletes anything in either tree; it only lstat/readdir/readFile.
 *
 * Every file under each domain root is hashed (sha256 over raw bytes) and classified:
 *   ignored        sync/OS noise (KB_COMPARE_NOISE), listed in the report
 *   not-synced     the protocol's KB_SYNC_PATH does not match (e.g. work/**): listed separately, never blocks
 *   synced         matched | only-in-syncthing | only-in-mirror | mismatch
 * Verdict: CLEAN only when every synced path matches in every domain (and nothing unreadable/symlinked was met); otherwise BLOCKED.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KB_SYNC_PATH } from "@wolfpack/protocol";

export type KbCompareLayout = "flat" | "base";

/** Noise matched against EVERY path segment (a match on a directory ignores everything below it). */
export const KB_COMPARE_NOISE: ReadonlyArray<{ name: string; test: (segment: string) => boolean }> = [
  { name: ".stfolder", test: (s) => s === ".stfolder" },
  { name: ".stignore", test: (s) => s === ".stignore" },
  { name: ".DS_Store", test: (s) => s === ".DS_Store" },
  { name: "*.sync-conflict-*", test: (s) => /\.sync-conflict-/.test(s) },
  { name: ".syncthing.*.tmp", test: (s) => /^\.syncthing\..*\.tmp$/.test(s) },
  { name: "~syncthing~*", test: (s) => s.startsWith("~syncthing~") },
  { name: ".sync/ (mirror state dir)", test: (s) => s === ".sync" },
  { name: ".<hex>.tmp (workerd temp)", test: (s) => /^\.[0-9a-f]+\.tmp$/.test(s) },
];
export const isNoise = (rel: string): boolean => rel.split("/").some((seg) => KB_COMPARE_NOISE.some((n) => n.test(seg)));

const DOMAIN = /^[a-z0-9][a-z0-9-]*$/;

export class KbCompareError extends Error {}

export interface KbCompareOptions {
  syncthing: string;
  mirror: string;
  layout?: KbCompareLayout;
  domains?: string[];
}
export interface Mismatch {
  path: string;
  syncthing: string;
  mirror: string;
}
export interface DomainReport {
  domain: string;
  syncthingPresent: boolean;
  mirrorPresent: boolean;
  matched: number;
  onlyInSyncthing: string[];
  onlyInMirror: string[];
  mismatched: Mismatch[];
  ignored: { syncthing: string[]; mirror: string[] };
  notSynced: { syncthing: string[]; mirror: string[] };
  /** Symlinks or unreadable entries met inside a domain tree (never followed); these block. */
  problems: string[];
  hub: { epoch: string; rev: number; active: boolean } | null;
  clean: boolean;
}
export interface KbCompareReport {
  verdict: "CLEAN" | "BLOCKED";
  layout: KbCompareLayout;
  syncthing: string;
  mirror: string;
  domainsYaml: { path: string; exists: boolean; note: string };
  mirrorStateFiles: string[];
  domains: DomainReport[];
}

const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

interface Side {
  files: Map<string, string>; // synced + not-synced, rel -> sha
  ignored: string[];
  problems: string[];
}
function scan(root: string): Side {
  const out: Side = { files: new Map(), ignored: [], problems: [] };
  const walk = (abs: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch (e) {
      out.problems.push(`${rel || "."}: cannot read directory (${(e as Error).message})`);
      return;
    }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      const a = join(abs, n);
      let st;
      try {
        st = lstatSync(a);
      } catch (e) {
        out.problems.push(`${r}: cannot stat (${(e as Error).message})`);
        continue;
      }
      if (st.isSymbolicLink()) {
        if (isNoise(r)) out.ignored.push(r);
        else out.problems.push(`${r}: symlink (not followed)`);
      } else if (st.isDirectory()) walk(a, r);
      else if (st.isFile()) {
        if (isNoise(r)) out.ignored.push(r);
        else {
          try {
            out.files.set(r, sha(readFileSync(a)));
          } catch (e) {
            out.problems.push(`${r}: unreadable (${(e as Error).message})`);
          }
        }
      } else if (!isNoise(r)) out.problems.push(`${r}: not a regular file`);
    }
  };
  walk(root, "");
  return out;
}

function checkRoot(path: string, what: string): boolean {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return false;
  if (st.isSymbolicLink()) throw new KbCompareError(`refusing ${what} ${path}: domain root is a symlink`);
  if (!st.isDirectory()) throw new KbCompareError(`refusing ${what} ${path}: not a directory`);
  return true;
}
function domainDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => DOMAIN.test(e.name) && (e.isDirectory() || e.isSymbolicLink())).map((e) => e.name);
  } catch {
    return [];
  }
}
function hubState(mirror: string, d: string): DomainReport["hub"] {
  try {
    const j = JSON.parse(readFileSync(join(mirror, ".sync", `${d}.json`), "utf8")) as { epoch?: unknown; rev?: unknown; active?: unknown };
    if (typeof j.epoch === "string" && typeof j.rev === "number") return { epoch: j.epoch, rev: j.rev, active: j.active !== false };
  } catch {
    /* none */
  }
  return null;
}

export function compareKb(o: KbCompareOptions): KbCompareReport {
  const layout = o.layout ?? "flat";
  const stDomains = join(o.syncthing, "domains");
  const mirDomains = layout === "base" ? join(o.mirror, "domains") : o.mirror;
  for (const d of o.domains ?? []) if (!DOMAIN.test(d)) throw new KbCompareError(`invalid domain name ${JSON.stringify(d)}`);
  const names = o.domains ?? [...new Set([...domainDirs(stDomains), ...domainDirs(mirDomains)])].sort();
  const yamlPath = join(o.syncthing, "domains.yaml");
  const mirrorState = scan(join(o.mirror, ".sync")).files; // listed only; never compared
  const domains: DomainReport[] = names.map((domain) => {
    const sRoot = join(stDomains, domain);
    const mRoot = join(mirDomains, domain);
    const sPresent = checkRoot(sRoot, "syncthing");
    const mPresent = checkRoot(mRoot, "mirror");
    const s = sPresent ? scan(sRoot) : { files: new Map<string, string>(), ignored: [], problems: [] };
    const m = mPresent ? scan(mRoot) : { files: new Map<string, string>(), ignored: [], problems: [] };
    const rep: DomainReport = {
      domain, syncthingPresent: sPresent, mirrorPresent: mPresent, matched: 0, onlyInSyncthing: [], onlyInMirror: [], mismatched: [],
      ignored: { syncthing: s.ignored, mirror: m.ignored }, notSynced: { syncthing: [], mirror: [] },
      problems: [...s.problems.map((p) => `syncthing: ${p}`), ...m.problems.map((p) => `mirror: ${p}`)], hub: hubState(o.mirror, domain), clean: false,
    };
    for (const p of s.files.keys()) if (!KB_SYNC_PATH.test(p)) rep.notSynced.syncthing.push(p);
    for (const p of m.files.keys()) if (!KB_SYNC_PATH.test(p)) rep.notSynced.mirror.push(p);
    for (const [p, h] of s.files) {
      if (!KB_SYNC_PATH.test(p)) continue;
      const mh = m.files.get(p);
      if (mh === undefined) rep.onlyInSyncthing.push(p);
      else if (mh === h) rep.matched++;
      else rep.mismatched.push({ path: p, syncthing: h, mirror: mh });
    }
    for (const p of m.files.keys()) if (KB_SYNC_PATH.test(p) && !s.files.has(p)) rep.onlyInMirror.push(p);
    rep.clean = !rep.onlyInSyncthing.length && !rep.onlyInMirror.length && !rep.mismatched.length && !rep.problems.length;
    return rep;
  });
  const yes = existsSync(yamlPath);
  return {
    verdict: domains.every((d) => d.clean) ? "CLEAN" : "BLOCKED",
    layout, syncthing: o.syncthing, mirror: o.mirror,
    domainsYaml: { path: yamlPath, exists: yes, note: yes ? "present in the Syncthing copy; NOT synced by the hub (by design for now)" : "absent; not synced by the hub anyway" },
    mirrorStateFiles: [...mirrorState.keys()],
    domains,
  };
}

export function formatReport(r: KbCompareReport): string {
  const L: string[] = [];
  L.push(`kb-compare  layout=${r.layout}`, `  syncthing: ${r.syncthing}`, `  mirror:    ${r.mirror}`, "");
  const cols = ["domain", "matched", "only-syncthing", "only-mirror", "mismatch", "not-synced(s/m)", "ignored(s/m)", "hub epoch/rev", "result"];
  const rows = r.domains.map((d) => [
    d.domain, String(d.matched), String(d.onlyInSyncthing.length), String(d.onlyInMirror.length), String(d.mismatched.length),
    `${d.notSynced.syncthing.length}/${d.notSynced.mirror.length}`, `${d.ignored.syncthing.length}/${d.ignored.mirror.length}`,
    d.hub ? `${d.hub.epoch}/${d.hub.rev}${d.hub.active ? "" : " (inactive)"}` : "-", d.clean ? "ok" : "DIFF",
  ]);
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((x) => x[i]!.length)));
  const line = (x: string[]) => "  " + x.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd();
  L.push(line(cols), line(w.map((n) => "-".repeat(n))), ...rows.map(line), "");
  L.push(`domains.yaml: ${r.domainsYaml.exists ? "exists" : "missing"} (${r.domainsYaml.note})`);
  if (r.mirrorStateFiles.length) L.push(`mirror .sync/ state files (ignored): ${r.mirrorStateFiles.join(", ")}`);
  for (const d of r.domains) {
    const parts: string[] = [];
    const sub = (title: string, items: string[]) => items.length && parts.push(`  ${title} (${items.length}):`, ...items.map((i) => `    ${i}`));
    sub("only in syncthing", d.onlyInSyncthing);
    sub("only in mirror", d.onlyInMirror);
    sub("hash mismatch", d.mismatched.map((x) => x.path));
    sub("problems", d.problems);
    sub("not synced by design, syncthing", d.notSynced.syncthing);
    sub("not synced by design, mirror", d.notSynced.mirror);
    sub("ignored noise, syncthing", d.ignored.syncthing);
    sub("ignored noise, mirror", d.ignored.mirror);
    if (parts.length) L.push("", `[${d.domain}]`, ...parts);
  }
  L.push("", `VERDICT: ${r.verdict}`);
  return L.join("\n");
}

export const KB_COMPARE_USAGE = "usage: workerd kb-compare --syncthing <base dir> --mirror <dir> [--layout flat|base] [--domains a,b,c] [--json <out file>]";

/** CLI entry. Returns the exit code: 0 CLEAN, 1 BLOCKED, 2 usage error / refusal. */
export function runKbCompare(argv: string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const opt: Record<string, string> = {};
  const known = new Set(["syncthing", "mirror", "layout", "domains", "json"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const key = a.startsWith("--") ? (eq > 0 ? a.slice(2, eq) : a.slice(2)) : "";
    if (!known.has(key)) {
      err(`workerd kb-compare: unknown argument ${a}\n${KB_COMPARE_USAGE}`);
      return 2;
    }
    const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (v === undefined || v === "") {
      err(`workerd kb-compare: --${key} needs a value\n${KB_COMPARE_USAGE}`);
      return 2;
    }
    opt[key] = v;
  }
  if (!opt.syncthing || !opt.mirror) {
    err(KB_COMPARE_USAGE);
    return 2;
  }
  if (opt.layout !== undefined && opt.layout !== "flat" && opt.layout !== "base") {
    err(`workerd kb-compare: --layout must be flat or base\n${KB_COMPARE_USAGE}`);
    return 2;
  }
  try {
    const report = compareKb({ syncthing: opt.syncthing, mirror: opt.mirror, layout: opt.layout as KbCompareLayout | undefined, domains: opt.domains?.split(",").map((s) => s.trim()).filter(Boolean) });
    out(formatReport(report));
    if (opt.json) writeFileSync(opt.json, JSON.stringify(report, null, 2) + "\n");
    return report.verdict === "CLEAN" ? 0 : 1;
  } catch (e) {
    if (e instanceof KbCompareError) {
      err(`workerd kb-compare: ${e.message}`);
      return 2;
    }
    throw e;
  }
}
