#!/usr/bin/env bash
# C4 proof with REAL systemd (PID 1 in a privileged container) and the REAL deploy/hubd + deploy/workerd setup.sh from REAL release bundles
# built by scripts/release-build.sh. Local only. Prints SYSTEMD DEPLOY PROOF OK.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# NOTE: the container runs --privileged with the host cgroup namespace (systemd as PID 1 needs it on Docker Desktop). It is throw-away: it mounts only
# read-only copies of this repo's deploy/, infra/release and infra/wolves, and the container AND the image are removed on exit.
W=$(mktemp -d); trap 'docker rm -f c4-systemd-proof >/dev/null 2>&1 || true; docker rmi wolfpack-deploy-systemd >/dev/null 2>&1 || true; rm -rf "$W"' EXIT
docker build -q -f "$ROOT/infra/release/Dockerfile.systemd-proof" -t wolfpack-deploy-systemd "$ROOT/infra/release" >/dev/null
# A=0.9.1, B=0.9.2 (real, healthy). C=0.9.3: a real bundle whose entrypoint passes setup.sh's smoke test but crashes when run as a service.
for c in hubd workerd; do for v in 0.9.1 0.9.2; do "$ROOT/scripts/release-build.sh" $c $v "$W/rel" >/dev/null; done
  "$ROOT/scripts/release-build.sh" $c 0.9.3 "$W/rel" >/dev/null
  t=$(mktemp -d); tar -xzf "$W/rel/$c-v0.9.3-linux-x64.tar.gz" -C "$t"
  printf 'if (process.argv.length < 3 || process.argv.includes("--help")) { console.log("usage: broken"); process.exit(1); }\nconsole.error("boom: cannot start"); process.exit(1);\n' > "$t/$c/$c.mjs"
  tar -czf "$W/rel/$c-v0.9.3-linux-x64.tar.gz" -C "$t" $c; (cd "$W/rel" && sha256sum $c-v0.9.3-linux-x64.tar.gz > $c-v0.9.3-linux-x64.tar.gz.sha256); rm -rf "$t"
done
# console: the REAL deploy/console setup.sh + console.service around a STUB app (a 20-line node http server): the real Next payload is covered by
# scripts/smoke-console-release.sh; here the point is systemd (hardening, guards, loopback bind) + deploy-release.sh's HTTP probe. 0.9.3 listens then dies.
for v in 0.9.1 0.9.2 0.9.3; do
  t=$(mktemp -d); mkdir -p "$t/console/app"; cp "$ROOT"/deploy/console/{setup.sh,console.service,console.env.example,RUNBOOK.md} "$t/console/"; echo "$v+proof" > "$t/console/VERSION"
  if [ $v = 0.9.3 ]; then body='require("http").createServer((q,r)=>r.end("x")).listen(+process.env.PORT,process.env.HOSTNAME);setTimeout(()=>process.exit(1),1500);'
  else body='require("http").createServer((q,r)=>{if(q.url==="/api/hub-url"||q.url==="/"||q.url==="/api/health")return r.end("{}");r.statusCode=404;r.end()}).listen(+process.env.PORT,process.env.HOSTNAME);'; fi
  printf '%s\n' "$body" > "$t/console/app/server.js"
  mkdir -p "$W/rel"; tar -czf "$W/rel/console-v$v-linux-x64.tar.gz" -C "$t" console; (cd "$W/rel" && sha256sum console-v$v-linux-x64.tar.gz > console-v$v-linux-x64.tar.gz.sha256); rm -rf "$t"
done
docker run -d --name c4-systemd-proof --privileged --cgroupns=host --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$W/rel:/srv/rel:ro" -v "$ROOT/infra/release:/opt/release:ro" -v "$ROOT/deploy:/opt/deploy:ro" -v "$ROOT/infra/wolves:/opt/wolves-src:ro" wolfpack-deploy-systemd >/dev/null
for i in $(seq 1 30); do s=$(docker exec c4-systemd-proof systemctl is-system-running 2>/dev/null || true); case "$s" in running|degraded) break ;; esac; sleep 1; done
echo "systemd in the container: $s ($(docker exec c4-systemd-proof systemctl --version | head -1))"
docker exec c4-systemd-proof bash /opt/release/deploy-proof-systemd-inner.sh
