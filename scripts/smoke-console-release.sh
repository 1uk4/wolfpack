#!/usr/bin/env bash
# Smoke the standalone console payload: start `node server.js` on a free loopback port with NO hub configured and require 200 on /api/hub-url
# (pure server code, no hub needed) and on /pair (prerendered shell). Kills the server on exit. Usage: smoke-console-release.sh <payload dir>
set -euo pipefail
DIR=${1:?payload dir}
[ -f "$DIR/server.js" ] || { echo "no $DIR/server.js" >&2; exit 1; }
PORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
LOG=$(mktemp)
( cd "$DIR" && exec env -i PATH="$PATH" HOME="${TMPDIR:-/tmp}" NODE_ENV=production PORT="$PORT" HOSTNAME=127.0.0.1 HUBD_PUBLIC_URL=https://smoke.example/hub node server.js ) >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; wait $PID 2>/dev/null || true; rm -f "$LOG"' EXIT
for _ in $(seq 1 40); do
  code=$(curl -s -o /tmp/smoke-console-body.$$ -m 3 -w '%{http_code}' "http://127.0.0.1:$PORT/api/hub-url" 2>/dev/null || true)
  [ "$code" = 200 ] && break
  kill -0 $PID 2>/dev/null || { echo "console smoke: server exited"; tail -20 "$LOG"; exit 1; }
  sleep 0.5
done
body=$(cat /tmp/smoke-console-body.$$ 2>/dev/null || true); rm -f /tmp/smoke-console-body.$$
[ "$code" = 200 ] && grep -q '"url":"https://smoke.example/hub"' <<<"$body" || { echo "console smoke: /api/hub-url -> $code $body"; tail -20 "$LOG"; exit 1; }
p=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/pair" || true)
[ "$p" = 200 ] || { echo "console smoke: /pair -> $p"; tail -20 "$LOG"; exit 1; }
echo "console smoke OK (/api/hub-url runtime value, /pair 200)"
