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
useradd -m wolf-W1hOrJ; useradd -m wolf-hal2   # wolf-hal2: a stand-in for another wolf's Linux user (NOT a member of any work group)
install -d -o wolf-W1hOrJ -m 755 /home/wolf-W1hOrJ/knowledge/base/domains /home/wolf-W1hOrJ/librarian
install -d -o wolf-W1hOrJ -m 777 /home/wolf-W1hOrJ/librarian/inbox /home/wolf-W1hOrJ/librarian/receipts
for d in wolfpack personal; do install -d -o wolf-W1hOrJ -m 755 $DOM/$d $DOM/$d/entries; install -d -o root -g root -m 755 $DOM/$d/work; echo keep > $DOM/$d/entries/e1.md; chown wolf-W1hOrJ $DOM/$d/entries/e1.md; done

echo "--- setup WITHOUT --hub-writes (work/ starts root:root 755, as on sfo-01; setfacl is $(command -v setfacl || echo absent, like stock Debian))"
command -v setfacl >/dev/null && bad "this proof must exercise the no-ACL (group) path, but setfacl exists"
bash $S setup --bind 127.0.0.1 --port 3150 >/tmp/s1.log 2>&1 || { tail -15 /tmp/s1.log; bad "setup"; }
bash $S install --bundle /srv/bundle >/tmp/i1.log 2>&1 || { tail -8 /tmp/i1.log; bad "install"; }
[ ! -e $DROP ] || bad "drop-in present without the flag"
systemctl start hubd; wait_active hubd 20 || bad "hubd did not start"
for _ in $(seq 1 20); do curl -s -o /dev/null $U/v1/work && break; sleep 1; done
code=$(runuser -u hubd -- /usr/bin/node /opt/wolfpack-hubd/current/hubd.mjs pair --kind console --data-dir /var/lib/hubd 2>&1 | tee /tmp/pair.log | sed -n 's/^pairing code: //p')
TOK=$(curl -s -X POST $U/v1/pair -H 'Content-Type: application/json' -d "{\"code\":\"$code\",\"kind\":\"console\",\"label\":\"proof\"}" | tee /tmp/pair.out | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')
[ -n "$TOK" ] && [ "$TOK" != undefined ] || { cat /tmp/pair.log /tmp/pair.out; bad "could not mint a token"; }
api() { # api METHOD PATH [json] -> body in $B, status in $C
  local o; o=$(curl -s -w '\n%{http_code}' -X "$1" "$U$2" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' ${3:+-d "$3"}); C=${o##*$'\n'}; B=${o%$'\n'*}; }
mk() { api POST /v1/work "{\"kind\":\"idea\",\"domain\":\"$1\",\"title\":\"$2\",\"assignee\":\"1uk4\"}"; }
mk wolfpack "before flag"
{ [ "$C" = 503 ] || [ "$C" = 502 ]; } && grep -q work_store_read_only <<<"$B" && ok "no flag: POST /v1/work -> $C work_store_read_only" || bad "no-flag write: $C $B"
ls $DOM/wolfpack/work | grep -q . && bad "a file landed without the flag"

echo "--- rerun setup WITH --hub-writes, daemon-reload, restart"
bash $S setup --bind 127.0.0.1 --port 3150 --hub-writes --work-user wolf-W1hOrJ >/tmp/s2.log 2>&1 || { tail -15 /tmp/s2.log; bad "setup --hub-writes"; }
grep -q "re-run" /tmp/s2.log && ok "setup logs that new domains need a rerun" || bad "no rerun hint"
[ -s $DROP ] && ok "drop-in written: $(tr '\n' ' ' <$DROP)" || bad "no drop-in"
grep -q "falling back\|setfacl not installed" /tmp/s2.log && ok "setup chose the group method (no setfacl)" || bad "no group method message"
for d in wolfpack personal; do [ "$(stat -c '%G %a' $DOM/$d/work)" = "wolfpack-work 2775" ] || bad "$d/work is $(stat -c '%G %a' $DOM/$d/work), want wolfpack-work 2775"; done
ok "work dirs are group wolfpack-work, mode 2775 (not 777); members: $(getent group wolfpack-work | cut -d: -f4)"
id -nG hubd | grep -qw wolfpack-work || bad "hubd not in the group"
restart || bad "restart"
mk wolfpack "after flag"
[ "$C" = 201 ] || [ "$C" = 200 ] || bad "flag write: $C $B"
ID=$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$B")
[ -f $DOM/wolfpack/work/$ID.md ] && ok "flag: POST /v1/work -> $C, $ID.md on disk" || bad "file missing for $ID"
api PATCH /v1/work/$ID '{"note":"patched"}'
[ "$C" = 200 ] && grep -q patched $DOM/wolfpack/work/$ID.md && ok "PATCH -> 200, note in the file" || bad "patch $C $B"
chown wolf-W1hOrJ:wolf-W1hOrJ $DOM/wolfpack/work/$ID.md; chmod 644 $DOM/wolfpack/work/$ID.md   # as if Dewey had written it
api PATCH /v1/work/$ID '{"note":"patched dewey-owned"}'
[ "$C" = 200 ] && grep -q "patched dewey-owned" $DOM/wolfpack/work/$ID.md && ok "PATCH of a Dewey-owned 644 item -> 200" || bad "patch dewey-owned $C $B"
# a file Dewey creates AFTER setup (new file, owned by Dewey, group inherited via setgid, 644): hubd must still PATCH it
runuser -u wolf-W1hOrJ -- sh -c "cp $DOM/wolfpack/work/$ID.md $DOM/wolfpack/work/$ID.new && mv $DOM/wolfpack/work/$ID.new $DOM/wolfpack/work/$ID.md" || bad "Dewey could not write work/ (not in the group?)"
[ "$(stat -c '%U %G %a' $DOM/wolfpack/work/$ID.md)" = "wolf-W1hOrJ wolfpack-work 644" ] || bad "Dewey's new file is $(stat -c '%U %G %a' $DOM/wolfpack/work/$ID.md)"
api PATCH /v1/work/$ID '{"note":"patched after dewey recreated it"}'
[ "$C" = 200 ] && grep -q "after dewey recreated" $DOM/wolfpack/work/$ID.md && ok "file created by Dewey after setup (wolf-W1hOrJ:wolfpack-work 644, setgid-inherited group) -> hubd PATCH 200" || bad "patch dewey-new $C $B"
[ "$(stat -c '%U' $DOM/wolfpack/work/$ID.md)" = hubd ] && ok "hubd rewrote it by temp file + rename (the file is now owned by hubd; an in-place write would have kept wolf-W1hOrJ)" || bad "owner unchanged: in-place write?"
runuser -u wolf-hal2 -- sh -c "echo x > $DOM/wolfpack/work/hal2-forged.md" 2>/dev/null && bad "non-member wolf-hal2 could create a file in work/" || ok "non-member wolf-hal2 cannot create a file in work/"
runuser -u wolf-hal2 -- sh -c "echo x >> $DOM/wolfpack/work/$ID.md" 2>/dev/null && bad "non-member wolf-hal2 could modify an item" || ok "non-member wolf-hal2 cannot modify an item"
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
bash $S setup --bind 127.0.0.1 --port 3150 --hub-writes --work-user wolf-W1hOrJ >/tmp/s3.log 2>&1 || bad "rerun setup"
restart || bad "restart 2"
mk late "bound now"; { [ "$C" = 201 ] || [ "$C" = 200 ]; } && ok "after rerunning setup --hub-writes + restart, 'late' is writable" || bad "late after rerun: $C $B"

echo "--- rerun setup WITHOUT the flag removes the drop-in (rollback)"
bash $S setup --bind 127.0.0.1 --port 3150 >/tmp/s4.log 2>&1 || bad "rerun setup no flag"
[ ! -e $DROP ] && grep -q "removing" /tmp/s4.log && ok "setup without the flag deleted $DROP and said so" || bad "drop-in still there"
restart || bad "restart 3"
mk wolfpack "after rollback"
grep -q work_store_read_only <<<"$B" && ok "after rollback: writes refused again ($C work_store_read_only)" || bad "rollback write: $C $B"
api GET /v1/work/$ID/record; [ "$C" = 200 ] && grep -q "\"$ID\"" <<<"$B" && ok "after rollback: GET /v1/work/$ID/record -> 200 (reads still work)" || bad "rollback read: $C $B"
echo "HUB WRITES PROOF OK"
