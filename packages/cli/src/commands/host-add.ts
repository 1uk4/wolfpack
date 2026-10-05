/**
 * wolfpack host add <name> [--ip <ip>]
 *
 * Guided wizard to register + provision a VPS host:
 *   1. Readiness gate — if the VPS isn't created/on the tailnet yet, print
 *      step-by-step setup instructions and let the user come back.
 *   2. Connection — collect IP + SSH user/key, test connectivity (with targeted
 *      troubleshooting on failure).
 *   3. Pre-flight — probe the box (OS, sudo, curl, tailscale, prior install).
 *   4. Deploy — prereqs (node/pi/tailscale/syncthing) + the wolfpack agent.
 *   5. Save config + next steps.
 */

import os from "node:os";
import { loadConfig, saveConfig, type HostEntry } from "../config.js";
import { c } from "../render.js";
import {
  detectSshKeys,
  testSshConnection,
  execSsh,
  type SshConfig,
} from "../ssh-helper.js";
import { prompt, select, confirm } from "../prompts.js";
import { deployAgent } from "../deployer.js";

interface HostAddOpts {
  ip?: string;
  port?: number;
  user?: string;
  key?: string;
  sshPort?: number;
}

export async function hostAdd(name: string, opts: HostAddOpts): Promise<void> {
  const config = loadConfig();
  const interactive = process.stdin.isTTY;

  if (config.hosts[name]) {
    console.error(c.red(`Host '${name}' already registered.`));
    console.error(c.dim(`Remove it first or choose a different name.`));
    process.exit(1);
  }

  console.log(c.bold(`\n🐺 Add host: ${name}\n`));

  // ── 1. Readiness gate ─────────────────────────────────────────────
  // If they didn't pass --ip and are interactive, make sure the box exists.
  if (!opts.ip && interactive) {
    const ready = await confirm(
      "Is your VPS already created and joined to your Tailscale tailnet?",
      false,
    );
    if (!ready) {
      printSetupGuide(name);
      return;
    }
  }

  // ── 2. Connection details ─────────────────────────────────────────
  const ip = opts.ip || (await prompt("VPS Tailscale IP (or hostname)"));
  if (!ip) {
    console.error(c.red("A Tailscale IP or hostname is required."));
    printSetupGuide(name);
    process.exit(1);
  }

  const keys = detectSshKeys();
  if (keys.length === 0) {
    console.error(c.red("\nNo SSH keys found in ~/.ssh/"));
    console.error(c.dim("Generate one, then add its public key to the VPS:"));
    console.error(c.dim("  ssh-keygen -t ed25519 -f ~/.ssh/wolfpack"));
    console.error(c.dim("  ssh-copy-id -i ~/.ssh/wolfpack.pub root@<ip>"));
    process.exit(1);
  }

  let sshKey: string;
  if (opts.key) {
    sshKey = opts.key;
  } else if (keys.length === 1) {
    sshKey = keys[0]!;
    console.log(c.dim(`Using SSH key: ${sshKey.replace(os.homedir(), "~")}`));
  } else {
    sshKey = await select(
      "Select SSH key:",
      keys.map((k) => ({ label: k.replace(os.homedir(), "~"), value: k })),
    );
  }

  // Agent runs as root (manages unix users + systemd). Default to root; a
  // non-root user must have passwordless sudo.
  const sshUser =
    opts.user || (interactive ? await prompt("SSH user", "root") : "root");
  const sshPort = opts.sshPort || 22;
  const sshConfig: SshConfig = { user: sshUser, key: sshKey, port: sshPort };

  // ── Test SSH ──────────────────────────────────────────────────────
  console.log(c.dim(`\nTesting SSH to ${sshUser}@${ip}...`));
  const test = await testSshConnection(ip, sshConfig);
  if (!test.success) {
    console.error(c.red(`\n✗ SSH connection failed.`));
    console.error(c.dim(test.error?.trim() || "Unknown error"));
    printSshTroubleshooting(ip, sshUser, sshKey);
    process.exit(1);
  }
  console.log(c.green(`✓ SSH OK`));

  const host: HostEntry = {
    address: ip,
    port: opts.port ?? 3141,
    apiKey: "",
    ssh: sshConfig,
  };

  // ── 3. Pre-flight checks ──────────────────────────────────────────
  const ok = runPreflight(host);
  if (!ok && interactive) {
    const proceed = await confirm(
      "\nSome checks failed. Continue the deploy anyway?",
      false,
    );
    if (!proceed) {
      console.log(c.yellow("Aborted. Fix the items above and re-run."));
      process.exit(1);
    }
  } else if (!ok) {
    console.error(c.red("Pre-flight checks failed. Aborting."));
    process.exit(1);
  }

  // ── 4. Deploy ─────────────────────────────────────────────────────
  if (interactive) {
    console.log();
    const go = await confirm(
      `Provision ${sshUser}@${ip} (node, pi, tailscale, syncthing + agent)?`,
      true,
    );
    if (!go) {
      console.log(c.yellow("Deployment skipped. Host not saved."));
      return;
    }
  }

  try {
    await deployAgent(name, host);
  } catch (err) {
    console.error(c.red(`\n✗ Deployment failed:`));
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // ── 5. Save + next steps ──────────────────────────────────────────
  config.hosts[name] = host;
  if (!config.defaultHost) {
    config.defaultHost = name;
    console.log(c.dim(`\nSet '${name}' as default host`));
  }
  saveConfig(config);

  console.log(c.green(`\n✓ Host '${name}' registered!`));
  console.log(c.dim(`  Config: ~/.wolfpack/config.yaml`));
  console.log();
  console.log(c.bold("Next steps:"));
  console.log(`  ${c.cyan(`wolfpack add wolf <name> --host ${name}`)}   Create a 24/7 wolf`);
  console.log(`  ${c.cyan(`wolfpack host status ${name}`)}              Check host health`);
  console.log(`  ${c.cyan("wolfpack list")}                          List all wolves`);
}

/**
 * Pre-flight probe. Returns true if all critical checks pass. Prints a
 * checklist. Each check is a cheap, quote-safe one-liner over SSH.
 */
function runPreflight(host: HostEntry): boolean {
  console.log(c.bold("\nPre-flight checks:"));

  const run = (cmd: string): string => execSsh(host, cmd).stdout.trim();
  let allCritical = true;

  const line = (ok: boolean, label: string, detail: string, critical = true) => {
    const mark = ok ? c.green("✓") : critical ? c.red("✗") : c.yellow("!");
    console.log(`  ${mark} ${label}${detail ? c.dim(` — ${detail}`) : ""}`);
    if (!ok && critical) allCritical = false;
  };

  // OS (apt-based)
  const osId = run(". /etc/os-release 2>/dev/null; echo ${ID:-unknown} ${VERSION_ID:-}");
  const apt = run("command -v apt-get >/dev/null && echo yes || echo no") === "yes";
  line(apt, "Debian/Ubuntu (apt)", osId, true);

  // sudo (only matters for non-root)
  if (host.ssh.user !== "root") {
    const sudo = run("sudo -n true 2>/dev/null && echo yes || echo no") === "yes";
    line(sudo, "Passwordless sudo", sudo ? "ok" : "required for non-root user", true);
  } else {
    line(true, "Running as root", "", true);
  }

  // curl (needed by prereq installers)
  const curl = run("command -v curl >/dev/null && echo yes || echo no") === "yes";
  line(curl, "curl present", curl ? "" : "will be installed", false);

  // arch
  const arch = run("uname -m");
  line(/x86_64|aarch64|arm64/.test(arch), "CPU arch", arch, false);

  // tailscale (informational — deployer installs if missing)
  const ts = run("tailscale status >/dev/null 2>&1 && echo up || echo down");
  line(ts === "up", "Tailscale up", ts === "up" ? "" : "not joined yet", false);

  // prior agent
  const prior = run(
    "systemctl is-active wolfpack-agent 2>/dev/null || echo none",
  );
  if (prior === "active") {
    line(false, "Existing agent", "already running — will be replaced", false);
  }

  return allCritical;
}

/** Print the VPS + Tailscale setup guide and invite the user back. */
function printSetupGuide(name: string): void {
  const b = c.bold;
  const dim = c.dim;
  const cy = c.cyan;
  console.log(b("\nLet's get your VPS ready. Do this, then come back.\n"));

  console.log(b("1. Create a VPS"));
  console.log("   Ubuntu 22.04/24.04 LTS, 2 GB+ RAM, any provider");
  console.log(dim("   (Hetzner, DigitalOcean, Vultr, Fly.io, …)\n"));

  console.log(b("2. SSH in as root and update"));
  console.log(cy("   ssh root@<provider-ip>"));
  console.log(cy("   apt-get update && apt-get -y upgrade\n"));

  console.log(b("3. Join your Tailscale tailnet"));
  console.log(cy("   curl -fsSL https://tailscale.com/install.sh | sh"));
  console.log(cy("   tailscale up"));
  console.log(dim("   Follow the auth URL it prints. Then grab the tailnet IP:"));
  console.log(cy("   tailscale ip -4\n"));

  console.log(b("4. Make sure your SSH key is authorized"));
  console.log(dim("   From this machine:"));
  console.log(cy("   ssh-copy-id -i ~/.ssh/wolfpack.pub root@<tailscale-ip>"));
  console.log(dim("   (generate one first if needed: ssh-keygen -t ed25519 -f ~/.ssh/wolfpack)\n"));

  console.log(b("5. Come back and run"));
  console.log(cy(`   wolfpack host add ${name} --ip <tailscale-ip>\n`));

  console.log(
    dim(
      "The agent runs as root to manage per-wolf unix users + systemd, so SSH\n" +
        "as root (or a user with passwordless sudo). Tip: set TAILSCALE_AUTHKEY in\n" +
        "your shell to let the deploy run `tailscale up` for you.",
    ),
  );
}

/** Targeted SSH failure help. */
function printSshTroubleshooting(ip: string, user: string, key: string): void {
  const dim = c.dim;
  const cy = c.cyan;
  console.log(c.bold("\nTroubleshooting:"));
  console.log("  • Try it manually:");
  console.log(cy(`      ssh -i ${key.replace(os.homedir(), "~")} ${user}@${ip}`));
  console.log("  • Is the box on your tailnet? " + cy("tailscale status"));
  console.log(`      ${dim(`(you should see ${ip} as a peer)`)}`);
  console.log("  • Is your public key authorized on the VPS?");
  console.log(cy(`      ssh-copy-id -i ${key.replace(os.homedir(), "~")}.pub ${user}@${ip}`));
  console.log("  • Wrong user? The agent needs root or passwordless sudo.");
}
