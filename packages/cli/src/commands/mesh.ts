/**
 * wolfpack mesh [--check]
 *
 *   mesh           reconcile the Syncthing fabric to match config (additive)
 *   mesh --check   report drift (missing + stale managed folders) without change
 *
 * The star topology + per-instance plan is computed in mesh.ts; this is the
 * thin command surface over reconcileMesh()/checkMesh().
 */

import { reconcileMesh, checkMesh, previewMesh } from "../mesh-reconcile.js";
import { confirm } from "../prompts.js";
import { c } from "../render.js";

export async function meshCmd(opts: { check?: boolean; yes?: boolean }): Promise<void> {
  if (opts.check) {
    console.log(c.bold("\n🔎 Mesh drift check\n"));
    const drift = await checkMesh();
    if (!drift.length) {
      console.log(c.green("  ✓ In sync — no missing or stale managed folders."));
      return;
    }
    for (const d of drift) {
      console.log(c.bold(`  ${d.instance}`));
      for (const m of d.missing) console.log(c.yellow(`    - missing: ${m}`));
      for (const s of d.stale) console.log(c.red(`    - stale:   ${s} (revoke manually until auto-prune)`));
    }
    console.log(c.dim("\n  Run `wolfpack mesh` to apply missing shares (additive)."));
    return;
  }

  // Preview first — this reconfigures Syncthing (and provisions remote systemd
  // units), so show exactly what will change and confirm before touching hosts.
  console.log(c.bold("\n🔗 Mesh reconcile — plan\n"));
  const preview = await previewMesh();
  if (preview.toProvision.length) {
    console.log(c.bold("  Provision new Syncthing instance:"));
    for (const p of preview.toProvision) console.log(c.yellow(`    + ${p}`));
  }
  if (preview.shares.length) {
    console.log(c.bold("  Folder wiring:"));
    for (const s of preview.shares) console.log(c.dim(`    • ${s}`));
  }
  if (!preview.toProvision.length && !preview.shares.length) {
    console.log(c.dim("  Nothing to wire (no remote wolves / domains)."));
    return;
  }

  const ok = opts.yes || (await confirm("\nApply this mesh configuration?", false));
  if (!ok) {
    console.log(c.dim("Aborted — no changes made."));
    return;
  }

  console.log(c.bold("\n🔗 Reconciling Syncthing mesh\n"));
  const res = await reconcileMesh();
  console.log(c.green(`  ✓ Applied ${res.applied} instance(s)`));
  if (res.skipped.length) {
    console.log(c.yellow(`  ! Skipped: ${res.skipped.join(", ")}`));
  }
  console.log(c.dim("\n  Syncthing connects over the tailnet; the hub mirrors into ~/wolves/."));
}
