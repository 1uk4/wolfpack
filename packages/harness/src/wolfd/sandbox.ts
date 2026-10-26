/**
 * Sandbox start path: validate the dev root, resolve the redirected roots, serve the snapshot ledger with the
 * local Work server, and prove (fail closed) that nothing outward still points at a live location.
 */
import { randomBytes } from "node:crypto";
import {
  assertSandboxed,
  assertSandboxedPaths,
  SandboxError,
  requireSnapshotRoot,
  resolveSandbox,
  sandboxEnv,
  type ResolvedSandbox,
} from "@wolfpack/engine";

export interface LocalWorkServerHandle {
  url: string;
  close(): Promise<void>;
}
export type StartWorkServer = (opts: { ledgerDir: string; token: string }) => Promise<LocalWorkServerHandle>;

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

export async function startSandbox(
  root: string,
  opts: { startWorkServer?: StartWorkServer; librarian?: boolean } = {},
): Promise<RunningSandbox> {
  if (opts.librarian) throw new SandboxError("librarian mode mutates KB_BASE and is refused in a sandbox; remove memory.librarian");
  if (active) throw new SandboxError(`a sandbox (${active}) is already running in this process; one sandboxed wolf per process`);
  requireSnapshotRoot(root);
  const pre = resolveSandbox(root);
  assertSandboxedPaths(root, pre);
  active = root;
  const token = randomBytes(24).toString("hex");
  let server: LocalWorkServerHandle;
  try {
    server = await (opts.startWorkServer ?? defaultStartWorkServer)({ ledgerDir: pre.workLedgerDir, token });
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
    const resolved = resolveSandbox(root, { workEndpoint: server.url });
    assertSandboxed(root, { den: resolved.den, kbOps: resolved.kbOps, kbDenLocal: resolved.kbDenLocal, workEndpoint: resolved.workEndpoint });
    return { resolved, env: sandboxEnv(resolved, token), close };
  } catch (e) {
    await close().catch(() => {});
    throw e;
  }
}
