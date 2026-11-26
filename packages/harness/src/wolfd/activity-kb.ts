/**
 * Which KB things a tool call touched (live pack map kb-read trails). Pure and conservative: a miss only means a missing trail,
 * a false hit means a wrong one, so anything unclear yields nothing. Tool args are inspected here and never kept.
 *
 *  - `read` of `<kb-mirror>/domains/<d>/entries/<id>.md` -> kb-entry; of `INDEX.md` / `_digest.json` -> the domain.
 *  - `bash` whose command has a read verb (cat grep rg find head tail sed awk less ls jq) and no output redirect, naming
 *    kb-mirror paths (and no write verb: sed -i, tee, cp, mv, rm, dd): an entry path -> kb-entry, any other path under a domain -> the domain (at most MAX_BASH_TARGETS).
 *  - `guarded_bash` (sub-agents) is `bash`; `grep` / `find` / `ls` (sub-agents) take their `path` arg: an entry path -> kb-entry, else the domain.
 *  - `kb_*` tools (none exist today; kept for when one does): args `entryId` / `sectionId` / `domain`.
 */
import { kbEntryOfPath } from "./activity-publisher.js";

export interface KbTarget { kind: "kb-entry" | "kb-section" | "domain"; id: string; domain?: string }

const MAX_BASH_TARGETS = 3;
const DOMAIN_FILE = /(?:^|[\\/])kb-mirror[\\/]domains[\\/]([^\\/\s'"]+)[\\/](?:INDEX\.md|_digest\.json)$/;
const KB_PATH = /[^\s'"`;|&<>()]*kb-mirror[\\/]domains[\\/][^\s'"`;|&<>()]*/g;
const READ_VERB = /(?:^|[\s;|&(])(?:cat|grep|egrep|rg|find|head|tail|sed|awk|less|ls|jq)(?=\s)/;
/** A command that writes or removes (sed -i, tee, cp, mv, rm, dd) is not a read, even when it also names a read verb: denied. cp reads its source, but denying is the safe side. */
const WRITE_VERB = /(?:^|[\s;|&(])(?:tee|cp|mv|rm|dd|install|truncate)(?=\s)|(?:^|[\s;|&(])sed\s+(?:[^|;&]*\s)?(?:-[A-Za-z]*i|--in-place)/;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

function ofPath(p: string): KbTarget | undefined {
  const e = kbEntryOfPath(p);
  if (e) return { kind: "kb-entry", id: e.id, domain: e.domain };
  const d = DOMAIN_FILE.exec(p);
  if (d) return { kind: "domain", id: d[1]!, domain: d[1]! };
  return undefined;
}

function ofBashPath(p: string): KbTarget | undefined {
  const hit = ofPath(p);
  if (hit) return hit;
  const m = /kb-mirror[\\/]domains[\\/]([^\\/\s]+)/.exec(p);
  return m && SAFE_ID.test(m[1]!) ? { kind: "domain", id: m[1]!, domain: m[1]! } : undefined;
}

export function kbTargetsOfTool(toolName: string, args: unknown): KbTarget[] {
  try {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    if (toolName === "read") {
      const t = typeof a.path === "string" ? ofPath(a.path) : undefined;
      return t ? [t] : [];
    }
    if (toolName === "bash" || toolName === "guarded_bash") {
      const cmd = a.command;
      if (typeof cmd !== "string" || cmd.length > 4000 || !READ_VERB.test(cmd) || WRITE_VERB.test(cmd) || /(?:^|[^<>-])>{1,2}\s*\S*kb-mirror/.test(cmd)) return [];
      const out: KbTarget[] = [];
      const seen = new Set<string>();
      for (const m of cmd.matchAll(KB_PATH)) {
        const t = ofBashPath(m[0]);
        if (!t || seen.has(`${t.kind}:${t.id}`)) continue;
        seen.add(`${t.kind}:${t.id}`);
        out.push(t);
        if (out.length >= MAX_BASH_TARGETS) break;
      }
      return out;
    }
    if (toolName === "grep" || toolName === "find" || toolName === "ls") {
      const t = typeof a.path === "string" && a.path.length <= 1000 ? ofBashPath(a.path) : undefined;
      return t ? [t] : [];
    }
    if (toolName.startsWith("kb_")) {
      const s = (v: unknown) => (typeof v === "string" && SAFE_ID.test(v) ? v : undefined);
      const domain = s(a.domain);
      const entry = s(a.entryId) ?? s(a.entry_id);
      const section = s(a.sectionId) ?? s(a.section_id);
      if (entry) return [{ kind: "kb-entry", id: entry, ...(domain ? { domain } : {}) }];
      if (section) return [{ kind: "kb-section", id: section, ...(domain ? { domain } : {}) }];
      if (domain) return [{ kind: "domain", id: domain, domain }];
    }
    return [];
  } catch {
    return [];
  }
}

/** Per-thread throttle for kb-read: the same target at most once per `windowMs`, at most `turnCap` per turn. Bounded memory. */
export class KbReadThrottle {
  private seen = new Map<string, Map<string, number>>();
  private count = new Map<string, number>();
  constructor(private readonly windowMs = 30_000, private readonly turnCap = 10, private readonly perThreadMax = 64) {}

  allow(threadId: string, t: KbTarget, now = Date.now()): boolean {
    if ((this.count.get(threadId) ?? 0) >= this.turnCap) return false;
    let m = this.seen.get(threadId);
    if (!m) this.seen.set(threadId, (m = new Map()));
    const key = `${t.kind}:${t.domain ?? ""}:${t.id}`;
    const last = m.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    m.delete(key);
    m.set(key, now);
    if (m.size > this.perThreadMax) m.delete(m.keys().next().value as string);
    this.count.set(threadId, (this.count.get(threadId) ?? 0) + 1);
    return true;
  }

  newTurn(threadId: string): void { this.count.delete(threadId); }
  forget(threadId: string): void { this.seen.delete(threadId); this.count.delete(threadId); }
}
