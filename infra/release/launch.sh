#!/usr/bin/env bash
# wolfd launcher (ships in the release tarball). Loads the wolf's .env (what systemd EnvironmentFile= does too), enforces the
# billing guards, then execs the bundled wolfd with the bundled node_modules. Uses no npm and nothing outside the release.
#   env: WOLF_HOME (default $HOME)  WOLF_ENV_FILE (default $WOLF_HOME/.env)  WOLF_CONFIG (default $WOLF_HOME/wolf.yaml)
#   extra args are passed to wolfd (e.g. --socket PATH | --port N)
set -euo pipefail
REL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WOLF_HOME="${WOLF_HOME:-$HOME}"
ENV_FILE="${WOLF_ENV_FILE:-$WOLF_HOME/.env}"
CONFIG="${WOLF_CONFIG:-$WOLF_HOME/wolf.yaml}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "launch.sh: FATAL ANTHROPIC_API_KEY is set; a wolfd wolf never runs on a metered key (the claude CLI would prefer it). Unset it." >&2; exit 78
fi
[ -f "$CONFIG" ] || { echo "launch.sh: $CONFIG missing" >&2; exit 1; }
transport="${WOLF_TRANSPORT:-}"
if [ -z "$transport" ] && [ -f "$(dirname "$CONFIG")/models.json" ]; then
  transport="$(sed -n 's/.*"transport"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$(dirname "$CONFIG")/models.json" | head -1)"
fi
if [ "$transport" = subscription ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "launch.sh: FATAL transport is subscription but CLAUDE_CODE_OAUTH_TOKEN is not set in $ENV_FILE" >&2; exit 78
fi
export PATH="$REL/tools/node_modules/.bin:$REL/tools/bin:$PATH"
exec node "$REL/packages/harness/dist/bin/wolfd.js" --config "$CONFIG" "$@"
