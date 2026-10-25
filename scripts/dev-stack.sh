#!/usr/bin/env bash
# One-terminal dev stack: workerd (supervising every wolf in WOLVES_DIR) + console.
#   npm run dev:stack
# Env (all optional):
#   WOLVES_DIR            dir of wolf dirs with wolf.yaml   (default ~/wolves/dev)
#   WOLFPACK_MODELS_FILE  models.json (transport "api")     (default: first */models.json in WOLVES_DIR)
#   WORKERD_PORT          workerd /v1 port                  (default 7141)
# Secrets (ANTHROPIC_API_KEY) are sourced from ~/.wolfpack/.env when present.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WOLVES_DIR="${WOLVES_DIR:-$HOME/wolves/dev}"
WORKERD_PORT="${WORKERD_PORT:-7141}"

[ -f "$HOME/.wolfpack/.env" ] && { set -a; source "$HOME/.wolfpack/.env"; set +a; }

# A models.json beside a dev wolf wins over anything inherited from the shell
# or pack .env — those usually point at the subscription table, which wolfd
# rejects until the bridge lands (p81a6iI).
DEV_MODELS_FILE="$(ls "$WOLVES_DIR"/*/models.json 2>/dev/null | head -1 || true)"
if [ -n "$DEV_MODELS_FILE" ]; then
  WOLFPACK_MODELS_FILE="$DEV_MODELS_FILE"
fi
if [ -z "${WOLFPACK_MODELS_FILE:-}" ] || [ ! -f "$WOLFPACK_MODELS_FILE" ]; then
  echo "dev-stack: no models.json found (set WOLFPACK_MODELS_FILE or put one beside a wolf in $WOLVES_DIR)" >&2
  exit 1
fi
export WOLFPACK_MODELS_FILE
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "dev-stack: ANTHROPIC_API_KEY not set (export it or add to ~/.wolfpack/.env)" >&2
  exit 1
fi

echo "dev-stack: wolves=$WOLVES_DIR  models=$WOLFPACK_MODELS_FILE  workerd=:$WORKERD_PORT"
npx turbo run build --filter=@wolfpack/harness --filter=@wolfpack/workerd --output-logs=errors-only

node "$ROOT/packages/workerd/dist/bin/workerd.js" \
  --wolves "$WOLVES_DIR" --port "$WORKERD_PORT" &
WORKERD_PID=$!

cleanup() { kill "$WORKERD_PID" 2>/dev/null || true; wait "$WORKERD_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

WOLFPACK_API_URL="http://127.0.0.1:$WORKERD_PORT" npm run dev -w @wolfpack/console
