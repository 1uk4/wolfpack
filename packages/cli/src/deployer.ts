/**
 * Agent deployment — deploy wolfpack-agent to a VPS
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import type { HostEntry } from "./config.js";
import { execSsh, execSshStream, scpToHost } from "./ssh-helper.js";
import { c } from "./render.js";

/**
 * Generate a secure API key for the agent
 */
function generateApiKey(): string {
  const buffer = execSync("openssl rand -hex 32", { encoding: "utf8" });
  return `wp_${buffer.trim()}`;
}

/**
 * Bundle the agent into a single self-contained file (esbuild).
 *
 * The monorepo hoists deps (express, yaml) to the ROOT node_modules, so copying
 * packages/agent/node_modules alone ships a broken agent. Bundling inlines every
 * dep into one file \u2014 no node_modules on the box, no hoisting surprises.
 */
async function bundleAgent(repoRoot: string, outFile: string): Promise<void> {
  const entry = path.join(repoRoot, "packages/agent/src/bin/wolfpack-agent.ts");
  console.log(c.dim("Bundling @wolfpack/agent..."));
  await esbuild.build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
  });
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

/** Embedding model for the librarian's KB engine (pulled by provisionKbEngine). */
const KB_EMBED_MODEL = "nomic-embed-text";

/** Bundle the @wolfpack/kb CLI into one self-contained file (esbuild). */
async function bundleKbCli(repoRoot: string, outFile: string): Promise<void> {
  await esbuild.build({
    entryPoints: [path.join(repoRoot, "packages", "kb", "src", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: outFile,
  });
}

/**
 * Provision the librarian KB engine on a host. LIBRARIAN-ONLY: called from
 * `wolf sync` only when the synced wolf carries the `kb` extension, so the
 * Ollama + sweep stack lands solely on hosts that actually run a librarian.
 *
 * Installs: Ollama + the embedding model, the `wolfpack-kb` CLI, and a per-wolf
 * systemd sweep timer that drains the inbox and Telegrams a summary. Idempotent.
 */
export async function provisionKbEngine(
  host: HostEntry,
  wolf: { id: string; name: string; ownerId?: number },
): Promise<void> {
  console.log(
    c.bold(`\n\u25b8 Provisioning KB engine for librarian '${wolf.name}'`) +
      c.dim(" (streamed live below)"),
  );

  const repoRoot = findRepoRoot();
  if (!repoRoot) throw new Error("Could not find wolfpack repo root for KB CLI bundle.");

  const user = `wolf-${wolf.id}`;
  const home = `/home/${user}`;
  const ownerLine = wolf.ownerId
    ? `Environment=WOLFPACK_OWNER_TELEGRAM_ID=${wolf.ownerId}`
    : "";

  // 1. Bundle + ship the CLI.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-kb-"));
  const cliOut = path.join(tmp, "cli.cjs");
  await bundleKbCli(repoRoot, cliOut);
  scpToHost(host, cliOut, "/tmp/wolfpack-kb-cli.cjs");

  // 2. Provisioning script (idempotent).
  const script = `set -e
step(){ printf '\\n\\033[1m  \\u25b8 %s\\033[0m\\n' "$1"; }

step "Ollama + ${KB_EMBED_MODEL}"
if ! command -v ollama >/dev/null 2>&1; then curl -fsSL https://ollama.com/install.sh | sh; fi
systemctl enable --now ollama || true
for i in $(seq 1 20); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; sleep 2; done
ollama list 2>/dev/null | grep -q '${KB_EMBED_MODEL}' || ollama pull ${KB_EMBED_MODEL}

step "wolfpack-kb CLI"
mkdir -p /opt/wolfpack-kb
mv /tmp/wolfpack-kb-cli.cjs /opt/wolfpack-kb/cli.cjs

step "KB storage roots + den-local state"
mkdir -p ${home}/knowledge/base ${home}/librarian
chown -R ${user}:${user} ${home}/knowledge ${home}/librarian
# den-local ledger/vectors live outside the (user-owned, synced) den because the
# sweep runs as root (consistent with root-owned Syncthing writes into the KB dirs).
mkdir -p /var/lib/wolfpack-kb/${wolf.id}

step "let the wolf trigger the sweep on demand (/kb:sweep)"
echo '${user} ALL=(root) NOPASSWD: /usr/bin/systemctl start ${user}-kb-sweep.service' > /etc/sudoers.d/${user}-kb-sweep
chmod 440 /etc/sudoers.d/${user}-kb-sweep

step "sweep service + timer"
cat > /etc/systemd/system/${user}-kb-sweep.service <<UNIT
[Unit]
Description=Wolfpack KB sweep - ${wolf.name}
After=network-online.target ollama.service
Wants=network-online.target
[Service]
# Runs as root so it can process root-owned Syncthing writes in the KB dirs and
# write entries that Syncthing (also root) mirrors back out.
Type=oneshot
User=root
Environment=HOME=${home}
Environment=KB_BASE=${home}/knowledge/base
Environment=KB_OPS=${home}/librarian
Environment=KB_DEN_LOCAL=/var/lib/wolfpack-kb/${wolf.id}
Environment=WOLFPACK_EMBED_URL=http://127.0.0.1:11434
${ownerLine}
EnvironmentFile=-${home}/.env
ExecStart=/usr/bin/node /opt/wolfpack-kb/cli.cjs sweep
UNIT
cat > /etc/systemd/system/${user}-kb-sweep.timer <<UNIT
[Unit]
Description=Wolfpack KB sweep timer - ${wolf.name}
[Timer]
OnCalendar=*:0/15
Persistent=true
Unit=${user}-kb-sweep.service
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now ${user}-kb-sweep.timer
printf '\\n\\033[32m  \\u2713 KB engine ready (ollama + ${KB_EMBED_MODEL} + sweep timer)\\033[0m\\n'
`;

  const scriptPath = path.join(tmp, "kb-provision.sh");
  fs.writeFileSync(scriptPath, script);
  scpToHost(host, scriptPath, "/tmp/wolfpack-kb-provision.sh");
  const code = await execSshStream(host, "sudo bash /tmp/wolfpack-kb-provision.sh", (chunk) => {
    process.stdout.write(chunk);
  });
  if (code !== 0) throw new Error("KB engine provisioning failed (see output above)");
}

/**
 * Host prerequisites installed before the agent: Node 22, the pi CLI, Tailscale,
 * and Syncthing. Idempotent (each step checks before installing). Assumes a
 * Debian/Ubuntu host with apt. Tailscale/Syncthing are installed + enabled;
 * authentication (tailscale up / syncthing config) is left to the operator
 * unless TAILSCALE_AUTHKEY is provided.
 */
async function installPrereqs(host: HostEntry): Promise<void> {
  console.log(c.bold("\n\u25b8 Installing host prerequisites") + c.dim(" (streamed live below)"));
  const authkey = process.env.TAILSCALE_AUTHKEY ?? "";
  const script = `#!/usr/bin/env bash
set -euo pipefail
step() { printf '\\n\\033[1m  \\u2192 %s\\033[0m\\n' "$1"; }

export DEBIAN_FRONTEND=noninteractive

step "Base tools (curl, rsync, ca-certificates)"
apt-get update -y -qq
apt-get install -y -qq curl rsync ca-certificates

step "Node.js 22+ (pi 1.0.x requires it)"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJ=$(node -v | sed 's/v//' | cut -d. -f1)
  [ "\${NODE_MAJ:-0}" -ge 22 ] && NODE_OK=1 && echo "    already node $(node -v)"
fi
if [ "$NODE_OK" -ne 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
  echo "    installed $(node -v)"
fi

step "pi coding agent (global)"
if command -v pi >/dev/null 2>&1; then
  echo "    already pi $(pi --version 2>/dev/null | head -1)"
else
  npm install -g @earendil-works/pi-coding-agent
  echo "    installed pi $(pi --version 2>/dev/null | head -1)"
fi

step "Tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled || true
if [ -n "${authkey}" ]; then
  tailscale up --authkey "${authkey}" || true
fi
echo "    $(tailscale --version 2>/dev/null | head -1)"

step "Syncthing (enable as root)"
if ! command -v syncthing >/dev/null 2>&1; then
  apt-get install -y -qq syncthing
fi
systemctl enable --now syncthing@root
for i in $(seq 1 15); do [ -f /root/.local/state/syncthing/config.xml ] && break; sleep 1; done
echo "    $(syncthing --version 2>/dev/null | head -1) (service: $(systemctl is-active syncthing@root 2>/dev/null))"
# Bind GUI to localhost only; den mirrors are configured via SSH (host sync).
true

printf '\\n\\033[32m  \\u2713 prerequisites ready\\033[0m\\n'
echo "PREREQS_OK"
`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-prereq-"));
  const scriptPath = path.join(tmp, "prereqs.sh");
  try {
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    scpToHost(host, scriptPath, "/tmp/wolfpack-prereqs.sh");
    let output = "";
    const code = await execSshStream(host, "sudo bash /tmp/wolfpack-prereqs.sh", (chunk) => {
      output += chunk;
      process.stdout.write(c.dim(chunk));
    });
    if (code !== 0 || !output.includes("PREREQS_OK")) {
      throw new Error("Prereq install failed (see streamed output above)");
    }
    if (!authkey) {
      console.log(
        c.dim(
          "  Note: run `tailscale up` on the host to join the tailnet, and configure Syncthing.",
        ),
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Deploy wolfpack-agent to a remote host
 */
export async function deployAgent(
  hostName: string,
  host: HostEntry,
): Promise<void> {
  console.log(c.bold(`\nDeploying wolfpack-agent to ${hostName}...`));

  // 0. Host prerequisites (node, pi, tailscale, syncthing).
  await installPrereqs(host);

  // 1. Find and build agent
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    throw new Error(
      "Could not find wolfpack repo root. Make sure you're running from the wolfpack monorepo.",
    );
  }

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

    // Bundle the agent into one self-contained file.
    await bundleAgent(repoRoot, path.join(deployDir, "wolfpack-agent.cjs"));

    // Read the host Syncthing API key so the agent's /health can report folder
    // completion (host status) and so den mirrors can be inspected.
    const syncApiKey = execSsh(
      host,
      "grep -o '<apikey>[^<]*</apikey>' /root/.local/state/syncthing/config.xml 2>/dev/null | sed 's/<[^>]*>//g'",
    ).stdout.trim();

    // Create systemd service file. The agent runs as root: it manages per-wolf
    // unix units, which requires privilege.
    const serviceContent = `[Unit]
Description=Wolfpack Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/wolfpack-agent
ExecStart=/usr/bin/node /opt/wolfpack-agent/wolfpack-agent.cjs
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment="WOLFPACK_AGENT_PORT=${host.port}"
Environment="WOLFPACK_AGENT_DATA=/opt/wolfpack"
Environment="WOLFPACK_AGENT_API_KEY=${apiKey}"
Environment="SYNCTHING_UNIT=syncthing@root"
Environment="SYNCTHING_URL=http://127.0.0.1:8384"
Environment="SYNCTHING_API_KEY=${syncApiKey}"

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

    const result = execSsh(host, `curl -s http://localhost:${host.port}/ping`);
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
