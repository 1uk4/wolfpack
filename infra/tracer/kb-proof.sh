#!/usr/bin/env bash
# Tracer --kb: proves, through hubd's relay (console token) and the hub's own stores, that hal2's memory + KB go through the hub:
#  1. KB READ     the seeded hub entry is readable on hal2 (GET .../kb/entries/<id> answers its content) and sits in hal2's home mirror; no Syncthing.
#  2. MEMORY      turn -> observation -> consolidate -> promote -> the contribution is in hubd's contributions store (content asserted).
#  3. GRADUATION  preview for a work item: preview_ready with a token, and NOTHING sent (hub store unchanged, item not archived/graduated, lane empty).
# usage: kb-proof.sh <hub> <console-token> <wolf> <feature-id> <hubd-data> <wolf-home>
set -euo pipefail
HUB=$1; TOKEN=$2; W=$3; FEAT=$4; HD=$5; WH=$6
auth=(-H "Authorization: Bearer $TOKEN" -H 'X-Protocol-Version: 1' -H 'Content-Type: application/json')
fail() { echo "FAIL: $*" >&2; exit 1; }
get() { curl -fsS "${auth[@]}" "$HUB$1"; }
post() { curl -sS "${auth[@]}" -X POST "$HUB$1" ${2:+-d "$2"}; }
until_() { local what=$1; shift; for _ in $(seq 1 90); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; [ -z "${ONFAIL:-}" ] || eval "$ONFAIL" >&2 || true; fail "timeout: $what"; }
CONTRIB=$HD/kb/ops/contributions/$W
ENTRY=kb-tracerkb-aaaaaaa

