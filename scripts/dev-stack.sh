#!/usr/bin/env bash
# One-terminal dev stack: workerd (supervising every wolf in WOLVES_DIR) + console.
#   npm run dev:stack            # browser console on :3000
#   npm run dev:stack:desktop    # Electron app (console on :3210 inside)
# Env (all optional):
#   WOLVES_DIR            dir of wolf dirs with wolf.yaml   (default ~/wolves/dev)
#   WOLFPACK_MODELS_FILE  models.json (transport "api")     (default: first */models.json in WOLVES_DIR)
#   WORKERD_PORT          workerd /v1 port                  (default 7141)
#   DEV_STACK_NO_EXT_INSTALL=1   skip the sandbox extension reinstall below
# Secrets (ANTHROPIC_API_KEY) are sourced from ~/.wolfpack/.env when present. The key is only required when the models
# file's transport is "api"; a "subscription" table runs through the Claude Agent SDK bridge (your local login).
#
# Sandboxed wolves (wolf.yaml `sandbox:`) share ONE dev root (default ~/wolves/dev/sandbox: ledger copy, KB copy, ops
# lanes, a den per wolf). workerd starts the single local work server for it (any starter of that ledger takes the
# <root>/run/work-server.lock itself, so a second writer fails loudly; this script starts none); a librarian wolf (dewey-dev) sweeps the KB
# copy on its own timer and needs Ollama at 127.0.0.1:11434 (nomic-embed-text). See docs/dev-sandbox.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WOLVES_DIR="${WOLVES_DIR:-$HOME/wolves/dev}"
WORKERD_PORT="${WORKERD_PORT:-7141}"

[ -f "$HOME/.wolfpack/.env" ] && { set -a; source "$HOME/.wolfpack/.env"; set +a; }

# A models.json beside a dev wolf wins over anything inherited from the shell
# or pack .env, so the dev wolves run on the models picked for them (subscription
# or api), not on whatever table the surrounding environment points at.
DEV_MODELS_FILE="$(ls "$WOLVES_DIR"/*/models.json 2>/dev/null | head -1 || true)"
if [ -n "$DEV_MODELS_FILE" ]; then
  WOLFPACK_MODELS_FILE="$DEV_MODELS_FILE"
fi
if [ -z "${WOLFPACK_MODELS_FILE:-}" ] || [ ! -f "$WOLFPACK_MODELS_FILE" ]; then
  echo "dev-stack: no models.json found (set WOLFPACK_MODELS_FILE or put one beside a wolf in $WOLVES_DIR)" >&2
  exit 1
fi
export WOLFPACK_MODELS_FILE
MODELS_TRANSPORT="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).transport||"api")}catch(e){console.log("api")}' "$WOLFPACK_MODELS_FILE")"
if [ "$MODELS_TRANSPORT" = "api" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "dev-stack: ANTHROPIC_API_KEY not set (transport is api; export it or add to ~/.wolfpack/.env, or use a subscription models.json)" >&2
  exit 1
fi
if grep -qsE '^\s*librarian:\s*true' "$WOLVES_DIR"/*/wolf.yaml && ! curl -fsS -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "dev-stack: warning: a librarian wolf is configured but Ollama is not answering on 127.0.0.1:11434 (its sweep will back off)" >&2
fi

echo "dev-stack: wolves=$WOLVES_DIR  models=$WOLFPACK_MODELS_FILE ($MODELS_TRANSPORT)  workerd=:$WORKERD_PORT"
npx turbo run build --filter=@wolfpack/harness --filter=@wolfpack/workerd --filter=@wolfpack/cli --output-logs=errors-only

# wolfd loads each wolf's extensions from the INSTALLED bundle in its den, which nothing else rebuilds. Reinstall the
# sandboxed wolves' bundles from this checkout's CLI when stale (non-sandbox dens are only warned about).
node "$ROOT/scripts/dev-stack-extensions.mjs" "$WOLVES_DIR"

node "$ROOT/packages/workerd/dist/bin/workerd.js" \
  --wolves "$WOLVES_DIR" --port "$WORKERD_PORT" &
WORKERD_PID=$!

cleanup() { kill "$WORKERD_PID" 2>/dev/null || true; wait "$WORKERD_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

APP_WS="@wolfpack/${STACK_APP:-console}"
WOLFPACK_API_URL="http://127.0.0.1:$WORKERD_PORT" npm run dev -w "$APP_WS"
