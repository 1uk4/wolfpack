/**
 * Where the updated parent-feature body goes after a task ships. With WORK_ENDPOINT set the KB tree belongs to the hub/Dewey (a worker's
 * KB_BASE is a read-only mirror), so the body is sent through the Work API (PATCH /work/:id {body}, packages/agent routes/work.ts).
 * Without an endpoint (librarian, sandbox) the local write stays. An HTTP failure is logged, the user is notified, and the body is spilled to
 * $WOLF_DEN/work-spill/<parentId>-<ts>.md (outside KB_BASE) so it can be replayed; it never falls back to a write into the mirror.
 */
import { mkdirSync, writeFileSync } from "node:fs";
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
  if (!token.trim()) {
    const w = `WORK_ENDPOINT is set but WORK_TOKEN is missing: the Work API will reject the parent summary update`;
    log(`[work] ${w}`);
    notify(w, "warning");
  }
  try {
    await (opts.client ?? new WorkClient(env.WORK_ENDPOINT, token)).updateBody(String(parent.id), body);
    return { status: "remote" };
  } catch (e: any) {
    const error = scrub(String(e?.message ?? e));
    let spillPath: string | undefined;
    if (env.WOLF_DEN) {
      try {
        const dir = join(env.WOLF_DEN, "work-spill");
        mkdirSync(dir, { recursive: true });
        spillPath = join(dir, `${parent.id}-${(opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-")}.md`);
        writeFileSync(spillPath, body);
      } catch (se: any) {
        log(`[work] could not spill parent body: ${scrub(String(se?.message ?? se))}`);
        spillPath = undefined;
      }
    }
    const msg = `Parent ${parent.id} summary NOT saved: Work API update failed (${error}); not writing into the KB mirror.${spillPath ? ` Body saved to ${spillPath} for replay.` : ""}`;
    log(`[work] ${msg}`);
    notify(msg, "error");
    return { status: "failed", spillPath, error };
  }
}
