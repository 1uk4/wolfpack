/**
 * wolfpack host redeploy [name] [--rotate-key]
 *
 * Re-provision an already-registered host: re-runs prerequisites (idempotent)
 * and redeploys the agent, picking up deployer changes (e.g. the Syncthing
 * service + env additions).
 *
 * **Default: PRESERVE the agent API key** so every wolf's WORK_TOKEN keeps
 * working across redeploys. Pass --rotate-key to force a new key; when that
 * runs, the current key is propagated into every wolf's .env on this host and
 * each affected wolf service is restarted. The local hub config is also
 * updated. (Local Mac-side wolves must re-launch to pick up their new .env.)
 *
 * Unlike `host add`, this operates on an existing host and keeps its SSH config.
 */

import { loadConfig, saveConfig, getHost } from "../config.js";
import { c } from "../render.js";
import { deployAgent } from "../deployer.js";
import { execSsh } from "../ssh-helper.js";
import { remotePaths } from "../paths.js";

export async function hostRedeploy(name?: string, opts: { rotateKey?: boolean } = {}): Promise<void> {
  const config = loadConfig();
  const hostName = name ?? config.defaultHost;
  const host = hostName ? getHost(config, hostName) : undefined;

  if (!hostName || !host) {
    console.error(c.red("No host specified and no default host set."));
    console.error(c.dim("Usage: wolfpack host redeploy <name> [--rotate-key]"));
    process.exit(1);
  }

  const willRotate = opts.rotateKey === true || !host.apiKey;
  console.log(c.bold(`\n🔁 Redeploying ${hostName} (${host.ssh.user}@${host.address})${willRotate ? c.yellow(" [key rotation]") : ""}`));

  try {
    await deployAgent(hostName, host, { rotateKey: opts.rotateKey }); // mutates host.apiKey only when rotating
  } catch (err) {
    console.error(c.red(`\n✗ Redeploy failed:`));
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  config.hosts[hostName] = host;
  saveConfig(config);

  // When the key rotated, every wolf on this host now has a stale WORK_TOKEN.
  // Propagate the new key into each wolf's .env, bounce the service, done.
  // Mac-side (local) wolves can't be mutated here; the user must relaunch pi
  // after `wolfpack sync <wolf>` ships them the new token.
  if (willRotate) {
    const rp = remotePaths();
    try {
      const script =
        `set -e
        NEW_KEY='${host.apiKey}'
        found=0
        for env in ${rp.homeGlob}/.env; do
          [ -f "$env" ] || continue
          found=1
          cp "$env" "$env.bak-pre-rotate-$(date +%s)" || true
          sed -i "s|^WORK_TOKEN=.*|WORK_TOKEN=$NEW_KEY|" "$env"
          wolfdir=$(dirname "$env")
          id=$(basename "$wolfdir" | sed 's/^${rp.user("")}//')
          systemctl restart "wolf-$id" 2>/dev/null && echo "restarted wolf-$id" || echo "could not restart wolf-$id"
        done
        [ $found -eq 1 ] || echo 'no VPS wolves to re-token'
        `;
      const out = execSsh(host, script).stdout.trim();
      if (out) console.log(c.dim(out.split("\n").map((l: string) => `  ${l}`).join("\n")));
    } catch (err) {
      console.error(c.yellow(`⚠ Key propagation to VPS wolves failed: ${err instanceof Error ? err.message : err}`));
      console.error(c.dim(`  Fix: ssh root@<host> and edit WORK_TOKEN in each ${rp.homeGlob}/.env, then restart each wolf-*.service.`));
    }
  }

  console.log(c.green(`\n✓ ${hostName} redeployed`));
  if (willRotate) {
    console.log(c.dim("  Agent API key rotated; VPS wolves auto-tokened + restarted."));
    console.log(c.dim("  Local wolves: re-sync + relaunch to pick up the new WORK_TOKEN."));
  } else {
    console.log(c.dim("  Agent API key preserved; wolves keep working."));
  }
  console.log();
  console.log(c.bold("Next:"));
  console.log(`  ${c.cyan(`wolfpack host status ${hostName}`)}   Verify Syncthing now reports folders`);
  console.log(`  ${c.cyan(`wolfpack host sync ${hostName}`)}     Re-apply den mirrors (reconcile)`);
}