echo "== 0. wolf online, den local, no Syncthing"
until_ "wolf online" bash -c "curl -fsS -H 'Authorization: Bearer $TOKEN' $HUB/v1/wolves | grep -q '\"$W\"'"
DEN=$(ls -d $WH/wolves/*/$W/den $WH/den 2>/dev/null | head -1 || true); echo "den: $DEN"; [ -d "$DEN" ] || fail "no den in $WH"
case "$DEN" in $WH/*) ;; *) fail "den not under $WH";; esac
if pgrep -f syncthing >/dev/null; then fail "a syncthing process is running"; fi; echo "no syncthing process; syncthing paths in $WH: $(find $WH -iname '*syncthing*' | wc -l)"

echo "== 1. KB read: hub-served mirror in hal2's home, entry read via the wolf API"
until_ "entry readable on the wolf" bash -c "curl -fsS -H 'Authorization: Bearer $TOKEN' -H 'X-Protocol-Version: 1' $HUB/v1/wolves/$W/kb/entries/$ENTRY | grep -q TRACER-SEED-ENTRY"
get "/v1/wolves/$W/kb/entries/$ENTRY" | head -c 400; echo
F=$WH/kb-mirror/domains/tracerkb/entries/$ENTRY.md
grep -q TRACER-SEED-ENTRY "$F" || fail "mirror file $F lacks the seed content"
echo "mirror file: $F ($(stat -c '%U %a' $F)); content has TRACER-SEED-ENTRY"
echo "PASS 1: KB read from hub-served mirror"

echo "== 2. memory: observe -> consolidate -> contribution reaches hubd /v1/contributions"
[ ! -d "$CONTRIB" ] || [ -z "$(ls $CONTRIB/*.md 2>/dev/null)" ] || fail "contribution lane not empty at start"
c=$(curl -sS -o /tmp/submit.json -w '%{http_code}' "${auth[@]}" -d '{"input":"We decided to cache the session lookups for five minutes because the profile endpoint is the hot path in the load test.","whenBusy":"reject"}' "$HUB/v1/threads/$W%2Fhome/submit"); [ "$c" = 200 ] || fail "submit HTTP $c"
until_ "turn finished" bash -c "curl -fsS -H 'Authorization: Bearer $TOKEN' $HUB/v1/threads/$W%2Fhome | grep -q tracer-pong"
ONFAIL='echo "memory: $(get /v1/wolves/$W/memory | head -c 700)"; echo "observations: $(get /v1/wolves/$W/memory/observations | head -c 500)"'
until_ "observation captured" bash -c "curl -fsS -H 'Authorization: Bearer $TOKEN' -H 'X-Protocol-Version: 1' $HUB/v1/wolves/$W/memory/observations | grep -q tracer-kb-observation"
ONFAIL=
echo "observation in the wolf's pool (tracer-kb-observation)"
r=$(post "/v1/wolves/$W/memory/consolidate"); echo "consolidate: $r"; echo "$r" | grep -q '"topicsCreated":1' || fail "consolidate did not create a topic"
r=$(post "/v1/wolves/$W/memory/promote"); echo "promote: $r"; echo "$r" | grep -q '"jobId"' || fail "promote not started"
until_ "contribution in hubd's contributions store" bash -c "grep -l tracer-kb-contribution $CONTRIB/*.md"
CF=$(grep -l tracer-kb-contribution $CONTRIB/*.md | head -1); echo "hubd store: $CF"; sed -n 1,14p "$CF"
grep -q "^from: $W\|from: $W" "$CF" || fail "contribution not attributed to $W"
N1=$(ls $CONTRIB/*.md | wc -l)
LANE=$WH/ops/inbox/$W; echo "wolf inbox lane after feed: pending=$(ls $LANE/*.md 2>/dev/null | wc -l) sent=$(ls $LANE/sent 2>/dev/null | wc -l)"
[ "$(ls $LANE/sent | wc -l)" -ge 1 ] || fail "nothing moved to sent/"
echo "PASS 2: memory contribution landed in the hub store"

echo "== 3. graduation preview for $FEAT on $W (sends nothing)"
r=$(post "/v1/wolves/$W/work/$FEAT/graduate/preview"); echo "start: $r"; echo "$r" | grep -q '"state":"running"' || fail "preview did not start"
until_ "preview_ready" bash -c "curl -fsS -H 'Authorization: Bearer $TOKEN' -H 'X-Protocol-Version: 1' $HUB/v1/wolves/$W/work/$FEAT/graduate/status | grep -q preview_ready"
S=$(get "/v1/wolves/$W/work/$FEAT/graduate/status"); echo "status: $(echo "$S" | head -c 700)"
echo "$S" | grep -q '"token"' || fail "preview has no confirmation token"
echo "$S" | grep -q 'tracer-kb-contribution' || fail "preview does not carry the distilled contribution"
N2=$(ls $CONTRIB/*.md | wc -l); [ "$N1" = "$N2" ] || fail "hub contribution store changed during preview ($N1 -> $N2)"
[ -z "$(ls $LANE/*.md 2>/dev/null)" ] || fail "preview left a file in the inbox lane"
IT=$(curl -fsS -H "X-API-Key: $(sed -n 's/^WORK_TOKEN=//p' $WH/.env)" $HUB/v1/workapi/work/$FEAT)
echo "$IT" | grep -q '"graduated":true' && fail "item graduated by a preview"; echo "$IT" | grep -q '"stage":"archived"' && fail "item archived by a preview"
echo "work item after preview: not graduated, not archived; hub store still $N2 contribution(s)"
echo "PASS 3: graduation preview ran, nothing sent"
if [ -n "${TRACER_RO_WORK:-}" ]; then
  echo "== 4. ro-work: the store stayed read-only and untouched"
  find $HD/kb/base/domains/*/work -printf '%p %s %T@ %m\n' | sort > /tmp/ro-work.after
  cmp /tmp/ro-work.before /tmp/ro-work.after || fail "domains/*/work changed during the run"
  (cd / && sha256sum -c /tmp/ro-ledger.before) >/dev/null || fail "work ledger changed during the run"
  WKEY=$(sed -n 's/^WORK_TOKEN=//p' $WH/.env)
  c=$(curl -sS -o /tmp/ro-create.json -w '%{http_code}' -H "X-API-Key: $WKEY" -H 'Content-Type: application/json' -d '{"kind":"feature","domain":"tracerkb","title":"must fail","assignee":"hal2"}' $HUB/v1/workapi/work)
  echo "create through the proxy while read-only -> HTTP $c: $(cat /tmp/ro-create.json)"
  [ "$c" = 503 ] || fail "expected 503, got $c"; grep -q 'work store is read-only' /tmp/ro-create.json || fail "no clear read-only error"; grep -q '"code":"work_store_read_only"' /tmp/ro-create.json || fail "error is not typed work_store_read_only"
  (cd / && sha256sum -c /tmp/ro-ledger.before) >/dev/null || fail "the failed create changed the ledger (the pre-flight probe should refuse before appending)"
  [ -n "$(findmnt -no OPTIONS $(ls -d $HD/kb/base/domains/*/work | head -1) | grep -w ro)" ] || fail "work dir is not a read-only mount"
  grep -q 'EROFS' /data/log/hubd.log || fail "hubd log has no EROFS (the failure was not a real EROFS)"
  find $HD/kb/base/domains/*/work -printf '%p %s %T@ %m\n' | sort | cmp - /tmp/ro-work.before || fail "store changed after the failed create"
  echo "PASS 4: preview_ready with a REAL read-only mount (EROFS); no store writes; a write is refused (503 work_store_read_only) before the ledger is touched"
  echo "RO-WORK PROOF OK"
fi
echo "KB PROOF OK"
