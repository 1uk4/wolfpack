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
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  red "✗ Node.js 20+ required (found $NODE_VERSION)"
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

# 5. Verify
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

bold "✨ Installation complete!"
echo
bold "Next steps:"
echo "  $(dim '# Set up your first VPS host')"
echo "  wolfpack host add wolf-01"
echo
echo "  $(dim '# Or create a local wolf')"
echo "  wolfpack add wolf my-wolf"
echo
