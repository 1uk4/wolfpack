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
KB="${TRACER_KB:-}"   # kb mode: memory + KB through the hub (see kb-proof.sh)
cat > "$WOLVES/hal2/wolf.yaml" <<YAML
name: hal2
workspace: $WOLVES/hal2/work
YAML
[ -z "$KB" ] || printf "domains: [tracerkb]\nextensions: [memory]\nmemory:\n  live: true\n" >> "$WOLVES/hal2/wolf.yaml"   # memory is inert on a non-sandbox wolf unless memory.live
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

# A container restart reuses low PIDs, so the pid recorded in a kill -9 survivor's lock can name a live unrelated process; on a real host a reboot gives
# fresh PIDs and the lock dir is stale-checked the same way. Clear it like a reboot would. (Finding for H5: lock liveness is by pid only.)
[ -z "${TRACER_DURABLE:-}" ] || find "$D" /home/wolf-hal2 -name '*.lock' -path '*run*' -delete 2>/dev/null || true
echo "== start hubd (user hubd)"
as hubd HOME=/home/hubd node $APP/packages/hubd/dist/cli.js serve --data-dir "$HUBD_DATA" --port $HUB_PORT --host 127.0.0.1 >"$D/log/hubd.log" 2>&1 &
wait_for "grep -q 'hubd listening' $D/log/hubd.log" || { cat $D/log/hubd.log >&2; exit 1; }

code() { as hubd HOME=/home/hubd node $APP/packages/hubd/dist/cli.js pair --data-dir "$HUBD_DATA" "$@" | sed -n 's/^pairing code: //p'; }
CCODE=$(code --kind console)
CTOKEN=$(curl -fsS -H 'Content-Type: application/json' -d "{\"code\":\"$CCODE\",\"label\":\"tracer-console\"}" $HUB/v1/pair | sed 's/.*"token":"\([^"]*\)".*/\1/')
auth=(-H "Authorization: Bearer $CTOKEN" -H 'Content-Type: application/json')
echo "== register host $HOST_ID and wolf hal2 (by NAME) in the hub registry"
curl -fsS "${auth[@]}" -d "{\"name\":\"$HOST_ID\"}" $HUB/v1/registry/hosts || [ -n "${TRACER_DURABLE:-}" ]; echo
curl -fsS "${auth[@]}" -d "{\"name\":\"hal2\",\"host\":\"$HOST_ID\"}" $HUB/v1/registry/wolves || [ -n "${TRACER_DURABLE:-}" ]; echo   # durable restart: already registered (persisted hubd data)

