#!/usr/bin/env bash
# The wolf's launcher in --max mode: what systemd's `EnvironmentFile=<wolf home>/.env` does on a VPS, done here without systemd.
# Loads <wolf home>/.env into THIS process (only wolfd and its claude child get the token; workerd never sees it, and it is
# never on a command line), refuses to start if ANTHROPIC_API_KEY is set next to it, then execs the REAL wolfd bin.
set -euo pipefail
ENV_FILE="${WOLF_ENV_FILE:-$HOME/.env}"
[ -f "$ENV_FILE" ] || { echo "wolfd-max: $ENV_FILE missing" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "wolfd-max: FATAL both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set; the claude CLI would prefer the metered key. Unset ANTHROPIC_API_KEY." >&2; exit 78
fi
[ -n "${ANTHROPIC_API_KEY:-}" ] && { echo "wolfd-max: FATAL ANTHROPIC_API_KEY is set in a Max wolf's env" >&2; exit 78; }
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || { echo "wolfd-max: FATAL CLAUDE_CODE_OAUTH_TOKEN missing from $ENV_FILE" >&2; exit 78; }
exec node /opt/wolfpack/packages/harness/dist/bin/wolfd.js "$@"
