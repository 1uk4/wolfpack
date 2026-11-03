#!/usr/bin/env bash
# Runs INSIDE the systemd container (see hub-writes-proof.sh).
set -uo pipefail
ok() { echo "ok: $*"; }; bad() { echo "FAIL: $*"; journalctl -u hubd --no-pager 2>/dev/null | tail -8; exit 1; }
S=/opt/deploy/hubd/setup.sh
DOM=/home/wolf-W1hOrJ/knowledge/base/domains
DROP=/etc/systemd/system/hubd.service.d/work-writes.conf
U=http://127.0.0.1:3150
wait_active() { local i; for i in $(seq 1 ${2:-30}); do systemctl is-active --quiet "$1" && return 0; sleep 1; done; return 1; }
restart() { systemctl daemon-reload && systemctl restart hubd && wait_active hubd 20 && for _ in $(seq 1 20); do curl -s -o /dev/null $U/v1/work && return 0; sleep 1; done; return 1; }
ln -sf /usr/local/bin/node /usr/bin/node
useradd -m wolf-W1hOrJ
install -d -o wolf-W1hOrJ -m 755 /home/wolf-W1hOrJ/knowledge/base/domains /home/wolf-W1hOrJ/librarian
install -d -o wolf-W1hOrJ -m 777 /home/wolf-W1hOrJ/librarian/inbox /home/wolf-W1hOrJ/librarian/receipts
for d in wolfpack personal; do install -d -o wolf-W1hOrJ -m 755 $DOM/$d $DOM/$d/work $DOM/$d/entries; echo keep > $DOM/$d/entries/e1.md; chown wolf-W1hOrJ $DOM/$d/entries/e1.md; done

echo "--- setup WITHOUT --hub-writes"
bash $S setup --bind 127.0.0.1 --port 3150 >/tmp/s1.log 2>&1 || { tail -15 /tmp/s1.log; bad "setup"; }
bash $S install --bundle /srv/bundle >/tmp/i1.log 2>&1 || { tail -8 /tmp/i1.log; bad "install"; }
[ ! -e $DROP ] || bad "drop-in present without the flag"
systemctl start hubd; wait_active hubd 20 || bad "hubd did not start"
for _ in $(seq 1 20); do curl -s -o /dev/null $U/v1/work && break; sleep 1; done
code=$(node /opt/wolfpack-hubd/current/hubd.mjs pair --kind console --data-dir /var/lib/hubd | sed -n 's/^pairing code: //p')
TOK=$(curl -s -X POST $U/v1/pair -H 'Content-Type: application/json' -d "{\"code\":\"$code\",\"kind\":\"console\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')
[ -n "$TOK" ] && [ "$TOK" != undefined ] || bad "could not mint a token"
api() { # api METHOD PATH [json] -> body in $B, status in $C
  local o; o=$(curl -s -w '\n%{http_code}' -X "$1" "$U$2" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' ${3:+-d "$3"}); C=${o##*$'\n'}; B=${o%$'\n'*}; }
mk() { api POST /v1/work "{\"kind\":\"idea\",\"domain\":\"$1\",\"title\":\"$2\",\"assignee\":\"1uk4\"}"; }
mk wolfpack "before flag"
{ [ "$C" = 503 ] || [ "$C" = 502 ]; } && grep -q work_store_read_only <<<"$B" && ok "no flag: POST /v1/work -> $C work_store_read_only" || bad "no-flag write: $C $B"
ls $DOM/wolfpack/work | grep -q . && bad "a file landed without the flag"

echo "--- rerun setup WITH --hub-writes, daemon-reload, restart"
bash $S setup --bind 127.0.0.1 --port 3150 --hub-writes >/tmp/s2.log 2>&1 || { tail -15 /tmp/s2.log; bad "setup --hub-writes"; }
grep -q "re-run" /tmp/s2.log && ok "setup logs that new domains need a rerun" || bad "no rerun hint"
[ -s $DROP ] && ok "drop-in written: $(tr '\n' ' ' <$DROP)" || bad "no drop-in"
restart || bad "restart"
mk wolfpack "after flag"
[ "$C" = 201 ] || [ "$C" = 200 ] || bad "flag write: $C $B"
ID=$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$B")
[ -f $DOM/wolfpack/work/$ID.md ] && ok "flag: POST /v1/work -> $C, $ID.md on disk" || bad "file missing for $ID"
api PATCH /v1/work/$ID '{"note":"patched"}'
[ "$C" = 200 ] && grep -q patched $DOM/wolfpack/work/$ID.md && ok "PATCH -> 200, note in the file" || bad "patch $C $B"
mk personal "second bound domain"; [ "$C" = 201 ] || [ "$C" = 200 ] && ok "second bound domain also writable" || bad "personal $C $B"
PID=$(systemctl show -p MainPID --value hubd)
nsenter -t "$PID" -m -- sh -c "echo x > $DOM/wolfpack/entries/new.md" 2>/dev/null && bad "entries/ writable inside the unit" || ok "entries/ in a bound domain stays read-only inside the unit namespace"
nsenter -t "$PID" -m -- sh -c "echo x > $DOM/wolfpack/top.md" 2>/dev/null && bad "domain root writable inside the unit" || ok "domain root stays read-only inside the unit namespace"
nsenter -t "$PID" -m -- sh -c "mkdir $DOM/newdom" 2>/dev/null && bad "domains/ writable inside the unit" || ok "domains/ stays read-only inside the unit namespace"
nsenter -t "$PID" -m -- sh -c "echo x > $DOM/wolfpack/work/ns-probe && rm $DOM/wolfpack/work/ns-probe" && ok "work/ writable inside the unit namespace" || bad "work/ not writable inside the namespace"
[ -w /home/wolf-W1hOrJ/librarian/inbox ] && nsenter -t "$PID" -m -- sh -c "touch /home/wolf-W1hOrJ/librarian/inbox/.p && rm /home/wolf-W1hOrJ/librarian/inbox/.p" && ok "inbox binds survived the drop-in (still writable)" || bad "inbox not writable"

echo "--- a domain added after the flag is NOT bound"
install -d -o wolf-W1hOrJ -m 755 $DOM/late $DOM/late/work
mk late "unbound"
grep -q work_store_read_only <<<"$B" && ok "new domain 'late' (not in the drop-in): write refused ($C work_store_read_only)" || bad "late write: $C $B"
bash $S setup --bind 127.0.0.1 --port 3150 --hub-writes >/tmp/s3.log 2>&1 || bad "rerun setup"
restart || bad "restart 2"
mk late "bound now"; { [ "$C" = 201 ] || [ "$C" = 200 ]; } && ok "after rerunning setup --hub-writes + restart, 'late' is writable" || bad "late after rerun: $C $B"

echo "--- rerun setup WITHOUT the flag removes the drop-in (rollback)"
bash $S setup --bind 127.0.0.1 --port 3150 >/tmp/s4.log 2>&1 || bad "rerun setup no flag"
[ ! -e $DROP ] && grep -q "removing" /tmp/s4.log && ok "setup without the flag deleted $DROP and said so" || bad "drop-in still there"
restart || bad "restart 3"
mk wolfpack "after rollback"
grep -q work_store_read_only <<<"$B" && ok "after rollback: writes refused again ($C work_store_read_only); earlier items still readable: $(api GET /v1/work/$ID >/dev/null; echo $C)" || bad "rollback write: $C $B"
echo "HUB WRITES PROOF OK"
