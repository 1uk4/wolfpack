#!/usr/bin/env bash
# One command, from anywhere (needs a running Docker daemon). Exit code = the relay client's.
#   infra/tracer/run-tracer.sh          stub mode (default): scripted model, no secrets, CI-safe
#   infra/tracer/run-tracer.sh --max    real wolfd bin + claude bridge, billed to the owner's Max subscription
# --max reads the token from $CLAUDE_CODE_OAUTH_TOKEN_FILE (default ~/.wolfpack/secrets/claude-oauth-token), else $CLAUDE_CODE_OAUTH_TOKEN.
# It is mounted read-only at run time (never baked into the image, never in `docker run` args or env).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${TRACER_IMAGE:-wolfpack-tracer}"
MODE=stub; [ "${1:-}" = "--max" ] && MODE=max
docker build -q -f "$ROOT/infra/tracer/Dockerfile" -t "$IMAGE" "$ROOT" >/dev/null
# --tmpfs /data + --rm: all state is throwaway.
args=(--rm --tmpfs /data:exec,mode=755)
if [ "$MODE" = max ]; then
  f="${CLAUDE_CODE_OAUTH_TOKEN_FILE:-$HOME/.wolfpack/secrets/claude-oauth-token}"
  if [ ! -s "$f" ]; then
    [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || { echo "run-tracer --max: no token. Create $f (output of 'claude setup-token', chmod 600) or set CLAUDE_CODE_OAUTH_TOKEN." >&2; exit 2; }
    f="$(mktemp)"; chmod 600 "$f"; trap 'rm -f "$f"' EXIT; printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > "$f"
  fi
  args+=(--mount "type=bind,src=$f,dst=/run/secrets/claude-oauth-token,readonly" -e TRACER_MODE=max)
fi
# no exec: the temp token file (env-var case) must be removed by the trap
docker run "${args[@]}" ${TRACER_DOCKER_ARGS:-} "$IMAGE"