if [ -n "$KB" ]; then
  echo "== kb mode: domain tracerkb in the registry, hal2 subscribed; hubd KB seeded; Work API; wolf-scoped worker token in the wolf's .env"
  curl -fsS "${auth[@]}" -d '{"name":"tracerkb"}' $HUB/v1/registry/domains >/dev/null; echo
  curl -fsS -X PATCH "${auth[@]}" -d '{"domains":["tracerkb"]}' $HUB/v1/registry/wolves/hal2 >/dev/null
  SEED=$HUBD_DATA/kb/base/domains/tracerkb/entries; mkdir -p "$SEED"
  printf -- '---\nid: kb-tracerkb-aaaaaaa\ntitle: "Tracer seed"\ndomain: tracerkb\n---\n\n# Tracer seed\n\nTRACER-SEED-ENTRY served by the hub KB mirror.\n' > "$SEED/kb-tracerkb-aaaaaaa.md"
  chown -R hubd:hubd "$HUBD_DATA/kb"; touch -d '1 hour ago' "$SEED/kb-tracerkb-aaaaaaa.md"
  # The wolf's OWN hub token (a second worker token of the same host; workerd's hub.json is unreadable to the wolf on the VPS). It is also the Work API
  # key: hubd proxies /v1/workapi/work (scoped to this host's wolves), so there is no separate work server.
  KCODE=$(code --kind worker --host-id $HOST_ID)
  KTOKEN=$(curl -fsS -H 'Content-Type: application/json' -d "{\"code\":\"$KCODE\",\"label\":\"hal2-wolf\"}" $HUB/v1/pair | sed 's/.*"token":"\([^"]*\)".*/\1/')
  w() { curl -fsS -H "X-API-Key: $KTOKEN" -H 'Content-Type: application/json' "${@:2}" "$HUB/v1/workapi/work$1"; }
  FEAT=$(w "" -d '{"kind":"feature","domain":"tracerkb","title":"Session caching","assignee":"hal2","body":"# Session caching\n\n## Plan\n\nCache it.\n"}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
  TASK=$(w "" -d "{\"kind\":\"task\",\"domain\":\"tracerkb\",\"title\":\"Task 0\",\"assignee\":\"hal2\",\"partOf\":\"$FEAT\",\"successCriteria\":\"it works\"}" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  w /$TASK -X PATCH -d '{"stage":"shipped"}' >/dev/null
  echo "work items (created through the hub proxy with the wolf's token): feature=$FEAT task=$TASK"
  if [ -n "${TRACER_RO_WORK:-}" ]; then
    # H6b: mirror sfo-01 (ProtectSystem=strict): a REAL read-only mount over each domains/*/work, so a write fails with EROFS (chmod would give
    # EACCES, which maps to a different error). Needs CAP_SYS_ADMIN (run-tracer.sh --ro-work adds it for this container only). The ledger stays writable.
    for d in "$HUBD_DATA"/kb/base/domains/*/work; do
      [ -d "$d" ] || continue
      mount --bind "$d" "$d" && mount -o remount,ro,bind "$d" || { echo "FATAL: cannot make $d read-only (needs --cap-add SYS_ADMIN)" >&2; exit 78; }
      findmnt -no TARGET,OPTIONS "$d" | grep -qw ro || { echo "FATAL: $d is not mounted ro" >&2; exit 78; }
      if su -s /bin/sh hubd -c "touch '$d/.erofs-check'" 2>/tmp/erofs.err; then echo "FATAL: $d is still writable" >&2; exit 78; fi
      grep -q 'Read-only file system' /tmp/erofs.err || { echo "FATAL: write to $d did not fail with EROFS: $(cat /tmp/erofs.err)" >&2; exit 78; }
      echo "== ro-work: $d is a read-only mount; a hubd write fails with: $(cat /tmp/erofs.err)"
    done
    find "$HUBD_DATA"/kb/base/domains/*/work -printf '%p %s %T@ %m\n' | sort > /tmp/ro-work.before
    sha256sum "$HUBD_DATA/ledger/work-events.jsonl" > /tmp/ro-ledger.before
    echo "== ro-work: domains/*/work is now read-only for hubd ($(wc -l < /tmp/ro-work.before) entries snapshotted)"
  fi
  ( umask 077; printf "TRACER_KB=1\nWOLF_HOME=%s\nWOLFPACK_HUB_KB=1\nWOLFPACK_HUB_URL=%s\nWOLFPACK_HUB_TOKEN=%s\nWORK_ENDPOINT=%s/v1/workapi\nWORK_TOKEN=%s\nWOLFPACK_KB_FEED_MS=1000\nWOLFPACK_KB_POLL_MS=2000\n" "$WHOME" "$HUB" "$KTOKEN" "$HUB" "$KTOKEN" > "$WHOME/.env" ); chown wolf-hal2:wolf-hal2 "$WHOME/.env"
  # scope check from the host side: another host's token must not see the item
  OCODE=$(code --kind worker --host-id other-host); OTOKEN=$(curl -fsS -H 'Content-Type: application/json' -d "{\"code\":\"$OCODE\",\"label\":\"other\"}" $HUB/v1/pair | sed 's/.*"token":"\([^"]*\)".*/\1/')
  c=$(curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: $OTOKEN" $HUB/v1/workapi/work/$FEAT); echo "scope: a worker token of another host reads the item -> HTTP $c"; [ "$c" = 404 ] || [ "$c" = 403 ] || { echo "FAIL: scope leak ($c)" >&2; exit 1; }
  unset KTOKEN OTOKEN
fi

echo "== pair workerd (worker token for host $HOST_ID)"
WCODE=$(code --kind worker --host-id $HOST_ID)
WENV=(HOME=$WHOME WORKERD_CONFIG_DIR=$WHOME/.wolfpack/workerd KB_OPS=$WHOME/ops)
as wolf-hal2 "${WENV[@]}" node $APP/packages/workerd/dist/bin/workerd.js pair $HUB "$WCODE"

if [ "$MODE" = max ]; then WOLFD_CMD="$T/wolfd-max.sh"; WOLFD_PAT="bin/wolfd.js --config"; echo "== start workerd (NOT link-only) -> supervises the REAL wolfd bin on the claude bridge (user wolf-hal2)"
elif [ -n "$KB" ]; then WOLFD_CMD="$T/wolfd-kb.sh"; WOLFD_PAT="^node /opt/tracer/stub-wolfd.mjs"; echo "== start workerd (NOT link-only) -> supervises the scripted-model wolfd with the REAL memory/tasks extensions + hub KB (user wolf-hal2)"
else WOLFD_CMD="node $T/stub-wolfd.mjs"; WOLFD_PAT="^node /opt/tracer/stub-wolfd.mjs"; echo "== start workerd (NOT link-only) -> supervises wolfd via the scripted-model stub (user wolf-hal2)"; fi
as wolf-hal2 "${WENV[@]}" WORKERD_FEED=0 node $APP/packages/workerd/dist/bin/workerd.js --wolves $WOLVES --port 7142 --host 127.0.0.1 --wolfd "$WOLFD_CMD" >"$D/log/workerd.log" 2>&1 &
wait_for "grep -q 'serving' $D/log/workerd.log" || { tail -n 30 $D/log/workerd.log >&2; exit 1; }
for _ in $(seq 1 30); do curl -sf "${auth[@]}" $HUB/v1/wolves | grep -q hal2 && break; sleep 1; done

if [ -n "$KB" ]; then
  set +e; TRACER_REPLY=tracer-pong $T/kb-proof.sh $HUB "$CTOKEN" hal2 "$FEAT" "$HUBD_DATA" "$WHOME"; RC=$?; set -e
  [ $RC -eq 0 ] || { echo "--- logs"; tail -n 30 $D/log/*.log; }
  exit $RC
fi
if [ -n "${TRACER_DURABLE:-}" ]; then
  # Durability seam (see durability.sh). up: submit a slow two-step turn and idle, the host kill -9s wolfd mid-turn and restarts the container.
  # check: same persistent volumes, fresh processes: the turn must finish on its own (no resubmit) and the thread must be consistent.
  TH="hal2%2Fhome"; get() { curl -fsS "${auth[@]}" "$HUB/v1/threads/$TH"; }
  if [ "$TRACER_DURABLE" = up ]; then
    for _ in $(seq 1 40); do   # 502 until wolfd is up behind the relay
      c=$(curl -sS -o /dev/null -w '%{http_code}' "${auth[@]}" -d '{"input":"ping","whenBusy":"reject"}' $HUB/v1/threads/$TH/submit); [ "$c" = 200 ] && break; sleep 1
    done
    echo "durable: turn submitted (HTTP $c)"; [ "$c" = 200 ] || exit 1
    touch $D/log/submitted; sleep infinity & wait
  fi
  echo "durable: restarted; wolfd pid $(pidof_cmd wolf-hal2 "$WOLFD_PAT") (a new process); waiting for the interrupted turn to finish WITHOUT resubmitting"
  RC=1
  for i in $(seq 1 120); do
    j=$(get || true)
    if echo "$j" | grep -q "$TRACER_REPLY"; then RC=0; break; fi; sleep 1
  done
  echo "durable: after ${i}s thread detail: $(echo "$j" | head -c 1500)"
  if [ $RC -eq 0 ]; then
    users=$(echo "$j" | grep -o '"role":"user"' | wc -l); finals=$(echo "$j" | grep -o "$TRACER_REPLY" | wc -l)
    echo "durable: user messages=$users, final replies=$finals"
    [ "$users" = 1 ] && [ "$finals" -ge 1 ] || RC=2
  fi
  [ $RC -eq 0 ] && echo "DURABILITY PASS: the interrupted turn completed after kill -9 + container restart" || { echo "DURABILITY FAIL rc=$RC"; tail -n 20 $D/log/workerd.log; }
  exit $RC
fi
if [ -n "${TRACER_CONSOLE:-}" ]; then
  # --console: the standalone console (scripts/build-server.mjs payload at /opt/console) in RELAY mode + a headless browser round-trip to hal2.
  # Relay mode = WOLFPACK_HUB_URL set, WOLFPACK_API_URL NOT set, and a token. The token is the BROWSER's (a `hubd pair --kind browser` code traded at
  # /v1/pair, handed to the console's /pair page as #token=, exactly what the hub's own /pair page does); the console process itself holds no token.
  OUT=/out; mkdir -p "$OUT"; rm -f "$OUT"/console-proof-*.png
  BCODE=$(code --kind browser); BTOKEN=$(curl -fsS -H 'Content-Type: application/json' -d "{\"code\":\"$BCODE\",\"label\":\"tracer-browser\"}" $HUB/v1/pair | sed 's/.*"token":"\([^"]*\)".*/\1/')
  CPORT=3210; CONSOLE=http://127.0.0.1:$CPORT
  echo "== start console (user console, standalone server, RELAY mode: WOLFPACK_HUB_URL=$HUB, no WOLFPACK_API_URL, no env token)"
  ( cd /opt/console && exec runuser -u console -- env -u WOLFPACK_API_URL -u WOLFPACK_HUB_TOKEN HOME=/home/console PORT=$CPORT HOSTNAME=127.0.0.1 NODE_ENV=production WOLFPACK_HUB_URL=$HUB node server.js ) >"$D/log/console.log" 2>&1 &
  wait_for "curl -sf $CONSOLE/pair" || { cat $D/log/console.log >&2; exit 1; }
  CPID=$(pgrep -u console | head -1); CENV=$(runuser -u console -- tr '\0' '\n' < /proc/$CPID/environ 2>/dev/null || runuser -u console -- sh -c "tr '\\0' '\\n' < /proc/$CPID/environ")
  echo "console env (pid $CPID): WOLFPACK_API_URL set: $(echo "$CENV" | grep -c '^WOLFPACK_API_URL=') (must be 0); WOLFPACK_HUB_URL set: $(echo "$CENV" | grep -c '^WOLFPACK_HUB_URL=') (must be 1)"
  [ "$(echo "$CENV" | grep -c '^WOLFPACK_API_URL=')" = 0 ] && [ "$(echo "$CENV" | grep -c '^WOLFPACK_HUB_URL=')" = 1 ] || { echo "FATAL: console is not configured for relay mode" >&2; exit 1; }
  set +e
  ( cd /opt/proof && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node console-proof.mjs $CONSOLE "$BTOKEN" "$OUT" "${TRACER_REPLY:-tracer-pong}" ); RC=$?
  if [ $RC -eq 0 ]; then
    # hub-side evidence that the console really went through the relay: the browser token was used by the console server on the hub
    as hubd HOME=/home/hubd node $APP/packages/hubd/dist/cli.js tokens list --data-dir "$HUBD_DATA" | tee /tmp/tokens.out
    grep 'tracer-browser' /tmp/tokens.out | grep -vq 'lastUsed=never' || { echo "FAIL: hubd never saw the browser token used" >&2; RC=1; }
  fi
  set -e
  if [ $RC -eq 0 ]; then echo "CONSOLE RELAY PROOF OK: browser -> console (relay mode) -> hubd -> workerd -> wolfd hal2 -> reply rendered"; else echo "CONSOLE RELAY PROOF FAILED (screenshot in /out, i.e. infra/tracer/out)"; echo "--- logs"; tail -n 30 $D/log/*.log; fi
  exit $RC
fi
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
