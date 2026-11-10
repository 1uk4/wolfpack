/**
 * Idempotency for work-proxy writes. A wolf that could not reach the hub saves its write and resends it later with the same
 * `Idempotency-Key`; a write that did land before the wolf gave up (a timeout after the hub applied it) must not apply twice.
 * Each key keeps the first successful answer, so a resend gets that answer (a resent create returns the item it made).
 *
 * GUARANTEE: a resend within 7 days (KEEP_MS) of the first answer is deduplicated, however many other writes happen in between
 * (eviction is by age only; there is no count cap). A resend after that applies again.
 * LIMIT: the store lives in link/, which `hubd export` does not export (transient link state). After an export/import (or a
 * migration to a new data dir) the keys are gone, so a wolf outbox replaying a write that already landed before the move
 * applies it a second time. Drain the wolves' outboxes (hub reachable, nothing queued) before exporting.
 *
 * Append-only JSONL, fsynced per add, compacted when expired lines dominate. Survives a torn last line (skipped on load; the
 * next add starts on a fresh line).
 * WRITES: <dataDir>/link/work-idempotency.jsonl (0600).
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { HubError } from "./errors.js";

export interface StoredAnswer {
  status: number;
  body: unknown;
}

/** How long a key is remembered. A wolf's outbox replays well within this; an outage longer than a week is not deduplicated. */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry extends StoredAnswer { t: number }

export class WorkIdempotency {
  /** Insertion order = answer time order, so the oldest key is always first. */
  private m = new Map<string, Entry>();
  private lines = 0;
  private needNewline = false;
  private now: () => number;

  constructor(private file: string, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    mkdirSync(dirname(file), { recursive: true });
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (text.length && !text.endsWith("\n")) this.needNewline = true;
    for (const l of text.split("\n")) {
      if (!l) continue;
      try {
        const o = JSON.parse(l) as { k?: unknown; s?: unknown; b?: unknown; t?: unknown };
        if (typeof o.k === "string" && typeof o.s === "number" && !this.m.has(o.k)) {
          // A line without a time (written before times were kept) gets time 0: it is the oldest, so it is evicted on load and the
          // map stays oldest-first (evict stops at the first fresh key).
          this.m.set(o.k, { status: o.s, body: o.b, t: typeof o.t === "number" ? o.t : 0 });
          this.lines++;
        }
      } catch { /* torn line: skip */ }
    }
    this.evict();
  }

  get(key: string): StoredAnswer | undefined {
    this.evict();
    const e = this.m.get(key);
    return e ? { status: e.status, body: e.body } : undefined;
  }

  add(key: string, answer: StoredAnswer): void {
    if (this.m.has(key)) return;
    const t = this.now();
    const fd = openSync(this.file, "a", 0o600);
    try {
      writeSync(fd, (this.needNewline ? "\n" : "") + JSON.stringify({ k: key, s: answer.status, b: answer.body, t }) + "\n");
      fsyncSync(fd);
      this.needNewline = false;
    } finally {
      closeSync(fd);
    }
    this.m.set(key, { ...answer, t });
    this.lines++;
    this.evict();
    if (this.lines > 2 * this.m.size + 1000) this.compact();
  }

  /** Drop keys older than KEEP_MS (oldest first; stops at the first fresh one). */
  private evict(): void {
    const cutoff = this.now() - KEEP_MS;
    for (const [k, e] of this.m) {
      if (e.t >= cutoff) break;
      this.m.delete(k);
    }
  }

  private compact(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, [...this.m].map(([k, e]) => JSON.stringify({ k, s: e.status, b: e.body, t: e.t }) + "\n").join(""), { mode: 0o600 });
    const fd = openSync(tmp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    this.lines = this.m.size;
    this.needNewline = false;
  }
}

/** The key a request carries, or undefined without one. A key that is present but not bounded and printable is a 400. */
export function idempotencyKeyOf(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  const v = Array.isArray(header) ? header[0] : header;
  if (typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(v)) return v;
  throw new HubError("invalid_request", "Idempotency-Key must be 1-128 characters of A-Z a-z 0-9 . _ : -");
}
