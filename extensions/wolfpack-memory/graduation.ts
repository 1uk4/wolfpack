/**
 * The graduation wiring of a wolf, shared by the agent's `task_graduate` tool and wolfd's graduate routes (via the
 * graduation registry in the harness): the preview token file with its TTL, the token check at confirm, the drain, and
 * the unbinding of every conversation holding the graduated feature. previewGraduation / confirmGraduation themselves
 * stay in @wolfpack/memory; this only wires them to a wolf.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Engine } from "@wolfpack/engine";
import type { WorkItem } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { WorkQueuedError } from "./work-client.js";
import {
  prepareGraduation,
  drainScope,
  loadGraduationScope,
  previewGraduation,
  readinessOf,
  type DrainWork,
  type GraduationClient,
  type GraduationPreview,
} from "@wolfpack/memory";
import { THREAD_RUNNING_MESSAGE, GRADUATION_PREVIEW_TTL_MS, GraduationError, type ThreadRunningCheck, readPool, type GraduationConfirmResult, type GraduationObservationCount, type GraduationPreviewResult } from "./memory-actions.js";

/** A graduation preview waits this long for the owner's answer. */
export const PREVIEW_TTL_MS = GRADUATION_PREVIEW_TTL_MS;

export interface GraduationDeps {
  client: GraduationClient;
  wolfDen: string;
  wolfName: string;
  /** The KB roots, or null when this wolf has none. */
  roots: () => KbRoots | null;
  /** The model engine distill runs on. */
  engine: () => Engine;
  /** Folds the pending observations of the item and its tasks into the Record. */
  drain: DrainWork;
  /** Ships an item that is not complete yet. */
  ship: (id: string) => Promise<unknown>;
  /** Final feature pass before the distill (memory.workLog: append). Not set by the durable runtime today. */
  finalPass?: (featureId: string) => Promise<unknown>;
  /**
   * Files an owner-approval request on the hub (never acts on the item): resolves with the request id and whether one was
   * already pending; throws when the hub does not hold the request. A wolf's worker token cannot graduate, so the hub does it on approval.
   */
  fileRequest: (id: string, body: { kind: "graduate"; preview: { contributions: GraduationPreview["contributions"]; summary?: string } }) => Promise<{ requestId: string; existing: boolean }>;
  /** Called with every item that graduated (cache invalidation). */
  forget?: (id: string) => void;
  /** Called once a graduation has happened (after the unbind), with the graduated item: the promote pass for its topics. Never breaks the graduation. */
  onGraduated?: (id: string) => void;
  /** wolfd's check of the item's feature thread (a turn or sub-agents running), read at call time. Unset: no check. */
  threadRunning?: () => ThreadRunningCheck | undefined;
}

