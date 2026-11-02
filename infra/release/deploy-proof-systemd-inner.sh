#!/usr/bin/env bash
# Runs INSIDE the systemd container (see deploy-proof-systemd.sh). Real systemd, real deploy/{hubd,workerd}/setup.sh from real bundles.
set -uo pipefail
ok() { echo "ok: $*"; }; bad() { echo "FAIL: $*"; exit 1; }
export DEPLOY_TEST=1 DEPLOY_BASE_URL=http://127.0.0.1:8099 DEPLOY_LOG=/var/log/deploy-test.log
D=/opt/release/deploy-release.sh
run() { out=$(bash -s -- "$@" < $D 2>&1); rc=$?; echo "$out" | sed 's/^/    /' | tail -${TAILN:-6}; return $rc; }
ver() { head -n1 "$1/current/VERSION" | cut -d+ -f1; }
# ---- the release server, real URL layout
for f in /srv/rel/*.tar.gz; do b=$(basename "$f"); c=${b%%-v*}; v=${b#*-v}; v=${v%%-linux*}; mkdir -p /srv/www/$c/v$v; cp "$f" "$f.sha256" /srv/www/$c/v$v/; done
( cd /srv/www && node -e 'const h=require("http"),fs=require("fs");h.createServer((q,r)=>{try{r.end(fs.readFileSync("/srv/www"+q.url))}catch{r.statusCode=404;r.end()}}).listen(8099,"127.0.0.1")' >/dev/null 2>&1 </dev/null & ); sleep 1
ex() { mkdir -p /tmp/x-$1-$2 && tar --warning=no-unknown-keyword -xzf /srv/www/$1/v$2/$1-v$2-linux-x64.tar.gz -C /tmp/x-$1-$2; }
# ---- host prerequisites like sfo-01: Dewey's user/dirs, Hal's unit
ln -sf /usr/local/bin/node /usr/bin/node   # sfo-01 has node in /usr/bin (workerd-wolves.service ExecStart)
useradd -m wolf-W1hOrJ; useradd -m wolf-ETAy7b
install -d -o wolf-W1hOrJ -m 755 /home/wolf-W1hOrJ/knowledge/base/domains /home/wolf-W1hOrJ/librarian
install -d -o wolf-W1hOrJ -m 777 /home/wolf-W1hOrJ/librarian/inbox /home/wolf-W1hOrJ/librarian/receipts
printf '[Service]\nExecStart=/bin/sleep infinity\n' > /etc/systemd/system/wolf-ETAy7b.service; systemctl daemon-reload

echo "--- refuses when nothing is installed (first install is setup.sh setup)"
run hubd 0.9.2; rc=$?; [ $rc = 1 ] && grep -q "no existing hubd install" <<<"$out" && grep -q "setup" <<<"$out" && [ ! -e /opt/wolfpack-hubd/current ] && ok "hubd: no install -> refused (rc 1), nothing created" || bad "hubd refuse rc=$rc"
run workerd 0.9.2; rc=$?; [ $rc = 1 ] && grep -q "no existing workerd install" <<<"$out" && ok "workerd: no install -> refused (rc 1)" || bad "workerd refuse rc=$rc"

echo "--- hubd: real setup.sh setup + install 0.9.1, started by real systemd"
ex hubd 0.9.1; bash /opt/deploy/hubd/setup.sh setup --bind 127.0.0.1 --port 3150 >/tmp/hs.log 2>&1 || { tail -15 /tmp/hs.log; bad "hubd setup"; }
bash /opt/deploy/hubd/setup.sh install --bundle /tmp/x-hubd-0.9.1/hubd >/tmp/hi.log 2>&1 || { tail; bad "hubd install A"; }
systemctl start hubd; sleep 3; systemctl is-active --quiet hubd || { journalctl -u hubd --no-pager | tail -8; bad "hubd did not start"; }
[ "$(ver /opt/wolfpack-hubd)" = 0.9.1 ] && ok "hubd 0.9.1 (A) running under real systemd on $(ss -ltnH | awk '/:3150 /{print $4}')"
run hubd 0.9.2 --settle 3; rc=$?
[ $rc = 0 ] && [ "$(ver /opt/wolfpack-hubd)" = 0.9.2 ] && systemctl is-active --quiet hubd && [ "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3150/v1/wolves)" = 401 ] && ok "hubd A->B healthy (rc 0), port + HTTP 401 probe, setup.sh saved: $(ls /opt/wolfpack-hubd/setup.sh)" || bad "hubd A->B rc=$rc"
iid=$(systemctl show -p InvocationID --value hubd)
run hubd 0.9.3 --settle 3 --health-timeout 20; rc=$?
[ $rc = 3 ] && [ "$(ver /opt/wolfpack-hubd)" = 0.9.2 ] && systemctl is-active --quiet hubd && [ "$(systemctl show -p InvocationID --value hubd)" != "$iid" ] && ok "hubd C (crashes as a service) -> rolled back to 0.9.2 (rc 3), service running again" || { journalctl -u hubd --no-pager | tail -5; bad "hubd rollback rc=$rc"; }
cp /srv/www/hubd/v0.9.2/hubd-v0.9.2-linux-x64.tar.gz /tmp/keep.tgz
mkdir -p /srv/www/hubd/v0.9.4; python3 -V >/dev/null 2>&1
t=$(mktemp -d); tar --warning=no-unknown-keyword -xzf /tmp/keep.tgz -C $t; echo "0.9.4+x" > $t/hubd/VERSION; : > $t/hubd/hubd.mjs   # empty entrypoint: smoke test fails, install dies BEFORE the flip
tar -czf /srv/www/hubd/v0.9.4/hubd-v0.9.4-linux-x64.tar.gz -C $t hubd; ( cd /srv/www/hubd/v0.9.4 && sha256sum hubd-v0.9.4-linux-x64.tar.gz > hubd-v0.9.4-linux-x64.tar.gz.sha256 )
iid=$(systemctl show -p InvocationID --value hubd)
run hubd 0.9.4 --settle 3; rc=$?
[ $rc = 1 ] && [ "$(ver /opt/wolfpack-hubd)" = 0.9.2 ] && [ "$(systemctl show -p InvocationID --value hubd)" = "$iid" ] && ! grep -q "FAILED; rolling back\|rollback via" <<<"$out" && ok "hubd install fails before the flip (real smoke test) -> rc 1, 0.9.2 untouched and not restarted, NO rollback" || bad "hubd noflip rc=$rc ver=$(ver /opt/wolfpack-hubd) iid=$iid now=$(systemctl show -p InvocationID --value hubd)"

echo "--- workerd: two units (link-only workerd + workerd-wolves)"
ex workerd 0.9.1; bash /opt/deploy/workerd/setup.sh setup --port 7142 >/tmp/ws.log 2>&1 || { tail -15 /tmp/ws.log; bad "workerd setup"; }
bash /opt/deploy/workerd/setup.sh install --bundle /tmp/x-workerd-0.9.1/workerd >/dev/null 2>&1 || bad "workerd install A"
echo '{"hubUrl":"http://127.0.0.1:1","token":"t","hostId":"proof"}' > /var/lib/workerd/hub.json; chown workerd:workerd /var/lib/workerd/hub.json; chmod 600 /var/lib/workerd/hub.json
# workerd-wolves as the repo ships it (infra/wolves): own user, state, env, install dir with workerd.mjs + wolfd-unit.sh
useradd --system --home-dir /var/lib/workerd-wolves --shell /usr/sbin/nologin workerd-wolves
install -d -o workerd-wolves -m 700 /var/lib/workerd-wolves; install -d /etc/wolfpack/wolves /opt/wolfpack-workerd-wolves/releases/seed
printf 'WORKERD_PORT=7143\nWORKERD_FEED=0\n' > /etc/wolfpack/workerd-wolves.env; chmod 600 /etc/wolfpack/workerd-wolves.env
cp /tmp/x-workerd-0.9.1/workerd/{workerd.mjs,VERSION,RUNBOOK.md} /opt/wolfpack-workerd-wolves/releases/seed/; install -m 755 /opt/wolves-src/wolfd-unit.sh /opt/wolfpack-workerd-wolves/releases/seed/
ln -sfn /opt/wolfpack-workerd-wolves/releases/seed /opt/wolfpack-workerd-wolves/current
echo '{"hubUrl":"http://127.0.0.1:1","token":"t","hostId":"proof-wolves"}' > /var/lib/workerd-wolves/hub.json; chown workerd-wolves /var/lib/workerd-wolves/hub.json; chmod 600 /var/lib/workerd-wolves/hub.json
cp /opt/wolves-src/workerd-wolves.service /etc/systemd/system/; systemctl daemon-reload
systemctl start workerd workerd-wolves; sleep 4
for u in workerd workerd-wolves; do systemctl is-active --quiet $u || { journalctl -u $u --no-pager | tail -8; bad "$u did not start"; }; done
ok "both units running under real systemd (workerd :7142, workerd-wolves :7143), both on 0.9.1"
wv() { head -n1 /opt/wolfpack-workerd-wolves/current/VERSION | cut -d+ -f1; }
iw=$(systemctl show -p InvocationID --value workerd); iv=$(systemctl show -p InvocationID --value workerd-wolves)
run workerd 0.9.2 --settle 3; rc=$?
[ $rc = 0 ] && [ "$(ver /opt/wolfpack-workerd)" = 0.9.2 ] && [ "$(wv)" = 0.9.2 ] && [ -x /opt/wolfpack-workerd-wolves/current/wolfd-unit.sh ] \
  && [ "$(systemctl show -p InvocationID --value workerd)" != "$iw" ] && [ "$(systemctl show -p InvocationID --value workerd-wolves)" != "$iv" ] && systemctl is-active --quiet workerd && systemctl is-active --quiet workerd-wolves \
  && ok "workerd A->B: BOTH units moved to 0.9.2 and restarted, wolfd-unit.sh carried over (rc 0)" || bad "workerd A->B rc=$rc"
iw=$(systemctl show -p InvocationID --value workerd); iv=$(systemctl show -p InvocationID --value workerd-wolves)
run workerd 0.9.3 --settle 3 --health-timeout 20; rc=$?
[ $rc = 3 ] && [ "$(ver /opt/wolfpack-workerd)" = 0.9.2 ] && [ "$(wv)" = 0.9.2 ] && systemctl is-active --quiet workerd && systemctl is-active --quiet workerd-wolves \
  && ok "workerd C (crashes) -> BOTH units rolled back to 0.9.2 (rc 3), both running" || { journalctl -u workerd --no-pager | tail -4; bad "workerd rollback rc=$rc"; }
# only the wolves unit cannot start (its env names a port its ExecStartPre refuses): the link-only workerd is fine, yet BOTH must roll back
echo "--- one unit healthy, the other not -> both roll back"
sv=$(ver /opt/wolfpack-workerd)
printf 'WORKERD_PORT=3150\nWORKERD_FEED=0\n' > /etc/wolfpack/workerd-wolves.env
TAILN=9 run workerd 0.9.2 --settle 3 --health-timeout 10 --unit both; rc=$?
[ $rc = 4 ] && [ "$(ver /opt/wolfpack-workerd)" = "$sv" ] && [ "$(wv)" = "$sv" ] && systemctl is-active --quiet workerd && grep -q "FAILED; rolling back workerd.service workerd-wolves.service" <<<"$out" \
  && ok "workerd-wolves cannot start, link-only workerd fine -> BOTH rolled back to $sv; rc 4 because the wolves env is still bad (flagged for a human), workerd running" || bad "split failure rc=$rc"
printf 'WORKERD_PORT=7143\nWORKERD_FEED=0\n' > /etc/wolfpack/workerd-wolves.env
systemctl reset-failed workerd-wolves; systemctl restart workerd-wolves; sleep 2; systemctl is-active --quiet workerd-wolves && ok "after fixing the env, workerd-wolves starts on the rolled-back release"
echo "--- --unit link touches only the link-only workerd"
iv=$(systemctl show -p InvocationID --value workerd-wolves); wv0=$(wv)
run workerd 0.9.2 --settle 3 --unit link; rc=$?
[ $rc = 0 ] && [ "$(ver /opt/wolfpack-workerd)" = 0.9.2 ] && [ "$(wv)" = "$wv0" ] && [ "$(systemctl show -p InvocationID --value workerd-wolves)" = "$iv" ] && ok "--unit link: workerd -> 0.9.2, workerd-wolves untouched (same release, same process)" || bad "unit link rc=$rc"
echo "SYSTEMD DEPLOY PROOF OK"
