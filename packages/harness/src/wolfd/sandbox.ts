/**
 * Sandbox start path: validate the dev root, resolve the redirected roots, serve the snapshot ledger with the
 * local Work server, and prove (fail closed) that nothing outward still points at a live location.
 */
import { randomBytes } from "node:crypto";
import {
  assertSandboxed,
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

export async function startSandbox(root: string, opts: { startWorkServer?: StartWorkServer } = {}): Promise<RunningSandbox> {
  requireSnapshotRoot(root);
  const pre = resolveSandbox(root);
  assertSandboxed(root, pre);
  const token = randomBytes(24).toString("hex");
  const server = await (opts.startWorkServer ?? defaultStartWorkServer)({ ledgerDir: pre.workLedgerDir, token });
  try {
    const resolved = resolveSandbox(root, { workEndpoint: `${server.url}/work` });
    assertSandboxed(root, { den: resolved.den, kbOps: resolved.kbOps, kbDenLocal: resolved.kbDenLocal, workEndpoint: resolved.workEndpoint });
    return { resolved, env: sandboxEnv(resolved, token), close: () => server.close() };
  } catch (e) {
    await server.close().catch(() => {});
    throw e;
  }
}
