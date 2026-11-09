/**
 * Where the updated parent-feature body goes after a task ships. With WORK_ENDPOINT set the KB tree belongs to the hub/Dewey (a worker's
 * KB_BASE is a read-only mirror), so the body is sent through the Work API (PATCH /work/:id {body}, packages/agent routes/work.ts).
 * Without an endpoint (librarian, sandbox) the local write stays. An HTTP failure is logged, the user is notified, and the body is spilled to
 * $WOLF_DEN/work-spill/<parentId>-<ts>.md (outside KB_BASE) so it can be replayed; it never falls back to a write into the mirror.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem, KbRoots } from "@wolfpack/kb/client";
import { commitWorkItem } from "@wolfpack/kb/client";
import { WorkClient } from "./work-client.js";

export type ParentBodyResult = { status: "remote" | "local" } | { status: "failed"; spillPath?: string; error: string };

export async function writeParentBody(
  roots: KbRoots,
  parent: WorkItem,
  body: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    /** The acting wolf, sent as X-Wolf (the caller's name, not process.env). */
    wolf?: string;
    client?: Pick<WorkClient, "updateBody">;
    log?: (m: string) => void;
    notify?: (m: string, level: "info" | "warning" | "error") => void;
    now?: () => Date;
  } = {},
): Promise<ParentBodyResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.error(m));
  const notify = opts.notify ?? (() => {});
  if (!env.WORK_ENDPOINT?.trim()) {
    commitWorkItem(roots, parent, body);
    return { status: "local" };
  }
  const token = env.WORK_TOKEN ?? "";
  const scrub = (m: string): string => (token ? m.split(token).join("***") : m);
  const tokenMissing = !token.trim();
  if (tokenMissing) log(`[work] WORK_ENDPOINT is set but WORK_TOKEN is missing: the Work API will reject the parent summary update`);
  try {
    await (opts.client ?? new WorkClient(env.WORK_ENDPOINT, token, undefined, undefined, opts.wolf)).updateBody(String(parent.id), body);
    return { status: "remote" };
  } catch (e: any) {
    const error = scrub(String(e?.message ?? e));
    let spillPath: string | undefined;
    try {
      const dir = env.WOLF_DEN ? join(env.WOLF_DEN, "work-spill") : join(tmpdir(), "wolfpack-work-spill");
      mkdirSync(dir, { recursive: true });
      const safeId = String(parent.id).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 80);
      spillPath = join(dir, `${safeId}-${(opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-")}.md`);
      writeFileSync(spillPath, body);
    } catch (se: any) {
      log(`[work] could not spill parent body: ${scrub(String(se?.message ?? se))}`);
      spillPath = undefined;
    }
    // One notification: failure + (missing token) + where the body went + how to replay it.
    const msg =
      `Parent ${parent.id} summary NOT saved: Work API update failed (${error}); not writing into the KB mirror.` +
      (tokenMissing ? " WORK_TOKEN is missing." : "") +
      (spillPath ? ` Body saved to ${spillPath}; replay with PATCH /work/${parent.id} {"body": <file contents>}.` : "");
    log(`[work] ${msg}`);
    notify(msg, "error");
    return { status: "failed", spillPath, error };
  }
}
