/**
 * Durable disk outbox of contributions waiting for the hub, plus the receipt writer.
 *
 * One file per item: `<dir>/<time>-<n>-<id>.json` = {id, wolf, contribution, queuedAt}. Written with write-to-temp, fsync, rename,
 * fsync of the directory, so a crash leaves either the whole item or nothing. An item leaves the outbox only when the hub
 * acknowledges it (accepted or duplicate); a terminal rejection moves it to `<dir>/rejected/` (kept for the operator, never retried).
 * The `id` is the idempotency id: it is generated once at enqueue and survives restarts, so a replay is recognised by the hub.
 */
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { LINK_CONTRIBUTION_MAX_BYTES } from "@wolfpack/protocol";

export interface OutboxItem {
  id: string;
  wolf: string;
  contribution: Record<string, unknown>;
  queuedAt: string;
}

export class OutboxError extends Error {}

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* some platforms cannot fsync a directory */
  }
}

/** Atomic durable write: temp file, fsync, rename, fsync dir. */
export function writeFileDurable(file: string, data: string): void {
  const dir = join(file, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  fsyncDir(dir);
}

export class Outbox {
  private n = 0;
  constructor(
    readonly dir: string,
    private readonly opts: { maxItemBytes?: number; maxItems?: number } = {},
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Queue an item durably. Throws OutboxError when it is too large or the outbox is full. */
  enqueue(wolf: string, contribution: Record<string, unknown>, id: string = randomUUID()): OutboxItem {
    if (!ID_RE.test(id)) throw new OutboxError(`bad idempotency id ${JSON.stringify(id.slice(0, 40))}`);
    const max = this.opts.maxItemBytes ?? LINK_CONTRIBUTION_MAX_BYTES;
    const bytes = Buffer.byteLength(JSON.stringify(contribution));
    if (bytes > max) throw new OutboxError(`contribution is ${bytes} bytes; the limit is ${max}`);
    const existing = this.list();
    if (existing.some((i) => i.id === id)) return existing.find((i) => i.id === id)!;
    if (existing.length >= (this.opts.maxItems ?? 10_000)) throw new OutboxError(`outbox is full (${existing.length} items)`);
    const item: OutboxItem = { id, wolf, contribution, queuedAt: new Date().toISOString() };
    writeFileDurable(join(this.dir, `${String(Date.now()).padStart(15, "0")}-${String(this.n++).padStart(6, "0")}-${id}.json`), JSON.stringify(item));
    return item;
  }

  private files(): string[] {
    return readdirSync(this.dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
  }

  /** Pending items, oldest first. Unreadable files are skipped. */
  list(): OutboxItem[] {
    const out: OutboxItem[] = [];
    for (const f of this.files()) {
      try {
        const o = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as OutboxItem;
        if (typeof o.id === "string" && typeof o.wolf === "string" && o.contribution && typeof o.contribution === "object") out.push(o);
      } catch {
        /* torn or foreign file */
      }
    }
    return out;
  }

  private fileOf(id: string): string | undefined {
    return this.files().find((f) => f.endsWith(`-${id}.json`));
  }

  /** The hub has it: forget the item. */
  remove(id: string): void {
    const f = this.fileOf(id);
    if (f) {
      rmSync(join(this.dir, f), { force: true });
      fsyncDir(this.dir);
    }
  }

  /** Terminal rejection: keep the item (with the reason) under rejected/ and stop retrying it. */
  reject(id: string, reason: string): void {
    const f = this.fileOf(id);
    if (!f) return;
    const dest = join(this.dir, "rejected");
    mkdirSync(dest, { recursive: true });
    try {
      const o = JSON.parse(readFileSync(join(this.dir, f), "utf8"));
      writeFileDurable(join(dest, f), JSON.stringify({ ...o, rejectedAt: new Date().toISOString(), reason }));
    } finally {
      rmSync(join(this.dir, f), { force: true });
      fsyncDir(this.dir);
    }
  }

  get size(): number {
    return this.files().length;
  }
}

const WOLF_RE = /^[a-z0-9][a-z0-9._-]*$/;
const RECEIPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/** Write a receipt where the wolf expects it today: `<kbOps>/receipts/<wolf>/<name>` (kb receiptsDir). Durable and idempotent. */
export function writeReceiptFile(kbOps: string, wolf: string, name: string, content: string): string {
  if (!WOLF_RE.test(wolf)) throw new Error(`bad wolf name ${JSON.stringify(wolf.slice(0, 40))}`);
  if (!RECEIPT_NAME_RE.test(name)) throw new Error(`bad receipt file name ${JSON.stringify(name.slice(0, 60))}`);
  const file = join(kbOps, "receipts", wolf, name);
  writeFileDurable(file, content);
  return file;
}
