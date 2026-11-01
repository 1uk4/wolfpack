#!/usr/bin/env bash
# Runs INSIDE the container (as root): hubd (user hubd) + non-link-only workerd supervising wolfd (user wolf-hal2, wolf `hal2`),
# pairs them, runs the relay client, records RSS. Data lives under /data (tmpfs/volume), nothing else is written.
set -euo pipefail
APP=/opt/wolfpack; T=/opt/tracer
HUB_PORT=3150; HUB="http://127.0.0.1:$HUB_PORT"; HOST_ID=docker-01
D=/data; HUBD_DATA=$D/hubd; WHOME=/home/wolf-hal2; WOLVES=$WHOME/wolves/docker
mkdir -p "$HUBD_DATA" "$WOLVES/hal2/work" "$WHOME/.wolfpack/workerd" "$D/log"
chown -R hubd:hubd "$HUBD_DATA"; chown -R wolf-hal2:wolf-hal2 "$WHOME" ; chmod 755 "$D/log"; chown wolf-hal2 "$D/log"
cat > "$WOLVES/hal2/wolf.yaml" <<YAML
name: hal2
workspace: $WOLVES/hal2/work
YAML
chown -R wolf-hal2:wolf-hal2 "$WOLVES"
as() { runuser -u "$1" -- env "${@:2}"; }
rss() { awk '/VmRSS/{r=$2} /VmHWM/{h=$2} END{printf "%d %d", r/1024, h/1024}' "/proc/$1/status"; }  # MiB: current peak
pidof_cmd() { pgrep -u "$1" -f "$2" | head -1; }  # -u: skip the root-owned runuser wrapper
wait_for() { for _ in $(seq 1 60); do eval "$1" >/dev/null 2>&1 && return 0; sleep 1; done; echo "timeout waiting: $1" >&2; return 1; }
cleanup() { pkill -TERM -f "bin/workerd.js" 2>/dev/null || true; pkill -TERM -f "hubd/dist/cli.js" 2>/dev/null || true; }
trap cleanup EXIT

echo "== start hubd (user hubd)"
as hubd HOME=/home/hubd node $APP/packages/hubd/dist/cli.js serve --data-dir "$HUBD_DATA" --port $HUB_PORT --host 127.0.0.1 >"$D/log/hubd.log" 2>&1 &
wait_for "grep -q 'hubd listening' $D/log/hubd.log"

code() { as hubd HOME=/home/hubd node $APP/packages/hubd/dist/cli.js pair --data-dir "$HUBD_DATA" "$@" | sed -n 's/^pairing code: //p'; }
CCODE=$(code --kind console)
CTOKEN=$(curl -fsS -H 'Content-Type: application/json' -d "{\"code\":\"$CCODE\",\"label\":\"tracer-console\"}" $HUB/v1/pair | sed 's/.*"token":"\([^"]*\)".*/\1/')
auth=(-H "Authorization: Bearer $CTOKEN" -H 'Content-Type: application/json')
echo "== register host $HOST_ID and wolf hal2 (by NAME) in the hub registry"
curl -fsS "${auth[@]}" -d "{\"name\":\"$HOST_ID\"}" $HUB/v1/registry/hosts; echo
curl -fsS "${auth[@]}" -d "{\"name\":\"hal2\",\"host\":\"$HOST_ID\"}" $HUB/v1/registry/wolves; echo

echo "== pair workerd (worker token for host $HOST_ID)"
WCODE=$(code --kind worker --host-id $HOST_ID)
WENV=(HOME=$WHOME WORKERD_CONFIG_DIR=$WHOME/.wolfpack/workerd KB_OPS=$WHOME/ops)
as wolf-hal2 "${WENV[@]}" node $APP/packages/workerd/dist/bin/workerd.js pair $HUB "$WCODE"

echo "== start workerd (NOT link-only) -> supervises wolfd via the scripted-model stub (user wolf-hal2)"
as wolf-hal2 "${WENV[@]}" WORKERD_FEED=0 node $APP/packages/workerd/dist/bin/workerd.js --wolves $WOLVES --port 7142 --host 127.0.0.1 --wolfd "node $T/stub-wolfd.mjs" >"$D/log/workerd.log" 2>&1 &
wait_for "grep -q 'serving' $D/log/workerd.log"
for _ in $(seq 1 30); do curl -sf "${auth[@]}" $HUB/v1/wolves | grep -q hal2 && break; sleep 1; done

HUBD_PID=$(pidof_cmd hubd "hubd/dist/cli.js serve"); WORKERD_PID=$(pidof_cmd wolf-hal2 "bin/workerd.js --wolves"); WOLFD_PID=$(pidof_cmd wolf-hal2 "^node /opt/tracer/stub-wolfd.mjs")
echo "pids: hubd=$HUBD_PID workerd=$WORKERD_PID wolfd=$WOLFD_PID"
echo "wolfd runs as: $(ps -o user= -p "$WOLFD_PID")  workerd runs as: $(ps -o user= -p "$WORKERD_PID")"
sleep 3
read -r HUBD_IDLE _ <<<"$(rss $HUBD_PID)"; read -r WORKERD_IDLE _ <<<"$(rss $WORKERD_PID)"; read -r WOLFD_IDLE _ <<<"$(rss $WOLFD_PID)"

rm -f /tmp/tracer-turn-started
set +e
TRACER_REPLY="${TRACER_REPLY:-tracer-pong}" $T/relay-client.sh $HUB "$CTOKEN" hal2 ping 2>&1 | tee $D/log/client.out
RC=${PIPESTATUS[0]}
set -e
read -r HUBD_NOW HUBD_PEAK <<<"$(rss $HUBD_PID)"; read -r WORKERD_NOW WORKERD_PEAK <<<"$(rss $WORKERD_PID)"; read -r WOLFD_NOW WOLFD_PEAK <<<"$(rss $WOLFD_PID)"
echo
echo "RSS (MiB)   idle   after-turn   peak(VmHWM, includes the turn)"
printf "hubd        %-6s %-12s %s\n" $HUBD_IDLE $HUBD_NOW $HUBD_PEAK
printf "workerd     %-6s %-12s %s\n" $WORKERD_IDLE $WORKERD_NOW $WORKERD_PEAK
printf "wolfd       %-6s %-12s %s\n" $WOLFD_IDLE $WOLFD_NOW $WOLFD_PEAK
if [ $RC -ne 0 ]; then echo "--- logs"; tail -n 30 $D/log/*.log; fi
exit $RC
