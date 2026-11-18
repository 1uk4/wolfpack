/**
 * Published diagrams: PNGs that a diagram tool (plugged into the visualizer agent) persists as
 * `<viz dir>/viz-<slug>-<ms>.png`, where the viz dir is
 * `WOLFPACK_VIZ_DIR` if set, else `<wolf den>/viz`.
 *
 * Ephemeral renders (the default) go to `$TMPDIR/wolfpack-viz`, which is cleaned up, possibly before the owner answers a
 * question that shows them. So only PERSISTED diagrams can be attached to a card. A diagram is named by its file name
 * alone: `diagramPath` takes an id and never a path, and refuses anything that is not exactly such a file in the viz dir.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/** `viz-<slug>-<ms>.png` exactly as `publish()` names it (slug is lowercase a-z0-9 and dashes). */
export const DIAGRAM_ID = /^viz-[a-z0-9]+(?:-[a-z0-9]+)*-\d+\.png$/;

export function vizDir(den: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WOLFPACK_VIZ_DIR?.trim();
  return override || join(den, "viz");
}

/** Absolute path of the published diagram `id` of this wolf, or undefined (bad shape, unknown, or not a plain file in the viz dir). */
export function diagramPath(den: string, id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!DIAGRAM_ID.test(id)) return undefined;
  const dir = vizDir(den, env);
  const file = join(dir, id);
  if (!existsSync(file)) return undefined;
  try {
    const real = realpathSync(file);
    if (!real.startsWith(realpathSync(dir) + sep) || !statSync(real).isFile()) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

/** Why `id` cannot be attached to a card (model-facing), or undefined. */
export function diagramProblem(den: string, id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (diagramPath(den, id, env)) return undefined;
  return `diagram "${id}" is not a published diagram. Use the filename returned by a diagram tool that persisted the PNG (like viz-my-diagram-1731000000000.png): an id only, never a path or URL; ephemeral renders cannot be attached.`;
}
