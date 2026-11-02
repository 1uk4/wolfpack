#!/usr/bin/env bash
# Durability seam: persistent volumes (not tmpfs), kill -9 wolfd mid-turn, restart the container, assert the turn completes.
#   infra/tracer/durability.sh        (stub mode: slow two-step scripted model; needs Docker; no secrets)
# Phase 1 (container "up"): hubd + workerd + wolfd, submit a turn whose first model request takes TRACER_SLOW_MS (default 15000).
# Host: after 4s, kill -9 workerd then wolfd (workerd first, so its supervisor can't respawn wolfd before the container is stopped), docker kill.
# Phase 2 (same volumes): `docker start` re-runs the entrypoint with TRACER_DURABLE=check; fresh hubd/workerd/wolfd processes; the turn is NOT resubmitted.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; IMAGE="${TRACER_IMAGE:-wolfpack-tracer}"; N=tracer-dur-$$
V1=$N-data; V2=$N-home
cleanup() { docker rm -f $N >/dev/null 2>&1 || true; docker volume rm $V1 $V2 >/dev/null 2>&1 || true; }; trap cleanup EXIT
docker build -q -f "$ROOT/infra/tracer/Dockerfile" -t "$IMAGE" "$ROOT" >/dev/null
docker volume create $V1 >/dev/null; docker volume create $V2 >/dev/null
docker run -d --name $N -v $V1:/data -v $V2:/home/wolf-hal2 -e TRACER_DURABLE=up -e TRACER_SLOW_MS="${TRACER_SLOW_MS:-15000}" -e TRACER_REPLY=tracer-pong "$IMAGE" >/dev/null
for _ in $(seq 1 90); do docker exec $N test -f /data/log/submitted 2>/dev/null && break; sleep 1; done
docker exec $N test -f /data/log/submitted || { docker logs $N | tail -30; echo "FAIL: turn never submitted" >&2; exit 1; }
sleep 4
echo "== mid-turn: wolfd/workerd processes before the kill"; docker exec $N ps -eo pid,user,args | grep -E "stub-wolfd|bin/workerd" | grep -v grep || true
docker exec $N pkill -KILL -f "bin/workerd.js --wolves"; docker exec $N pkill -KILL -f "stub-wolfd.mjs" || true
echo "== kill -9 sent to workerd and wolfd; killing and restarting the container"
docker kill $N >/dev/null
docker rm -f $N >/dev/null
docker run --name $N --rm -v $V1:/data -v $V2:/home/wolf-hal2 -e TRACER_DURABLE=check -e TRACER_SLOW_MS="${TRACER_SLOW_MS:-15000}" -e TRACER_REPLY=tracer-pong "$IMAGE"
