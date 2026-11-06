#!/usr/bin/env bash
# Packaging smoke: unpack a wolfd release tarball into a CLEAN plain-node container (no repo, no npm: npm/npx are replaced by
# tripwires that fail the run if called) and start it with launch.sh. Asserts: guards refuse, wolfd serves GET /v1/wolves,
# the SDK native dep + pinned claude CLI are present, no .env in the tarball. The .env used is a throwaway dummy token.
#   scripts/smoke-wolfd-release.sh <wolfd-*-linux-x64.tar.gz>
set -euo pipefail
TGZ=${1:?usage: smoke-wolfd-release.sh <tarball>}
case "$TGZ" in *x64*) PLAT=linux/amd64;; *arm64*) PLAT=linux/arm64;; *) echo "can't tell arch from name" >&2; exit 2;; esac
TGZ=$(cd "$(dirname "$TGZ")" && pwd)/$(basename "$TGZ")
docker run --rm --platform "$PLAT" -v "$TGZ:/in/release.tgz:ro" node:22-bookworm-slim bash -euo pipefail -c '
rm -f /usr/local/bin/npm /usr/local/bin/npx
printf "#!/bin/sh\necho \"npm called: \$*\" >> /tmp/npm-called\nexit 99\n" > /usr/local/bin/npm; cp /usr/local/bin/npm /usr/local/bin/npx; chmod +x /usr/local/bin/npm /usr/local/bin/npx
useradd -m -s /bin/bash wolf-hal2
install -d -o wolf-hal2 -g wolf-hal2 /opt/wolfd
tar -xzf /in/release.tgz -C /opt/wolfd
test -z "$(tar -tzf /in/release.tgz | grep -E "(^|/)\.env$" || true)" || { echo "FAIL .env in tarball"; exit 1; }
echo "== unpacked: $(cat /opt/wolfd/VERSION), $(du -sh /opt/wolfd | cut -f1)"
ls -d /opt/wolfd/node_modules/@anthropic-ai/claude-agent-sdk-linux-* && echo "claude cli: $(/opt/wolfd/tools/bin/claude --version)"
echo "== roster: bundled agent profiles present"
node --input-type=module -e "const m=await import(\"/opt/wolfd/packages/agents/dist/index.js\");const a=m.discoverAgents({cwd:\"/tmp\",agentDir:\"/tmp/none\"}).map(x=>x.name);console.log(\"roster:\",a.join(\",\"));if(!a.includes(\"worker\")){console.error(\"FAIL roster empty or worker missing\");process.exit(1)}"
H=/home/wolf-hal2
cp /opt/wolfd/templates/models.json $H/models.json
printf "name: hal2\nworkspace: $H/work\n" > $H/wolf.yaml; mkdir -p $H/work
printf "CLAUDE_CODE_OAUTH_TOKEN=smoke-dummy-not-a-secret\n" > $H/.env; chmod 600 $H/.env; chown -R wolf-hal2:wolf-hal2 $H
L="runuser -u wolf-hal2 -- env HOME=$H /opt/wolfd/launch.sh"
echo "== guard: ANTHROPIC_API_KEY refuses"
set +e; runuser -u wolf-hal2 -- env HOME=$H ANTHROPIC_API_KEY=x /opt/wolfd/launch.sh --port 0 2>&1 | tail -1; rc=${PIPESTATUS[0]}; set -e; [ $rc = 78 ] || { echo "FAIL guard rc=$rc"; exit 1; }
echo "== guard: subscription without token refuses"
mv $H/.env $H/.env.bak
set +e; $L --port 0 2>&1 | tail -1; rc=${PIPESTATUS[0]}; set -e; [ $rc = 78 ] || { echo "FAIL guard rc=$rc"; exit 1; }
mv $H/.env.bak $H/.env
echo "== start wolfd via launch.sh"
( $L --port 7711 > /tmp/wolfd.log 2>&1 & )
for i in $(seq 1 40); do
  if node -e "fetch(\"http://127.0.0.1:7711/v1/wolves\").then(async r=>{const t=await r.text();console.log(r.status,t.slice(0,200));process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"; then ok=1; break; fi; sleep 1
done
[ "${ok:-}" = 1 ] || { echo "FAIL wolfd did not answer"; tail -20 /tmp/wolfd.log; exit 1; }
head -3 /tmp/wolfd.log
[ ! -e /tmp/npm-called ] || { echo "FAIL npm was called:"; cat /tmp/npm-called; exit 1; }
echo "SMOKE OK (no npm call)"
'
