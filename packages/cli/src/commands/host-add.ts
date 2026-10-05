/**
 * wolfpack host add <name> --ip <ip>
 *
 * Bootstraps a VPS over SSH:
 *   1. Install Node.js
 *   2. Create wolfpack agent user + data dir
 *   3. Deploy agent package
 *   4. Generate API key
 *   5. Start agent via systemd
 *   6. Save host config locally
 */

import { randomBytes } from "node:crypto";
import { sshExec } from "../ssh.js";
import { loadConfig, saveConfig, type HostEntry } from "../config.js";
import { c } from "../render.js";

export async function hostAdd(
  name: string,
  opts: { ip: string; port?: number; user?: string },
): Promise<void> {
  const config = loadConfig();
  const port = opts.port ?? 3141;
  const sshUser = opts.user ?? "root";

  if (config.hosts[name]) {
    console.error(c.red(`Host '${name}' already registered. Remove it first.`));
    process.exit(1);
  }

  console.log(c.bold(`Setting up host: ${name} (${opts.ip})`));
  console.log();

  // 1. Test SSH connectivity
  console.log("  Testing SSH connectivity...");
  const test = await sshExec(opts.ip, "echo ok", sshUser);
  if (test.code !== 0) {
    console.error(c.red(`  SSH failed: ${test.stderr.trim() || "unreachable"}`));
    process.exit(1);
  }
  console.log(c.green("  ✓ SSH connected"));

  // 2. Install Node.js if not present
  console.log("  Checking Node.js...");
  const nodeCheck = await sshExec(opts.ip, "node --version 2>/dev/null || echo MISSING", sshUser);
  if (nodeCheck.stdout.includes("MISSING")) {
    console.log("  Installing Node.js...");
    const install = await sshExec(
      opts.ip,
      "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs",
      sshUser,
      120_000,
    );
    if (install.code !== 0) {
      console.error(c.red(`  Node.js install failed: ${install.stderr.trim()}`));
      process.exit(1);
    }
    console.log(c.green("  ✓ Node.js installed"));
  } else {
    console.log(c.green(`  ✓ Node.js ${nodeCheck.stdout.trim()}`));
  }

  // 3. Create agent user and data dir
  console.log("  Creating wolfpack agent...");
  const apiKey = randomBytes(24).toString("base64url");

  const setupScript = `
set -e
# Create agent data dir
mkdir -p /opt/wolfpack

# Create agent .env
cat > /opt/wolfpack/.env << 'ENVEOF'
WOLFPACK_API_KEY=${apiKey}
WOLFPACK_AGENT_PORT=${port}
WOLFPACK_AGENT_DATA=/opt/wolfpack
ENVEOF
chmod 600 /opt/wolfpack/.env

echo "SETUP_OK"
`;

  const setup = await sshExec(opts.ip, setupScript, sshUser, 30_000);
  if (!setup.stdout.includes("SETUP_OK")) {
    console.error(c.red(`  Setup failed: ${setup.stderr.trim()}`));
    process.exit(1);
  }
  console.log(c.green("  ✓ Agent directory created"));

  // 4. Deploy agent package
  // TODO: For now, we'll need to rsync the built agent package
  // In the future, this will install from npm
  console.log(c.yellow("  ⚠ Agent package deployment: manual step required"));
  console.log(c.dim("    rsync the built @wolfpack/agent to the host, then:"));
  console.log(c.dim(`    ssh ${sshUser}@${opts.ip} 'cd /opt/wolfpack/agent && npm install'`));

  // 5. Install systemd service
  console.log("  Installing systemd service...");
  const serviceUnit = `[Unit]
Description=Wolfpack Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/wolfpack/agent
EnvironmentFile=/opt/wolfpack/.env
ExecStart=/usr/bin/node /opt/wolfpack/agent/dist/bin/wolfpack-agent.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target`;

  const serviceScript = `
cat > /etc/systemd/system/wolfpack-agent.service << 'SVCEOF'
${serviceUnit}
SVCEOF
systemctl daemon-reload
systemctl enable wolfpack-agent
echo "SERVICE_OK"
`;

  const svcResult = await sshExec(opts.ip, serviceScript, sshUser);
  if (!svcResult.stdout.includes("SERVICE_OK")) {
    console.error(c.red(`  Service install failed: ${svcResult.stderr.trim()}`));
    process.exit(1);
  }
  console.log(c.green("  ✓ Systemd service installed"));

  // 6. Save host config locally
  const hostEntry: HostEntry = {
    address: opts.ip,
    port,
    apiKey,
  };
  config.hosts[name] = hostEntry;
  if (!config.defaultHost) {
    config.defaultHost = name;
  }
  saveConfig(config);

  console.log();
  console.log(c.green(`✓ Host '${name}' registered`));
  console.log(c.dim(`  Address: ${opts.ip}:${port}`));
  console.log(c.dim(`  Config:  ~/.wolfpack/config.yaml`));
  console.log();
  console.log(
    c.yellow(
      "  Next: deploy the agent package, then run `wolfpack host status " +
        name +
        "` to verify.",
    ),
  );
}
