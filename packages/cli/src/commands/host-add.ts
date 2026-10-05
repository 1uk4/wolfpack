/**
 * wolfpack host add <name> [--ip <ip>]
 *
 * Interactive setup for a VPS host:
 *   1. Prompts for IP if not provided
 *   2. Auto-detects SSH keys and lets user select
 *   3. Tests SSH connectivity
 *   4. Deploys wolfpack-agent
 *   5. Saves host config locally
 */

import path from "node:path";
import os from "node:os";
import { loadConfig, saveConfig, type HostEntry } from "../config.js";
import { c } from "../render.js";
import {
  detectSshKeys,
  testSshConnection,
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

  if (config.hosts[name]) {
    console.error(c.red(`Host '${name}' already registered.`));
    console.error(c.dim(`Remove it first or choose a different name.`));
    process.exit(1);
  }

  console.log(c.bold(`\n🐺 Setting up host: ${name}\n`));

  // 1. Get IP address
  const ip = opts.ip || (await prompt("VPS IP address or hostname"));
  if (!ip) {
    console.error(c.red("IP address is required"));
    process.exit(1);
  }

  // 2. Auto-detect SSH keys
  const keys = detectSshKeys();
  if (keys.length === 0) {
    console.error(c.red("No SSH keys found in ~/.ssh/"));
    console.error(c.dim("Generate one with: ssh-keygen -t ed25519 -f ~/.ssh/wolfpack"));
    process.exit(1);
  }

  console.log(c.dim(`\nFound ${keys.length} SSH key(s)`));

  // 3. Select SSH key
  let sshKey: string;
  if (opts.key) {
    sshKey = opts.key;
  } else if (keys.length === 1) {
    sshKey = keys[0]!;
    console.log(c.dim(`Using: ${sshKey}`));
  } else {
    sshKey = await select(
      "Select SSH key:",
      keys.map((k) => ({
        label: k.replace(os.homedir(), "~"),
        value: k,
      })),
    );
  }

  // 4. Get SSH user
  const sshUser = opts.user || (await prompt("SSH user", "wolf"));
  const sshPort = opts.sshPort || 22;

  // 5. Test SSH connectivity
  const sshConfig: SshConfig = {
    user: sshUser,
    key: sshKey,
    port: sshPort,
  };

  console.log(c.dim(`\nTesting SSH to ${sshUser}@${ip}...`));
  const test = await testSshConnection(ip, sshConfig);
  if (!test.success) {
    console.error(c.red(`\n✗ SSH connection failed:`));
    console.error(c.dim(test.error || "Unknown error"));
    console.error(c.dim(`\nTry: ssh -i ${sshKey} ${sshUser}@${ip}`));
    process.exit(1);
  }
  console.log(c.green(`✓ SSH connection successful`));

  // 6. Build host entry (apiKey populated during deployment)
  const host: HostEntry = {
    address: ip,
    port: opts.port ?? 3141,
    apiKey: "",
    ssh: sshConfig,
  };

  // 7. Confirm deployment
  console.log();
  const shouldDeploy = await confirm(
    `Deploy wolfpack-agent to ${sshUser}@${ip}?`,
    true,
  );
  if (!shouldDeploy) {
    console.log(c.yellow("Deployment skipped. Host not saved."));
    process.exit(0);
  }

  // 8. Deploy agent
  try {
    await deployAgent(name, host);
  } catch (err) {
    console.error(c.red(`\n✗ Deployment failed:`));
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 9. Save config
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
  console.log(`  ${c.cyan("wolfpack add wolf <name>")}        Create a wolf on ${name}`);
  console.log(`  ${c.cyan("wolfpack host status")}            Check host health`);
  console.log(`  ${c.cyan("wolfpack list")}                   List all wolves`);
}
