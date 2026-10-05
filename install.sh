#!/usr/bin/env bash
# Wolfpack install script
# Usage: ./install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

bold "🐺 Wolfpack installer"
echo

# 1. Check prerequisites
bold "▸ Checking prerequisites..."

if ! command -v node >/dev/null 2>&1; then
  red "✗ Node.js not found"
  dim "  Install from https://nodejs.org or via nvm"
  exit 1
fi
NODE_VERSION=$(node --version)
green "✓ Node.js $NODE_VERSION"

if ! command -v npm >/dev/null 2>&1; then
  red "✗ npm not found"
  exit 1
fi
green "✓ npm $(npm --version)"

NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  red "✗ Node.js 22+ required (found $NODE_VERSION)"
  dim "  pi 1.0.x needs Node 22. With nvm:  nvm install 22 && nvm alias default 22"
  exit 1
fi
echo

# 2. Install dependencies
bold "▸ Installing dependencies..."
npm install
green "✓ Dependencies installed"
echo

# 3. Build all packages
bold "▸ Building packages..."
npm run build
green "✓ Build complete"
echo

# 4. Link CLI globally
bold "▸ Linking wolfpack CLI..."
cd packages/cli
npm link
cd "$SCRIPT_DIR"
green "✓ wolfpack command installed"
echo

# 5. Install the pi coding agent globally (the runtime every wolf uses)
bold "▸ Checking pi runtime..."
if command -v pi >/dev/null 2>&1; then
  green "✓ pi $(pi --version 2>/dev/null | head -1)"
else
  dim "  Installing @earendil-works/pi-coding-agent globally..."
  npm install -g @earendil-works/pi-coding-agent
  green "✓ pi installed"
fi
echo

# 6. Scaffold ~/.wolfpack (shared secrets live here, outside the repo)
bold "▸ Scaffolding ~/.wolfpack..."
mkdir -p "$HOME/.wolfpack/keys"
if [[ ! -f "$HOME/.wolfpack/.env" ]]; then
  cat > "$HOME/.wolfpack/.env" <<'EOF'
# Shared wolfpack secrets (sourced for every wolf). Not in the repo.
# Required: provider key for the memory system + wolves.
ANTHROPIC_API_KEY=
EOF
  chmod 600 "$HOME/.wolfpack/.env"
  green "✓ Created ~/.wolfpack/.env (add your ANTHROPIC_API_KEY)"
else
  green "✓ ~/.wolfpack/.env already present"
fi
echo

# 7. Ensure an SSH key for reaching VPS hosts
bold "▸ Checking SSH key for hosts..."
if [[ -f "$HOME/.ssh/wolfpack" || -f "$HOME/.ssh/id_ed25519" ]]; then
  green "✓ SSH key present"
else
  dim "  No wolfpack SSH key found. Generate one with:"
  dim "    ssh-keygen -t ed25519 -f ~/.ssh/wolfpack"
fi
echo

# 8. Verify
if command -v wolfpack >/dev/null 2>&1; then
  WOLFPACK_PATH=$(which wolfpack)
  green "✓ wolfpack available at: $WOLFPACK_PATH"
else
  red "⚠ wolfpack not in PATH"
  NPM_BIN=$(npm config get prefix)/bin
  dim "  Add this to your shell config:"
  dim "    export PATH=\"$NPM_BIN:\$PATH\""
  exit 1
fi
echo

bold "✨ Local control plane ready!"
echo
if ! grep -q '^ANTHROPIC_API_KEY=.\+' "$HOME/.wolfpack/.env" 2>/dev/null; then
  red "⚠ Set your key before creating wolves:"
  dim "    edit ~/.wolfpack/.env  →  ANTHROPIC_API_KEY=sk-ant-..."
  echo
fi
bold "Next steps (see docs/SETUP.md for the full walkthrough):"
echo "  $(dim '# Provision a VPS host (guided wizard)')"
echo "  wolfpack host add wolf-01"
echo
echo "  $(dim '# Create a 24/7 assistant wolf on it')"
echo "  wolfpack add wolf aide --host wolf-01"
echo
echo "  $(dim '# Or a local worker wolf')"
echo "  wolfpack add wolf my-wolf && wolfpack launch my-wolf"
echo
