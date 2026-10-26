/**
 * Sandbox start path: validate the dev root, resolve the redirected roots, get the snapshot ledger served by the ONE
 * local Work server (own it, or attach to the owner's), and prove (fail closed) that nothing outward still points at
 * a live location. A shared sandbox (several wolves, one root) has exactly one work-ledger writer, enforced on disk
 * by the writer lock (see engine/sandbox/work-writer.ts); workerd normally owns it so it outlives the wolves.
 */
import { randomBytes } from "node:crypto";
import {
  acquireWorkWriterLock,
  assertLibrarianSandboxed,
  assertSandboxed,
  assertSandboxedPaths,
  SandboxError,
  readWorkServerRunFile,
  requireSnapshotRoot,
  resolveSandbox,
  sandboxEnv,
  type ResolvedSandbox,
  type WriterLock,
} from "@wolfpack/engine";
import { kbLockFile } from "@wolfpack/kb/librarian";
import { ledgerFile, vectorsDir, workLedgerFile, type KbRoots } from "@wolfpack/kb/shared";

export interface LocalWorkServerHandle {
  url: string;
  close(): Promise<void>;
}
export type StartWorkServer = (opts: { ledgerDir: string; token: string; writerLock?: WriterLock }) => Promise<LocalWorkServerHandle>;

export interface RunningSandbox {
  resolved: ResolvedSandbox;
  /** WOLF_DEN, KB_OPS, KB_DEN_LOCAL, WORK_ENDPOINT, WORK_TOKEN for the sandboxed wolf. */
  env: Record<string, string>;
  close(): Promise<void>;
}

const defaultStartWorkServer: StartWorkServer = async (o) => {
  const { startLocalWorkServer } = await import("@wolfpack/agent");
  return startLocalWorkServer(o);
};

/** One sandboxed wolf per process: its env patch is process-wide (see {@link patchProcessEnv}). */
let active: string | undefined;

/**
 * Patch process.env with the sandbox env and return a restore function. This is a FALLBACK for code that only
 * reads process.env; code that takes an env (extension context.env, startWolf's env) should use that instead.
 * It does not guard against a second patch: the one-sandbox-per-process rule is enforced by {@link startSandbox}.
 */
export function patchProcessEnv(patch: Record<string, string>): () => void {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  Object.assign(process.env, patch);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Everything a librarian's sweep writes besides KB_BASE/KB_OPS: den-local ledgers, vectors and the sweep lock. */
export function librarianRoots(r: ResolvedSandbox): KbRoots & { extra: Record<string, string> } {
  const roots: KbRoots = { kbBase: r.kbBase ?? "", opsRoot: r.kbOps, denLocal: r.kbDenLocal };
  return {
    ...roots,
    extra: { sweepLock: kbLockFile(roots), vectors: vectorsDir(roots), kbLedger: ledgerFile(roots), workLedger: workLedgerFile(roots) },
  };
}

/** Librarian mode needs a KB copy and every path it writes inside the root; anything else is refused. */
export function assertLibrarianResolved(root: string, r: ResolvedSandbox): void {
  const lr = librarianRoots(r);
  assertLibrarianSandboxed(root, { kbBase: r.kbBase, kbOps: r.kbOps, denLocal: r.kbDenLocal, extra: lr.extra });
}

async function pingWorkServer(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The work server for `root`: attach to the live owner's (run file + /ping), else take the writer lock and start it.
 * A live writer that cannot be attached to fails loudly (the lock refuses a second one); it never starts a second.
 */
async function acquireWorkServer(
  root: string,
  startWorkServer: StartWorkServer,
  ledgerDir: string,
): Promise<{ url: string; token: string; owned: boolean; close(): Promise<void> }> {
  const run = readWorkServerRunFile(root);
  if (run && (await pingWorkServer(run.url))) return { url: run.url, token: run.token, owned: false, close: async () => {} };
  const lock = acquireWorkWriterLock(root); // throws SandboxError if a live process still holds the ledger
  const token = randomBytes(24).toString("hex");
  let server: LocalWorkServerHandle | undefined;
  try {
    server = await startWorkServer({ ledgerDir, token, writerLock: lock });
    lock.publish({ url: server.url, token });
    const started = server;
    return {
      url: started.url,
      token,
      owned: true,
      close: async () => {
        try {
          await started.close();
        } finally {
          lock.release();
        }
      },
    };
  } catch (e) {
    // Never leave a listening server behind a released lock (a second writer could then start): close it FIRST.
    try {
      await server?.close();
    } catch { /* closing best effort; the lock is released either way */ }
    lock.release();
    throw e;
  }
}

export interface SharedWorkServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Start (own) the single work server of a shared sandbox without any wolf: what workerd does once per dev root before it
 * spawns the wolves. Throws if the root is not a snapshot or a live writer already exists.
 */
export async function startSharedWorkServer(root: string, opts: { startWorkServer?: StartWorkServer } = {}): Promise<SharedWorkServer> {
  requireSnapshotRoot(root);
  const pre = resolveSandbox(root);
  assertSandboxedPaths(root, pre);
  const s = await acquireWorkServer(root, opts.startWorkServer ?? defaultStartWorkServer, pre.workLedgerDir);
  if (!s.owned) throw new SandboxError(`the work ledger in ${root} already has a running work server (${s.url}); not starting a second`);
  return { url: s.url, close: s.close };
}

export async function startSandbox(
  root: string,
  opts: { startWorkServer?: StartWorkServer; librarian?: boolean; wolf?: string } = {},
): Promise<RunningSandbox> {
  if (active) throw new SandboxError(`a sandbox (${active}) is already running in this process; one sandboxed wolf per process`);
  requireSnapshotRoot(root);
  const pre = resolveSandbox(root, { wolf: opts.wolf });
  assertSandboxedPaths(root, pre);
  // Librarian mode mutates KB_BASE: only on the sandbox's own KB copy, every path it writes inside the root.
  if (opts.librarian) assertLibrarianResolved(root, pre);
  active = root;
  let server: Awaited<ReturnType<typeof acquireWorkServer>>;
  try {
    server = await acquireWorkServer(root, opts.startWorkServer ?? defaultStartWorkServer, pre.workLedgerDir);
  } catch (e) {
    active = undefined;
    throw e;
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    active = undefined;
    await server.close();
  };
  try {
    const resolved = resolveSandbox(root, { workEndpoint: server.url, wolf: opts.wolf });
    assertSandboxed(root, { den: resolved.den, kbOps: resolved.kbOps, kbDenLocal: resolved.kbDenLocal, kbBase: resolved.kbBase, workEndpoint: resolved.workEndpoint });
    return { resolved, env: sandboxEnv(resolved, server.token), close };
  } catch (e) {
    await close().catch(() => {});
    throw e;
  }
}
