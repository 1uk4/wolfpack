#!/usr/bin/env bash
# Optional operator step: install the PINNED claude CLI next to the release (tools/node_modules/.bin/claude wins on launch.sh's PATH).
# Needs npm + network; the wolf itself never needs this. Usage: tools/install-claude-cli.sh
set -euo pipefail
T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$(cat "$T/CLAUDE_CODE_VERSION")"
npm install --prefix "$T" --no-audit --no-fund --no-package-lock "@anthropic-ai/claude-code@$V"
"$T/node_modules/.bin/claude" --version
