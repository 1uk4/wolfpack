#!/usr/bin/env bash
# One command, from anywhere (needs a running Docker daemon). Exit code = the relay client's.
#   infra/tracer/run-tracer.sh          stub mode (default): scripted model, no secrets, CI-safe
#   infra/tracer/run-tracer.sh --kb     stub model + REAL memory/tasks extensions: hub KB mirror, memory -> hub contribution, graduation preview (kb-proof.sh)
#   infra/tracer/run-tracer.sh --kb --ro-work is spelled `--ro-work`: --kb with hubd's domains/*/work made READ-ONLY after seeding (mirrors sfo-01, H6b)
#   infra/tracer/run-tracer.sh --console  stub model + the standalone console (relay mode) + headless chromium: browser thread round-trip to hal2 via hubd; screenshots in infra/tracer/out
#   infra/tracer/run-tracer.sh --max    real wolfd bin + claude bridge, billed to the owner's Max subscription
# --max reads the token from $CLAUDE_CODE_OAUTH_TOKEN_FILE (default ~/.wolfpack/secrets/claude-oauth-token), else $CLAUDE_CODE_OAUTH_TOKEN.
# It is mounted read-only at run time (never baked into the image, never in `docker run` args or env).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${TRACER_IMAGE:-wolfpack-tracer}"
MODE=stub; [ "${1:-}" = "--max" ] && MODE=max
KBARGS=(); [ "${1:-}" = "--kb" ] && KBARGS=(-e TRACER_KB=1)
[ "${1:-}" = "--ro-work" ] && KBARGS=(-e TRACER_KB=1 -e TRACER_RO_WORK=1 --cap-add SYS_ADMIN)
docker build -q -f "$ROOT/infra/tracer/Dockerfile" -t "$IMAGE" "$ROOT" >/dev/null
CONSOLE_ARGS=()
if [ "${1:-}" = "--console" ]; then
  docker build -q -f "$ROOT/infra/tracer/Dockerfile.console" --build-arg "BASE=$IMAGE" -t "$IMAGE-console" "$ROOT" >/dev/null
  IMAGE="$IMAGE-console"; mkdir -p "$ROOT/infra/tracer/out"
  CONSOLE_ARGS=(-e TRACER_CONSOLE=1 -v "$ROOT/infra/tracer/out:/out")
fi
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
docker run "${args[@]}" ${KBARGS[@]+"${KBARGS[@]}"} ${CONSOLE_ARGS[@]+"${CONSOLE_ARGS[@]}"} ${TRACER_DOCKER_ARGS:-} "$IMAGE"