export function createGraduation(deps: GraduationDeps) {
  const { client, wolfDen } = deps;
  const previewDir = () => join(wolfDen, "tasks", "graduation");
  const previewFile = (token: string) => join(previewDir(), `${token.replace(/[^a-f0-9]/g, "")}.json`);
  const needRoots = (): KbRoots => {
    const roots = deps.roots();
    if (!roots) throw new GraduationError("unavailable", "The knowledge base is not configured for this wolf (KB_BASE / KB_OPS).");
    return roots;
  };

  /** Refuse an item that is not ready with the reason, before any model work. */
  /** Refuse while the item's feature thread has a turn or running sub-agents: nothing is distilled or filed. */
  function assertIdle(id: string, callerConversation?: number): void {
    const why = deps.threadRunning?.()?.(id, callerConversation);
    if (why) throw new GraduationError("thread_running", `${THREAD_RUNNING_MESSAGE}: ${why}. Graduate once it is idle.`);
  }

  async function assertReady(id: string, callerConversation?: number): Promise<WorkItem[]> {
    assertIdle(id, callerConversation);
    const all = await loadGraduationScope(client, id);
    const item = all.find((i) => i.id === id);
    const r = readinessOf(item, all);
    if (!r.ready) throw new GraduationError("not_ready", `${item?.title ?? id} is not ready to graduate: ${r.reason}`);
    return all;
  }

  /** Refusals keep their code; anything else stops the graduation with nothing archived. */
  const asFailure = (err: unknown): Error => {
    if (err instanceof GraduationError || (err as { name?: string })?.name === "GraduationError") return err as GraduationError;
    // A write saved in the outbox (hub unreachable) is not a failure: the caller reports it as queued.
    if (err instanceof WorkQueuedError) return err;
    const message = err instanceof Error ? err.message : String(err);
    // previewGraduation / confirmGraduation throw plain Errors: the not-ready and blocked ones are the owner's to fix.
    return new GraduationError(/is (no longer|not) ready to graduate|^cannot send:/.test(message) ? "not_ready" : "failed", message);
  };

  /** Step 1: distill, write the token file. Nothing is sent or archived. */
  async function preview(id: string, callerConversation?: number): Promise<GraduationPreview> {
    try {
      const scope = await assertReady(id, callerConversation);
      const roots = needRoots();
      const p = await previewGraduation({ client, engine: deps.engine(), id, roots, drain: deps.drain, finalPass: deps.finalPass, scope });
      await mkdir(previewDir(), { recursive: true });
      await writeFile(previewFile(p.token), JSON.stringify(p));
      return p;
    } catch (err) {
      throw asFailure(err);
    }
  }

  /** The stored preview for this token, if it is for this item and still fresh. */
  async function loadPreview(id: string, token: string): Promise<GraduationPreview> {
    const file = previewFile(token);
    if (!existsSync(file)) throw new GraduationError("preview_stale", "No such preview (or it was already used). Preview again to get a fresh one.");
    const p = JSON.parse(await readFile(file, "utf-8")) as GraduationPreview;
    if (p.itemId !== id) throw new GraduationError("preview_stale", `That token is for ${p.itemId}, not ${id}.`);
    if (Date.now() - Date.parse(p.createdAt) > PREVIEW_TTL_MS) {
      throw new GraduationError("preview_stale", "That preview is too old. Preview again for a fresh one and check it again.");
    }
    return p;
  }

  /**
   * Step 2: check the token, run the wolf-side steps (late drain, final pass, re-distill, ship an incomplete item), then file
   * a graduate approval request carrying the contributions. Nothing is written to the inbox and the item is not graduated
   * here: the hub delivers and graduates on the owner's approval. The token is used up only once the hub holds the request,
   * so a failed filing can be confirmed again.
   */
  async function confirm(id: string, token: string): Promise<{ preview: GraduationPreview; requestId: string; existing: boolean; lateFolded: number }> {
    try {
      assertIdle(id);
      const roots = needRoots();
      const p = await loadPreview(id, token);
      const prepared = await prepareGraduation({ client, roots, preview: p, ship: deps.ship, drain: deps.drain, finalPass: deps.finalPass, engine: deps.engine() });
      const { requestId, existing } = await deps.fileRequest(id, { kind: "graduate", preview: { contributions: prepared.preview.contributions, ...(prepared.preview.summary ? { summary: prepared.preview.summary } : {}) } });
      await unlink(previewFile(token)).catch(() => { /* used once */ });
      return { preview: prepared.preview, requestId, existing, lateFolded: prepared.lateFolded };
    } catch (err) {
      throw asFailure(err);
    }
  }

  /** The preview as the wire carries it. */
  const toResult = (p: GraduationPreview): GraduationPreviewResult => ({
    itemId: p.itemId,
    kind: p.kind,
    title: p.title,
    domain: p.domain,
    contributions: p.contributions.map((c) => ({
      id: c.id,
      title: c.title,
      summary: c.summary,
      body: c.body,
      initiative: c.initiative,
      history: c.history,
      ...(c.target ? { target: c.target } : {}),
      ...(c.feature ? { feature: true } : {}),
    })),
    foldedObservations: p.foldedObservations ?? 0,
    warnings: p.warnings,
    ...(p.blocked ? { blocked: p.blocked } : {}),
    archive: p.archive,
    token: p.token,
    createdAt: p.createdAt,
    readiness: { ready: true },
  });

  /**
   * The newest unexpired stored preview of this item (token files outlive a wolfd restart). Expired token files found on
   * the way are deleted. Readiness is not rechecked here: confirm rechecks it (and the token) before anything is sent.
   */
  async function pendingPreview(id: string): Promise<GraduationPreviewResult | undefined> {
    let names: string[] = [];
    try {
      names = await readdir(previewDir());
    } catch {
      return undefined;
    }
    let best: GraduationPreview | undefined;
    for (const n of names.filter((f) => f.endsWith(".json"))) {
      try {
        const file = join(previewDir(), n);
        const p = JSON.parse(await readFile(file, "utf-8")) as GraduationPreview;
        if (Date.now() - Date.parse(p.createdAt) > PREVIEW_TTL_MS) {
          await unlink(file).catch(() => { /* already gone */ });
          continue;
        }
        if (p.itemId !== id) continue;
        if (!best || Date.parse(p.createdAt) > Date.parse(best.createdAt)) best = p;
      } catch {
        // an unreadable token file is not a preview
      }
    }
    return best ? toResult(best) : undefined;
  }

  /** Pending observations of this wolf's pool that a graduation of the item folds: tagged with the item or a descendant. */
  async function observations(id: string): Promise<GraduationObservationCount> {
    try {
      const all = await loadGraduationScope(client, id);
      const item = all.find((i) => i.id === id);
      if (!item) throw new GraduationError("not_ready", `${id} was not found`);
      const scope = new Set(drainScope(item, all));
      const counts = new Map<string, number>();
      for (const o of await readPool(wolfDen)) {
        // The same match the drain uses: tagged with a work id in scope, else with a feature in scope.
        const w = o.work && scope.has(o.work) ? o.work : o.feature && scope.has(o.feature) ? o.feature : undefined;
        if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
      }
      const byWork = [...counts]
        .map(([wid, count]) => {
          const title = all.find((i) => i.id === wid)?.title;
          return { id: wid, ...(title ? { title } : {}), count };
        })
        .sort((x, y) => y.count - x.count);
      return { total: byWork.reduce((n, b) => n + b.count, 0), byWork };
    } catch (err) {
      throw asFailure(err);
    }
  }

  /** The registry face wolfd's routes call. */
  const actions = {
    async preview(id: string): Promise<GraduationPreviewResult> {
      return toResult(await preview(id));
    },
    async confirm(id: string, token: string): Promise<GraduationConfirmResult> {
      const r = await confirm(id, token);
      return { requestId: r.requestId, status: r.existing ? "pending" : "filed", entries: r.preview.contributions.map((c) => c.id), archived: [], lateFolded: r.lateFolded, unbound: 0 };
    },
    pendingPreview,
    observations,
  };

  return { preview, loadPreview, confirm, actions };
}
