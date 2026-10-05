#!/usr/bin/env bash
# Deploy wolfpack-agent to a VPS
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

usage() {
  cat <<EOF
Usage: $0 <host>

Deploy wolfpack-agent to a VPS.

Example:
  $0 100.105.247.31
  $0 wolf-01.tailnet.ts.net

Prerequisites:
  - VPS has Node.js installed
  - SSH access as 'wolf' user
  - Built agent package (npm run build)
EOF
  exit 1
}

[[ $# -lt 1 ]] && usage
HOST="$1"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/wolfpack}"
SSH_USER="${SSH_USER:-wolf}"

bold "Deploying wolfpack-agent to $HOST..."

# 1. Build the agent package
cd "$REPO_ROOT"
bold "▸ Building @wolfpack/agent..."
cd packages/agent
npm run build
cd "$REPO_ROOT"
green "✓ Agent built"

# 2. Generate API key if not set
if [[ ! -f "$HOME/.wolfpack/keys/${HOST}.key" ]]; then
  mkdir -p "$HOME/.wolfpack/keys"
  API_KEY="wp_$(openssl rand -hex 32)"
  echo "$API_KEY" > "$HOME/.wolfpack/keys/${HOST}.key"
  chmod 600 "$HOME/.wolfpack/keys/${HOST}.key"
  bold "▸ Generated API key: $HOME/.wolfpack/keys/${HOST}.key"
else
  API_KEY=$(cat "$HOME/.wolfpack/keys/${HOST}.key")
  bold "▸ Using existing API key: $HOME/.wolfpack/keys/${HOST}.key"
fi

# 3. Create deployment package
bold "▸ Creating deployment package..."
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

mkdir -p "$TMPDIR/wolfpack-agent"
cp -r packages/agent/dist "$TMPDIR/wolfpack-agent/"
cp -r packages/agent/node_modules "$TMPDIR/wolfpack-agent/"
cp packages/agent/package.json "$TMPDIR/wolfpack-agent/"

# Create systemd service file
cat > "$TMPDIR/wolfpack-agent.service" <<EOF
[Unit]
Description=Wolfpack Agent
After=network.target

[Service]
Type=simple
User=$SSH_USER
WorkingDirectory=/opt/wolfpack-agent
ExecStart=/usr/bin/node /opt/wolfpack-agent/dist/bin/wolfpack-agent.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment="WOLFPACK_AGENT_PORT=3141"
Environment="WOLFPACK_AGENT_DATA=/home/$SSH_USER/wolves"
Environment="WOLFPACK_AGENT_API_KEY=$API_KEY"

[Install]
WantedBy=multi-user.target
EOF

green "✓ Package created"

# 4. Deploy to VPS
bold "▸ Copying files to $HOST..."
ssh -i "$SSH_KEY" "$SSH_USER@$HOST" "sudo mkdir -p /opt/wolfpack-agent && sudo chown $SSH_USER:$SSH_USER /opt/wolfpack-agent"
rsync -avz --delete -e "ssh -i $SSH_KEY" "$TMPDIR/wolfpack-agent/" "$SSH_USER@$HOST:/opt/wolfpack-agent/"
green "✓ Files copied"

# 5. Install systemd service
bold "▸ Installing systemd service..."
scp -i "$SSH_KEY" "$TMPDIR/wolfpack-agent.service" "$SSH_USER@$HOST:/tmp/wolfpack-agent.service"
ssh -i "$SSH_KEY" "$SSH_USER@$HOST" "sudo mv /tmp/wolfpack-agent.service /etc/systemd/system/wolfpack-agent.service && \
  sudo systemctl daemon-reload && \
  sudo systemctl enable wolfpack-agent && \
  sudo systemctl restart wolfpack-agent"
green "✓ Service installed and started"

# 6. Verify
bold "▸ Verifying agent..."
sleep 2
if ssh -i "$SSH_KEY" "$SSH_USER@$HOST" "curl -s http://localhost:3141/ping" | grep -q '"status":"ok"'; then
  green "✓ Agent is responding!"
  echo ""
  bold "Agent deployed successfully!"
  echo ""
  echo "API Key: $API_KEY"
  echo "Stored at: $HOME/.wolfpack/keys/${HOST}.key"
  echo ""
  bold "Next steps:"
  echo "  1. Add host: wolfpack host add wolf-01 --ip $HOST"
  echo "  2. Create a wolf: wolfpack add wolf test-wolf --host wolf-01"
else
  red "✗ Agent not responding. Check logs:"
  echo "  ssh -i $SSH_KEY $SSH_USER@$HOST 'sudo journalctl -u wolfpack-agent -f'"
  exit 1
fi
