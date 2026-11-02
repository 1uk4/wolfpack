#!/usr/bin/env bash
# Runs INSIDE the tracer image (see run-sim.sh). Proves, with a systemctl double, the parts that are ours: workerd (user workerd-wolves, --wolfd-transport socket,
# --wolfd wolfd-unit.sh) supervises wolf hal2 whose wolfd runs as wolf-hal2; adopt after workerd restart; recovery after kill -9; isolation by file mode.
set -euo pipefail
cp /opt/wolves/fake-systemctl.sh /usr/local/bin/systemctl; chmod +x /usr/local/bin/systemctl
useradd --system --create-home --home-dir /var/lib/workerd-wolves --shell /usr/sbin/nologin workerd-wolves
useradd --create-home --shell /usr/sbin/nologin wolf-bob
/opt/wolves/provision-wolf.sh hal2 >/dev/null; usermod -aG wolf-hal2 workerd-wolves
H=/home/wolf-hal2
printf 'name: hal2\nworkspace: %s/work\nserve:\n  socket: /run/wolfd-hal2/serve.sock\n' $H > $H/wolf.yaml
echo "CLAUDE_CODE_OAUTH_TOKEN='x'" > $H/.env; chmod 600 $H/.env; chown -R wolf-hal2:wolf-hal2 $H
install -d -o workerd-wolves -m 700 /var/lib/workerd-wolves
install -d -m 1777 /var/spool/fake-pid1
( while :; do for f in /var/spool/fake-pid1/*.req; do [ -e "$f" ] || continue; read -r v u < "$f"; FAKE_PID1=1 systemctl $v $u; rm -f "$f"; done; sleep 0.1; done ) &
W() { runuser -u workerd-wolves -- env HOME=/var/lib/workerd-wolves WORKERD_CONFIG_DIR=/var/lib/workerd-wolves WORKERD_FEED=0 \
      node /opt/wolfpack/packages/workerd/dist/bin/workerd.js --wolves /etc/wolfpack/wolves --host 127.0.0.1 --port 7143 --wolfd /opt/wolves/wolfd-unit.sh --wolfd-transport socket; }
ok() { echo "ok: $*"; }; bad() { echo "FAIL: $*"; exit 1; }
up() { for _ in $(seq 1 40); do curl -sf http://127.0.0.1:7143/healthz | grep -q '"state":"online"' && return 0; sleep 0.5; done; return 1; }
W > /var/log/workerd-wolves.log 2>&1 & up || { cat /var/log/workerd-wolves.log; bad "wolf never online"; }
curl -s http://127.0.0.1:7143/healthz | head -c 400; echo
WP=$(pgrep -u workerd-wolves -f "^node .*bin/workerd.js"); FP=$(pgrep -u wolf-hal2 -f "^node /opt/tracer/stub-wolfd.mjs --config")
[ "$(ps -o user= -p $WP)" = workerd-wolves ] && [ "$(ps -o user= -p $FP)" = wolf-hal2 ] && ok "workerd runs as $(ps -o user= -p $WP), wolfd as $(ps -o user= -p $FP)" || bad users
[ "$(stat -c '%U:%a' /run/wolfd-hal2)" = wolf-hal2:750 ] && ok "socket dir wolf-hal2:750"
runuser -u workerd-wolves -- cat $H/.env >/dev/null 2>&1 && bad "workerd-wolves can read the wolf .env" || ok "workerd-wolves cannot read $H/.env"
runuser -u wolf-bob -- ls $H >/dev/null 2>&1 && bad "another wolf user can list the home" || ok "wolf-bob cannot list $H"
curl -sf --unix-socket /run/wolfd-hal2/serve.sock http://x/v1/wolves | grep -q hal2 && ok "wolfd answers on the socket"
# adopt: stop workerd (SIGTERM), wolfd must keep running; a new workerd adopts it (same pid)
pkill -TERM -u workerd-wolves -f "^node .*bin/workerd.js"; sleep 2; kill -0 $FP && ok "wolfd survived workerd stop"
W > /var/log/workerd-wolves2.log 2>&1 & up; curl -s http://127.0.0.1:7143/healthz | grep -q '"adopted":true' && ok "restarted workerd adopted the running wolfd" || bad "no adoption"
# kill -9 wolfd: unit (double: restart loop) brings it back; workerd stays online
kill -9 $FP
NP=""; for _ in $(seq 1 40); do NP=$(pgrep -u wolf-hal2 -f "^node /opt/tracer/stub-wolfd.mjs --config" || true); [ -n "$NP" ] && [ "$NP" != "$FP" ] && break; sleep 0.5; done
sleep 4   # workerd notices the adopted wolf stopped answering, runs wolfd-unit.sh again, which re-attaches to the restarted unit
up && [ -n "$NP" ] && [ "$NP" != "$FP" ] && curl -s http://127.0.0.1:7143/healthz | grep -q '"restarts":1' && ok "wolfd restarted after kill -9 (pid $FP -> $NP); workerd restarts=1 and reports it online" || { curl -s http://127.0.0.1:7143/healthz || true; tail -15 /var/log/workerd-wolves2.log; bad "no recovery"; }
echo SIM PASS
