/**
 * Agent deployment — deploy wolfpack-agent to a VPS
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import type { HostEntry } from "./config.js";
import { execSsh, scpToHost } from "./ssh-helper.js";
import { c } from "./render.js";

/**
 * Generate a secure API key for the agent
 */
function generateApiKey(): string {
  const buffer = execSync("openssl rand -hex 32", { encoding: "utf8" });
  return `wp_${buffer.trim()}`;
}

/**
 * Build the agent package (if not already built)
 */
function buildAgent(repoRoot: string): void {
  const agentDir = path.join(repoRoot, "packages/agent");
  
  console.log(c.dim("Building @wolfpack/agent..."));
  
  try {
    execSync("npm run build", {
      cwd: agentDir,
      stdio: "inherit",
    });
  } catch (err) {
    throw new Error("Failed to build agent package");
  }
}

/**
 * Find the wolfpack repo root
 */
function findRepoRoot(): string | null {
  // Try to find package.json with @wolfpack/cli
  let current = __dirname;
  
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(current, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.name === "@wolfpack/cli") {
        // Go up 2 levels: packages/cli -> packages -> root
        return path.resolve(current, "../..");
      }
    }
    current = path.resolve(current, "..");
  }
  
  return null;
}

/**
 * Deploy wolfpack-agent to a remote host
 */
export async function deployAgent(
  hostName: string,
  host: HostEntry,
): Promise<void> {
  console.log(c.bold(`\nDeploying wolfpack-agent to ${hostName}...`));

  // 1. Find and build agent
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    throw new Error(
      "Could not find wolfpack repo root. Make sure you're running from the wolfpack monorepo.",
    );
  }

  buildAgent(repoRoot);

  // 2. Generate API key
  const apiKey = generateApiKey();
  const keyDir = path.join(os.homedir(), ".wolfpack/keys");
  fs.mkdirSync(keyDir, { recursive: true });
  const keyFile = path.join(keyDir, `${hostName}.key`);
  fs.writeFileSync(keyFile, apiKey, { mode: 0o600 });
  console.log(c.dim(`API key saved to: ${keyFile}`));

  // Update host config with API key
  host.apiKey = apiKey;

  // 3. Create deployment package in temp dir
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-deploy-"));
  const deployDir = path.join(tmpDir, "wolfpack-agent");
  
  try {
    fs.mkdirSync(deployDir, { recursive: true });

    // Copy built files
    const agentDir = path.join(repoRoot, "packages/agent");
    fs.cpSync(path.join(agentDir, "dist"), path.join(deployDir, "dist"), {
      recursive: true,
    });
    fs.cpSync(
      path.join(agentDir, "node_modules"),
      path.join(deployDir, "node_modules"),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(agentDir, "package.json"),
      path.join(deployDir, "package.json"),
    );

    // Create systemd service file
    const serviceContent = `[Unit]
Description=Wolfpack Agent
After=network.target

[Service]
Type=simple
User=${host.ssh.user}
WorkingDirectory=/opt/wolfpack-agent
ExecStart=/usr/bin/node /opt/wolfpack-agent/dist/bin/wolfpack-agent.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment="WOLFPACK_AGENT_PORT=${host.port}"
Environment="WOLFPACK_AGENT_DATA=/home/${host.ssh.user}/wolves"
Environment="WOLFPACK_AGENT_API_KEY=${apiKey}"

[Install]
WantedBy=multi-user.target
`;
    fs.writeFileSync(path.join(tmpDir, "wolfpack-agent.service"), serviceContent);

    console.log(c.dim("Copying files to remote host..."));

    // 4. Create remote directory
    execSsh(
      host,
      `sudo mkdir -p /opt/wolfpack-agent && sudo chown ${host.ssh.user}:${host.ssh.user} /opt/wolfpack-agent`,
    );

    // 5. Copy files
    const rsyncCmd = `rsync -avz --delete -e "ssh -i ${host.ssh.key} -p ${host.ssh.port}" ${deployDir}/ ${host.ssh.user}@${host.address}:/opt/wolfpack-agent/`;
    execSync(rsyncCmd, { stdio: "inherit" });

    // 6. Install systemd service
    console.log(c.dim("Installing systemd service..."));
    scpToHost(host, path.join(tmpDir, "wolfpack-agent.service"), "/tmp/");
    execSsh(
      host,
      `sudo mv /tmp/wolfpack-agent.service /etc/systemd/system/wolfpack-agent.service && \
       sudo systemctl daemon-reload && \
       sudo systemctl enable wolfpack-agent && \
       sudo systemctl restart wolfpack-agent`,
    );

    // 7. Wait and verify
    console.log(c.dim("Waiting for agent to start..."));
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const result = execSsh(host, "curl -s http://localhost:3141/ping");
    if (result.stdout.includes('"status":"ok"')) {
      console.log(c.green("\n✓ Agent deployed and running!"));
    } else {
      throw new Error("Agent not responding. Check logs with: wolfpack host logs");
    }
  } finally {
    // Cleanup temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
