#!/usr/bin/env bash
# Runs INSIDE the container (as root): hubd (user hubd) + non-link-only workerd supervising wolfd (user wolf-hal2, wolf `hal2`),
# pairs them, runs the relay client, records RSS. Data lives under /data (tmpfs/volume), nothing else is written.
set -euo pipefail
APP=/opt/wolfpack; T=/opt/tracer
HUB_PORT=3150; HUB="http://127.0.0.1:$HUB_PORT"; HOST_ID=docker-01
D=/data; HUBD_DATA=$D/hubd; WHOME=/home/wolf-hal2; WOLVES=$WHOME/wolves/docker
mkdir -p "$HUBD_DATA" "$WOLVES/hal2/work" "$WHOME/.wolfpack/workerd" "$D/log"
chown -R hubd:hubd "$HUBD_DATA"; chown -R wolf-hal2:wolf-hal2 "$WHOME" ; chmod 755 "$D/log"; chown wolf-hal2 "$D/log"
MODE="${TRACER_MODE:-stub}"   # stub (default, no secrets) | max (real wolfd bin + claude bridge, billed to Max)
SECRET=/run/secrets/claude-oauth-token
if [ "$MODE" = max ]; then
  # Guards (loud, before anything starts). The token arrives as a read-only mounted file, never as env/args/image content.
  [ -z "${ANTHROPIC_API_KEY:-}" ] || { echo "FATAL: ANTHROPIC_API_KEY is set in the container env; Max mode refuses to run next to a metered key" >&2; exit 78; }
  [ -s "$SECRET" ] || { echo "FATAL: --max needs the token file mounted at $SECRET" >&2; exit 78; }
  TOK=$(tr -d '[:space:]' < "$SECRET")
  [[ "$TOK" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "FATAL: token file has unexpected characters (expected the one-line output of 'claude setup-token')" >&2; exit 78; }
  # The wolf's .env (mode 600, wolf-hal2 only): the same file the VPS keeps in the wolf home and systemd loads via EnvironmentFile.
  ( umask 077; printf "CLAUDE_CODE_OAUTH_TOKEN='%s'\n" "$TOK" > "$WHOME/.env" ); unset TOK
  echo "== max mode: claude $(claude --version) at $(command -v claude); .env written ($(stat -c '%a %U' "$WHOME/.env")); token not printed"
fi
cat > "$WOLVES/hal2/wolf.yaml" <<YAML
name: hal2
workspace: $WOLVES/hal2/work
YAML
if [ "$MODE" = max ]; then
  tier='{"model":"claude-haiku-5-5","modelSource":"default","provider":"claude-agent-sdk","piModel":"claude-stateless/claude-haiku-5-5"}'
  echo "{\"location\":\"local\",\"transport\":\"subscription\",\"transportSource\":\"default\",\"tiers\":{\"main\":$tier,\"smart\":$tier,\"fast\":$tier},\"steps\":{},\"warnings\":[]}" > "$WOLVES/hal2/models.json"
  chown wolf-hal2:wolf-hal2 "$WHOME/.env"
fi
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

if [ "$MODE" = max ]; then WOLFD_CMD="$T/wolfd-max.sh"; WOLFD_PAT="bin/wolfd.js --config"; echo "== start workerd (NOT link-only) -> supervises the REAL wolfd bin on the claude bridge (user wolf-hal2)"
else WOLFD_CMD="node $T/stub-wolfd.mjs"; WOLFD_PAT="^node /opt/tracer/stub-wolfd.mjs"; echo "== start workerd (NOT link-only) -> supervises wolfd via the scripted-model stub (user wolf-hal2)"; fi
as wolf-hal2 "${WENV[@]}" WORKERD_FEED=0 node $APP/packages/workerd/dist/bin/workerd.js --wolves $WOLVES --port 7142 --host 127.0.0.1 --wolfd "$WOLFD_CMD" >"$D/log/workerd.log" 2>&1 &
wait_for "grep -q 'serving' $D/log/workerd.log"
for _ in $(seq 1 30); do curl -sf "${auth[@]}" $HUB/v1/wolves | grep -q hal2 && break; sleep 1; done

HUBD_PID=$(pidof_cmd hubd "hubd/dist/cli.js serve"); WORKERD_PID=$(pidof_cmd wolf-hal2 "bin/workerd.js --wolves"); WOLFD_PID=$(pidof_cmd wolf-hal2 "$WOLFD_PAT")
echo "pids: hubd=$HUBD_PID workerd=$WORKERD_PID wolfd=$WOLFD_PID"
echo "wolfd runs as: $(ps -o user= -p "$WOLFD_PID")  workerd runs as: $(ps -o user= -p "$WORKERD_PID")"
sleep 3
read -r HUBD_IDLE _ <<<"$(rss $HUBD_PID)"; read -r WORKERD_IDLE _ <<<"$(rss $WORKERD_PID)"; read -r WOLFD_IDLE _ <<<"$(rss $WOLFD_PID)"

# Sum of RSS (MiB) of wolfd's whole process tree (wolfd + the claude subprocess it spawns), sampled while the turn runs.
tree() { local p; for p in $1 $(pgrep -P "$1" 2>/dev/null); do echo $p; for c in $(pgrep -P "$p" 2>/dev/null); do echo $c; done; done | sort -u; }
tree_rss() { local sum=0 r p; for p in $(tree "$1"); do r=$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null || true); sum=$((sum + ${r:-0})); done; echo $((sum/1024)); }
PEAKF=$D/log/tree-peak; echo "0 0 -" > $PEAKF
if [ "$MODE" = max ]; then
  ( while :; do t=$(tree_rss $WOLFD_PID); n=$(tree $WOLFD_PID | wc -l); read -r pt pn _ < $PEAKF; [ "$t" -gt "$pt" ] && echo "$t $n $(ps -o comm= --ppid $WOLFD_PID | tr '\n' ',')" > $PEAKF; sleep 0.5; done ) &
  SAMPLER=$!
