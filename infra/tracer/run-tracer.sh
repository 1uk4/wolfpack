#!/usr/bin/env bash
# One command, from anywhere:  infra/tracer/run-tracer.sh   (needs a running Docker daemon). Exit code = the relay client's.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${TRACER_IMAGE:-wolfpack-tracer}"
docker build -q -f "$ROOT/infra/tracer/Dockerfile" -t "$IMAGE" "$ROOT" >/dev/null
# --tmpfs /data + --rm: all state is throwaway. No host mounts, no network access needed at run time, no secrets.
exec docker run --rm --tmpfs /data:exec,mode=755 ${TRACER_DOCKER_ARGS:-} "$IMAGE"
