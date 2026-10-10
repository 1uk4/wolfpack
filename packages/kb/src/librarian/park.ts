/**
 * park — keep one bad contribution from blocking the sweep.
 *
 * Each contribution gets a time budget (SWEEP.itemBudgetMs). An item that runs
 * over it is parked at once; an item that fails is retried on later ticks and
 * parked after SWEEP.maxAttempts. Parked items move from inbox/<wolf>/ to
 * parked/<wolf>/ (never synced back to wolves), get a receipt with the reason,
 * and wait for `wolfpack-kb unpark`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type KbRoots, type ParsedContribution, inboxDir, parkedDir } from "../shared/index.js";
import { writeReceipt } from "./commit.js";

/** Thrown when a contribution runs past its time budget. */
export class BudgetExceeded extends Error {
  constructor(ms: number) {
    super(`over its ${Math.round(ms / 1000)}s time budget`);
    this.name = "BudgetExceeded";
  }
}

/**
 * Run `fn` with an abort signal that fires after `ms`. Rejects with
 * BudgetExceeded at the deadline even if `fn` ignores the signal, so a
 * non-cooperative await (e.g. an embedding call) can't hold the sweep either.
 */
export async function withBudget<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new BudgetExceeded(ms);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ── attempt tracking (den-local, never synced) ──────────────────────────────

type Attempts = Record<string, { attempts: number; lastReason: string }>;
const attemptsFile = (roots: KbRoots) => join(roots.denLocal, "sweep-attempts.json");

function readAttempts(roots: KbRoots): Attempts {
  try {
    return JSON.parse(readFileSync(attemptsFile(roots), "utf-8"));
  } catch {
    return {};
  }
}

function writeAttempts(roots: KbRoots, a: Attempts): void {
  mkdirSync(dirname(attemptsFile(roots)), { recursive: true });
  writeFileSync(attemptsFile(roots), JSON.stringify(a, null, 2));
}

/** Record a failed attempt; returns the attempt count so far. */
export function recordFailure(roots: KbRoots, c: ParsedContribution, reason: string): number {
  const a = readAttempts(roots);
  const prev = a[c.contentHash]?.attempts ?? 0;
  a[c.contentHash] = { attempts: prev + 1, lastReason: reason };
  writeAttempts(roots, a);
  return prev + 1;
}

/** Forget attempts for a contribution (after success, park, or unpark). */
export function clearAttempts(roots: KbRoots, contentHash: string): void {
  const a = readAttempts(roots);
  if (!(contentHash in a)) return;
  delete a[contentHash];
  writeAttempts(roots, a);
}

// ── park / unpark ───────────────────────────────────────────────────────────

/** Move a contribution out of the inbox into parked/<wolf>/ with a receipt. */
export function park(roots: KbRoots, c: ParsedContribution, reason: string): void {
  if (existsSync(c.filePath)) {
    const dir = parkedDir(roots, c.from);
    mkdirSync(dir, { recursive: true });
    renameSync(c.filePath, join(dir, basename(c.filePath)));
  }
  writeReceipt(roots, c.from, c, "parked", `${reason}. Re-run with: wolfpack-kb unpark ${c.from}/${basename(c.filePath)}`);
  clearAttempts(roots, c.contentHash);
}

export interface ParkedItem {
  wolf: string;
  file: string;
}

export function listParked(roots: KbRoots): ParkedItem[] {
  const base = join(roots.opsRoot, "parked");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(join(base, d.name))
        .filter((f) => f.endsWith(".md"))
        .map((file) => ({ wolf: d.name, file }))
    );
}

/** Move parked items (all, or those matching "<wolf>/<file>" or "<wolf>") back to the inbox. */
export function unpark(roots: KbRoots, match?: string): ParkedItem[] {
  const picked = listParked(roots).filter(
    (p) => !match || match === p.wolf || match === `${p.wolf}/${p.file}`
  );
  for (const p of picked) {
    const dest = inboxDir(roots, p.wolf);
    mkdirSync(dest, { recursive: true });
    renameSync(join(parkedDir(roots, p.wolf), p.file), join(dest, p.file));
  }
  return picked;
}