fi
set +e
if [ "$MODE" = max ]; then
  TRACER_REPLY=pong STREAM_TIMEOUT=150 $T/relay-client.sh $HUB "$CTOKEN" hal2 "Reply with exactly one word: pong" 2>&1 | tee $D/log/client.out
else
  TRACER_REPLY="${TRACER_REPLY:-tracer-pong}" $T/relay-client.sh $HUB "$CTOKEN" hal2 ping 2>&1 | tee $D/log/client.out
fi
RC=${PIPESTATUS[0]}
[ -n "${SAMPLER:-}" ] && kill $SAMPLER 2>/dev/null
if [ "$MODE" = max ] && [ $RC -eq 0 ]; then
  echo; echo "== billing proof (Max subscription, not metered)"
  $T/billing-proof.sh "$WOLFD_PID" "$WHOME" 2>&1 | tee -a $D/log/client.out
  RC=${PIPESTATUS[0]}
fi
set -e
read -r HUBD_NOW HUBD_PEAK <<<"$(rss $HUBD_PID)"; read -r WORKERD_NOW WORKERD_PEAK <<<"$(rss $WORKERD_PID)"; read -r WOLFD_NOW WOLFD_PEAK <<<"$(rss $WOLFD_PID)"
echo
echo "RSS (MiB)   idle   after-turn   peak(VmHWM, includes the turn)"
printf "hubd        %-6s %-12s %s\n" $HUBD_IDLE $HUBD_NOW $HUBD_PEAK
printf "workerd     %-6s %-12s %s\n" $WORKERD_IDLE $WORKERD_NOW $WORKERD_PEAK
printf "wolfd       %-6s %-12s %s\n" $WOLFD_IDLE $WOLFD_NOW $WOLFD_PEAK
if [ "$MODE" = max ]; then read -r TP TN TC < $D/log/tree-peak; echo "wolfd tree peak during the turn (wolfd + claude subprocess, summed RSS): ${TP} MiB over ${TN} processes (children: ${TC})"; fi
if [ $RC -ne 0 ]; then echo "--- logs"; tail -n 30 $D/log/*.log; fi
exit $RC
