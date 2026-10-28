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
import type { KbRoots } from "@wolfpack/kb/shared";
import {
  confirmGraduation,
  drainScope,
  previewGraduation,
  readinessOf,
  unbindOnGraduation,
  type ConfirmedGraduation,
  type DrainWork,
  type GraduationClient,
  type GraduationPreview,
} from "@wolfpack/memory";
import { GRADUATION_PREVIEW_TTL_MS, GraduationError, readPool, type GraduationConfirmResult, type GraduationObservationCount, type GraduationPreviewResult } from "./memory-actions.js";

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
  /** Called with every item that graduated (cache invalidation). */
  forget?: (id: string) => void;
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
  async function assertReady(id: string): Promise<void> {
    const all = (await client.query({})) ?? [];
    const item = all.find((i) => i.id === id);
    const r = readinessOf(item, all);
    if (!r.ready) throw new GraduationError("not_ready", `${item?.title ?? id} is not ready to graduate: ${r.reason}`);
  }

  /** Refusals keep their code; anything else stops the graduation with nothing archived. */
  const asFailure = (err: unknown): GraduationError => {
    if (err instanceof GraduationError || (err as { name?: string })?.name === "GraduationError") return err as GraduationError;
    const message = err instanceof Error ? err.message : String(err);
    // previewGraduation / confirmGraduation throw plain Errors: the not-ready and blocked ones are the owner's to fix.
    return new GraduationError(/is (no longer|not) ready to graduate|^cannot send:/.test(message) ? "not_ready" : "failed", message);
  };

  /** Step 1: distill, write the token file. Nothing is sent or archived. */
  async function preview(id: string): Promise<GraduationPreview> {
    try {
      await assertReady(id);
      const roots = needRoots();
      const p = await previewGraduation({ client, engine: deps.engine(), id, roots, drain: deps.drain });
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
   * Step 2: check the token, then confirmGraduation (late drain, emit, graduate, archive: all or nothing), then unbind
   * every holder. `exceptRoot` is the calling conversation, which the caller unbinds itself.
   */
  async function confirm(id: string, token: string, opts: { exceptRoot?: number } = {}): Promise<{ preview: GraduationPreview; done: ConfirmedGraduation; unbound: number[]; warnings: string[] }> {
    try {
      const roots = needRoots();
      const p = await loadPreview(id, token);
      const done = await confirmGraduation({ client, roots, wolf: deps.wolfName, preview: p, ship: deps.ship, drain: deps.drain, engine: deps.engine() });
      await unlink(previewFile(token)).catch(() => { /* used once */ });
      // The graduation has happened (archived, token used): an unbind that fails is a warning, never an error, or the retry would find no token.
      let unbound: number[] = [];
      const warnings: string[] = [];
      try {
        unbound = afterGraduation(p, done, opts.exceptRoot);
      } catch (e) {
        warnings.push(`graduated, but unbinding the conversations failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { preview: p, done, unbound, warnings };
    } catch (err) {
      throw asFailure(err);
    }
  }

  /** Nothing more goes to a graduated feature: every conversation bound to it or to one of its tasks unbinds. */
  function afterGraduation(p: GraduationPreview, done: ConfirmedGraduation, exceptRoot?: number): number[] {
    const unbound = unbindOnGraduation(wolfDen, { id: p.itemId, title: p.title, archived: done.archived, exceptRoot });
    deps.forget?.(p.itemId);
    for (const a of done.archived) deps.forget?.(a);
    return unbound;
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
      const all = (await client.query({})) ?? [];
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
      const { done, unbound, warnings } = await confirm(id, token);
      return { entries: done.sent, archived: done.archived, lateFolded: done.lateFolded ?? 0, unbound: unbound.length, ...(warnings.length ? { warnings } : {}) };
    },
    pendingPreview,
    observations,
  };

  return { preview, loadPreview, confirm, actions };
}
