#!/usr/bin/env bash
# Scripted relay client: through hubd's console relay, open the home thread of wolf <name> (the routing key is the NAME),
# post a message and assert the reply round-trips. Exit 0 = pass, non-zero = fail (reason on stderr).
# usage: relay-client.sh <hub-url> <console-token> <wolf-name> [message]
set -euo pipefail
HUB="$1"; TOKEN="$2"; WOLF="$3"; MSG="${4:-ping}"
EXPECT="${TRACER_REPLY:-tracer-pong}"
THREAD="$WOLF%2Fhome"   # thread ids are "<wolf name>/home", URL-encoded
auth=(-H "Authorization: Bearer $TOKEN")
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== relay: GET /v1/wolves (hub list; $WOLF must be online)"
for i in $(seq 1 30); do
  list=$(curl -fsS "${auth[@]}" "$HUB/v1/wolves" || true)
  echo "$list" | grep -q "\"$WOLF\"" && break; sleep 1
done
echo "$list"
echo "== relay: GET /v1/wolves/$WOLF/threads"
curl -fsS "${auth[@]}" "$HUB/v1/wolves/$WOLF/threads" | head -c 400; echo

out=$(mktemp); trap 'rm -f "$out"' EXIT
echo "== relay: POST submit '$MSG' to /v1/threads/$THREAD/submit"
code=$(curl -sS -o /tmp/submit.json -w '%{http_code}' "${auth[@]}" -H 'Content-Type: application/json' -d "{\"input\":\"$MSG\",\"whenBusy\":\"reject\"}" "$HUB/v1/threads/$THREAD/submit")
echo "submit -> HTTP $code $(cat /tmp/submit.json)"
[ "$code" = 200 ] || fail "submit returned HTTP $code"
touch /tmp/tracer-turn-started   # signal to the entrypoint: sample in-turn RSS now
echo "== relay: stream /v1/threads/$THREAD/stream until the turn ends (the stream replays the turn and finishes with [DONE])"
curl -sN --max-time 30 "${auth[@]}" "$HUB/v1/threads/$THREAD/stream" >"$out" || true
grep -q '"type":"turn-end"' "$out" || { cat "$out" >&2; fail "no turn-end event on the stream"; }
echo "== stream events (types): $(grep -o '"type":"[a-z-]*"' "$out" | sort | uniq -c | tr -s ' ' | tr '\n' ' ')"
grep -q "$EXPECT" "$out" || { cat "$out" >&2; fail "reply text '$EXPECT' not in stream"; }
echo "== reply text seen in stream: '$EXPECT'"
echo "== relay: GET /v1/threads/$THREAD (persisted)"
curl -fsS "${auth[@]}" "$HUB/v1/threads/$THREAD" | grep -q "$EXPECT" || fail "reply not persisted in thread detail"
echo "PASS: round-trip $WOLF via hubd relay"
