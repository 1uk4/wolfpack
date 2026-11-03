#!/usr/bin/env bash
# H6c proof: hubd --hub-writes under REAL systemd (PID 1 in a privileged throw-away container), with the REAL deploy/hubd/setup.sh and a real
# hubd bundle from this checkout. Local only. Prints HUB WRITES PROOF OK. Run once, foreground:  deploy/hubd/hub-writes-proof.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
N=hubw-systemd-proof; IMG=wolfpack-hubw-systemd
W=$(mktemp -d); trap 'docker rm -f $N >/dev/null 2>&1 || true; docker rmi $IMG >/dev/null 2>&1 || true; rm -rf "$W"' EXIT
docker build -q -f "$ROOT/infra/release/Dockerfile.systemd-proof" -t $IMG "$ROOT/infra/release" >/dev/null
"$ROOT/scripts/release-build.sh" hubd 0.9.1 "$W/rel" >/dev/null
mkdir -p "$W/x"; tar -xzf "$W/rel/hubd-v0.9.1-linux-x64.tar.gz" -C "$W/x"
docker run -d --name $N --privileged --cgroupns=host --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$W/x/hubd:/srv/bundle:ro" -v "$ROOT/deploy:/opt/deploy:ro" $IMG >/dev/null
s=""; for _ in $(seq 1 30); do s=$(docker exec $N systemctl is-system-running 2>/dev/null || true); case "$s" in running|degraded) break ;; esac; sleep 1; done
echo "systemd in the container: $s ($(docker exec $N systemctl --version | head -1))"
docker exec $N bash /opt/deploy/hubd/hub-writes-proof-inner.sh
