#!/usr/bin/env bash
# Runs INSIDE the systemd container (see deploy-proof-systemd.sh). Real systemd, real deploy/{hubd,workerd}/setup.sh from real bundles.
set -uo pipefail
ok() { echo "ok: $*"; }; bad() { echo "FAIL: $*"; exit 1; }
export DEPLOY_TEST=1 DEPLOY_BASE_URL=http://127.0.0.1:8099 DEPLOY_LOG=/var/log/deploy-test.log
D=/opt/release/deploy-release.sh
wait_active() { local i; for i in $(seq 1 ${2:-30}); do systemctl is-active --quiet "$1" && return 0; sleep 1; done; return 1; }
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
bash /opt/deploy/hubd/setup.sh install --bundle /tmp/x-hubd-0.9.1/hubd >/tmp/hi.log 2>&1 || { tail -8 /tmp/hi.log; bad "hubd install A"; }
systemctl start hubd; wait_active hubd 20 || { journalctl -u hubd --no-pager | tail -8; bad "hubd did not start"; }
[ "$(ver /opt/wolfpack-hubd)" = 0.9.1 ] && ok "hubd 0.9.1 (A) running under real systemd on $(ss -ltnH | awk '/:3150 /{print $4}')"
run hubd 0.9.2 --settle 3; rc=$?
[ $rc = 0 ] && [ "$(ver /opt/wolfpack-hubd)" = 0.9.2 ] && systemctl is-active --quiet hubd && [ "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3150/v1/wolves)" = 401 ] && ok "hubd A->B healthy (rc 0), port + HTTP 401 probe, setup.sh saved: $(ls /opt/wolfpack-hubd/setup.sh)" || bad "hubd A->B rc=$rc"
iid=$(systemctl show -p InvocationID --value hubd)
run hubd 0.9.3 --settle 3 --health-timeout 20; rc=$?
[ $rc = 3 ] && [ "$(ver /opt/wolfpack-hubd)" = 0.9.2 ] && systemctl is-active --quiet hubd && [ "$(systemctl show -p InvocationID --value hubd)" != "$iid" ] && ok "hubd C (crashes as a service) -> rolled back to 0.9.2 (rc 3), service running again" || { journalctl -u hubd --no-pager | tail -5; bad "hubd rollback rc=$rc"; }
cp /srv/www/hubd/v0.9.2/hubd-v0.9.2-linux-x64.tar.gz /tmp/keep.tgz
mkdir -p /srv/www/hubd/v0.9.4
t=$(mktemp -d); tar --warning=no-unknown-keyword -xzf /tmp/keep.tgz -C $t; echo "0.9.4+x" > $t/hubd/VERSION; : > $t/hubd/hubd.mjs   # empty entrypoint: smoke test fails, install dies BEFORE the flip
tar -czf /srv/www/hubd/v0.9.4/hubd-v0.9.4-linux-x64.tar.gz -C $t hubd; ( cd /srv/www/hubd/v0.9.4 && sha256sum hubd-v0.9.4-linux-x64.tar.gz > hubd-v0.9.4-linux-x64.tar.gz.sha256 )
iid=$(systemctl show -p InvocationID --value hubd)
run hubd 0.9.4 --settle 3; rc=$?
[ $rc = 1 ] && [ "$(ver /opt/wolfpack-hubd)" = 0.9.2 ] && [ "$(systemctl show -p InvocationID --value hubd)" = "$iid" ] && ! grep -q "FAILED; rolling back\|rollback via" <<<"$out" && ok "hubd install fails before the flip (real smoke test) -> rc 1, 0.9.2 untouched and not restarted, NO rollback" || bad "hubd noflip rc=$rc ver=$(ver /opt/wolfpack-hubd) iid=$iid now=$(systemctl show -p InvocationID --value hubd)"

echo "--- --unit is rejected for hubd (workerd only)"
run hubd 0.9.2 --unit link; rc=$?; [ $rc = 2 ] && ok "hubd --unit link -> rc 2" || bad "hubd --unit rc=$rc"

echo "--- workerd: two units (link-only workerd + workerd-wolves) and supervised-wolf stand-ins"
clone() { # <comp> <from> <new> [hook run inside the unpacked <comp> dir]: a new release from an existing tarball
  local c=$1 f=$2 n=$3 hook=${4:-:} t; t=$(mktemp -d)
  tar --warning=no-unknown-keyword -xzf /srv/www/$c/v$f/$c-v$f-linux-x64.tar.gz -C $t; echo "$n+x" > $t/$c/VERSION; ( cd $t/$c && eval "$hook" )
  mkdir -p /srv/www/$c/v$n; tar -czf /srv/www/$c/v$n/$c-v$n-linux-x64.tar.gz -C $t $c; ( cd /srv/www/$c/v$n && sha256sum $c-v$n-linux-x64.tar.gz > $c-v$n-linux-x64.tar.gz.sha256 ); rm -rf $t
}
iidof() { systemctl show -p InvocationID --value "$1"; }
ex workerd 0.9.1; bash /opt/deploy/workerd/setup.sh setup --port 7142 >/tmp/ws.log 2>&1 || { tail -15 /tmp/ws.log; bad "workerd setup"; }
bash /opt/deploy/workerd/setup.sh install --bundle /tmp/x-workerd-0.9.1/workerd >/tmp/wi.log 2>&1 || { tail -5 /tmp/wi.log; bad "workerd install A"; }
echo '{"hubUrl":"http://127.0.0.1:1","token":"t","hostId":"proof"}' > /var/lib/workerd/hub.json; chown workerd:workerd /var/lib/workerd/hub.json; chmod 600 /var/lib/workerd/hub.json
# workerd-wolves as the repo ships it (infra/wolves): own user, state, env, install dir (workerd.mjs + wolfd-unit.sh), a root-owned `current` symlink like sfo-01
useradd --system --home-dir /var/lib/workerd-wolves --shell /usr/sbin/nologin workerd-wolves
install -d -o workerd-wolves -m 700 /var/lib/workerd-wolves; install -d /etc/wolfpack/wolves /opt/wolfpack-workerd-wolves/releases/seed
printf 'WORKERD_PORT=7143\nWORKERD_FEED=0\n' > /etc/wolfpack/workerd-wolves.env; chmod 600 /etc/wolfpack/workerd-wolves.env
WO=/opt/wolfpack-workerd-wolves
cp /tmp/x-workerd-0.9.1/workerd/{workerd.mjs,VERSION,RUNBOOK.md} $WO/releases/seed/; install -m 755 /opt/wolves-src/wolfd-unit.sh $WO/releases/seed/
ln -sfn $WO/releases/seed $WO/current
echo '{"hubUrl":"http://127.0.0.1:1","token":"t","hostId":"proof-wolves"}' > /var/lib/workerd-wolves/hub.json; chown workerd-wolves /var/lib/workerd-wolves/hub.json; chmod 600 /var/lib/workerd-wolves/hub.json
cp /opt/wolves-src/workerd-wolves.service /etc/systemd/system/
# stand-ins for what workerd-wolves supervises on sfo-01: wolfd@hal2 and the old wolves' own system units (their own cgroups, NOT inside workerd-wolves)
printf '[Service]\nExecStart=/bin/sleep infinity\n' > /etc/systemd/system/wolfd@.service
printf '[Service]\nExecStart=/bin/sleep infinity\n' > /etc/systemd/system/wolf-W1hOrJ.service
systemctl daemon-reload
systemctl start workerd workerd-wolves wolfd@hal2 wolf-ETAy7b wolf-W1hOrJ
for u in workerd workerd-wolves wolfd@hal2 wolf-ETAy7b wolf-W1hOrJ; do wait_active $u 20 || { journalctl -u $u --no-pager | tail -8; bad "$u did not start"; }; done
sset() { for u in wolfd@hal2 wolf-ETAy7b wolf-W1hOrJ; do echo "$u $(iidof $u.service) $(systemctl show -p MainPID --value $u.service)"; done; }
SS=$(sset); same() { [ "$(sset)" = "$SS" ]; }
wv() { head -n1 $WO/current/VERSION | cut -d+ -f1; }
act() { systemctl is-active --quiet "$1"; }
ok "workerd :7142 and workerd-wolves :7143 running under real systemd on 0.9.1; stand-ins wolfd@hal2, wolf-ETAy7b, wolf-W1hOrJ running"

echo "--- default (--unit omitted = link): workerd-wolves is NOT touched"
iv=$(iidof workerd-wolves); iw=$(iidof workerd)
run workerd 0.9.2 --settle 3; rc=$?
[ $rc = 0 ] && [ "$(ver /opt/wolfpack-workerd)" = 0.9.2 ] && [ "$(wv)" = 0.9.1 ] && [ "$(iidof workerd-wolves)" = "$iv" ] && [ "$(iidof workerd)" != "$iw" ] && grep -q "unit set: workerd.service (--unit link, default)" <<<"$out" && same \
  && ok "no --unit: only workerd moved to 0.9.2; workerd-wolves same release and same process; stand-ins unchanged; log names the unit set" || bad "default unit rc=$rc"

echo "--- --unit both A->B"
clone workerd 0.9.2 0.9.5
iv=$(iidof workerd-wolves); iw=$(iidof workerd)
run workerd 0.9.5 --settle 3 --unit both; rc=$?
[ $rc = 0 ] && [ "$(ver /opt/wolfpack-workerd)" = 0.9.5 ] && [ "$(wv)" = 0.9.5 ] && [ -x $WO/current/wolfd-unit.sh ] && [ "$(iidof workerd-wolves)" != "$iv" ] && [ "$(iidof workerd)" != "$iw" ] && act workerd && act workerd-wolves && same \
  && ok "--unit both A->B (rc 0): both units on 0.9.5 and restarted, wolfd-unit.sh carried over, wolfd@hal2 / wolf-ETAy7b / wolf-W1hOrJ keep InvocationID+MainPID" || bad "both A->B rc=$rc"

echo "--- --unit both, release crashes on the link unit -> only the link unit changed, only it is rolled back"
iv=$(iidof workerd-wolves)
run workerd 0.9.3 --settle 3 --health-timeout 20 --unit both; rc=$?
[ $rc = 3 ] && [ "$(ver /opt/wolfpack-workerd)" = 0.9.5 ] && [ "$(wv)" = 0.9.5 ] && [ "$(iidof workerd-wolves)" = "$iv" ] && act workerd && act workerd-wolves && same \
  && ok "link unit crashed (rc 3): rolled back to 0.9.5, workerd-wolves never installed or restarted, stand-ins unchanged" || bad "link crash rc=$rc"

echo "--- --unit both, link fine but the wolves unit crashes -> BOTH roll back"
clone workerd 0.9.5 0.9.7 'node -e "const fs=require(\"fs\");let s=fs.readFileSync(\"workerd.mjs\",\"utf8\");const m=s.startsWith(\"#!\")?s.indexOf(\"\\n\")+1:0;s=s.slice(0,m)+\"if (process.argv.includes(\\\"--wolves\\\")) { console.error(\\\"boom: wolves variant\\\"); process.exit(1); }\\n\"+s.slice(m);fs.writeFileSync(\"workerd.mjs\",s)"'
run workerd 0.9.7 --settle 3 --health-timeout 20 --unit both; rc=$?
[ $rc = 3 ] && [ "$(ver /opt/wolfpack-workerd)" = 0.9.5 ] && [ "$(wv)" = 0.9.5 ] && act workerd && act workerd-wolves && same && grep -q "rollback workerd-wolves.service" <<<"$out" \
  && ok "wolves unit crashed while the link unit was healthy (rc 3): both rolled back to 0.9.5, both running, stand-ins unchanged" || { journalctl -u workerd-wolves --no-pager | tail -4; bad "wolves crash rc=$rc"; }

echo "--- --unit wolves alone"
clone workerd 0.9.5 0.9.8
iw=$(iidof workerd); iv=$(iidof workerd-wolves)
run workerd 0.9.8 --settle 3 --unit wolves; rc=$?
[ $rc = 0 ] && [ "$(wv)" = 0.9.8 ] && [ "$(ver /opt/wolfpack-workerd)" = 0.9.5 ] && [ "$(iidof workerd)" = "$iw" ] && [ "$(iidof workerd-wolves)" != "$iv" ] && act workerd-wolves && same \
  && ok "--unit wolves: workerd-wolves -> 0.9.8; link-only workerd untouched (same release, same process); stand-ins unchanged" || bad "wolves alone rc=$rc"

echo "--- live release without wolfd-unit.sh"
LIVE=$(readlink -f $WO/current); mv $LIVE/wolfd-unit.sh /tmp/wolfd-unit.sh.bak; n=$(ls $WO/releases | wc -l); iv=$(iidof workerd-wolves); cv=$(wv)
run workerd 0.9.8 --settle 3 --unit wolves; rc=$?
[ $rc = 1 ] && [ "$(wv)" = "$cv" ] && [ "$(ls $WO/releases | wc -l)" = "$n" ] && [ "$(iidof workerd-wolves)" = "$iv" ] && grep -q "wolfd-unit.sh" <<<"$out" && ok "--unit wolves with no wolfd-unit.sh: rc 1, nothing changed, no restart" || bad "no unit.sh rc=$rc"
iw=$(iidof workerd)
run workerd 0.9.8 --settle 3 --unit both; rc=$?
[ $rc = 3 ] && [ "$(ver /opt/wolfpack-workerd)" = 0.9.5 ] && [ "$(wv)" = "$cv" ] && [ "$(iidof workerd-wolves)" = "$iv" ] && grep -q "is NOT restarted" <<<"$out" && act workerd && same \
  && ok "--unit both, wolves install fails AFTER the link flipped: link rolled back (rc 3), workerd-wolves never restarted" || bad "install fail after flip rc=$rc"
mv /tmp/wolfd-unit.sh.bak $LIVE/wolfd-unit.sh

echo "--- wolves smoke test fails"
clone workerd 0.9.5 0.9.9 ': > workerd.mjs'; n=$(ls $WO/releases | wc -l)
run workerd 0.9.9 --settle 3 --unit wolves; rc=$?
[ $rc = 1 ] && [ "$(wv)" = "$cv" ] && [ "$(ls $WO/releases | wc -l)" = "$n" ] && [ "$(iidof workerd-wolves)" = "$iv" ] && grep -q "smoke test" <<<"$out" && ok "wolves smoke-test failure: rc 1, new release dir removed, current unchanged, no restart" || bad "smoke rc=$rc"

echo "--- current is a real directory / no wolves install -> refused, nothing written"
mv $WO/current /tmp/current.sym; mkdir $WO/current
run workerd 0.9.8 --unit wolves; rc=$?; r1=$rc; o1=$out
run workerd 0.9.8 --unit both; rc=$?
rmdir $WO/current; mv /tmp/current.sym $WO/current
[ $r1 = 1 ] && [ $rc = 1 ] && grep -q "not a symlink" <<<"$o1" && [ "$(ver /opt/wolfpack-workerd)" = 0.9.5 ] && [ "$(iidof workerd-wolves)" = "$iv" ] && ok "current as a real dir: wolves and both refused (rc 1), link unit untouched" || bad "real dir rc=$r1/$rc"
mv $WO /tmp/wo.away; ls1=$(ls /opt | sort | tr '\n' ' ')
run workerd 0.9.8 --unit wolves; rc=$?; r1=$rc
iw=$(iidof workerd); run workerd 0.9.8 --unit both; rc=$?
[ ! -e $WO ] && [ "$(ls /opt | sort | tr '\n' ' ')" = "$ls1" ] && mv /tmp/wo.away $WO
[ $r1 = 1 ] && [ $rc = 1 ] && grep -q "no existing workerd-wolves install" <<<"$out" && [ "$(ver /opt/wolfpack-workerd)" = 0.9.5 ] && [ "$(iidof workerd)" = "$iw" ] && [ -d $WO ] && ok "no workerd-wolves install: wolves and both refused (rc 1) before anything was written; workerd untouched" || bad "no wolves install rc=$r1/$rc"

echo "--- systemctl list-units fails -> no survival snapshot -> refused before any change"
printf '#!/bin/sh\n[ "$1" = list-units ] && exit 1\nexec systemctl "$@"\n' > /usr/local/bin/sc-nolist; chmod +x /usr/local/bin/sc-nolist
clone workerd 0.9.5 0.9.11
iv=$(iidof workerd-wolves); iw=$(iidof workerd); lv=$(ver /opt/wolfpack-workerd); cv=$(wv)
DEPLOY_SYSTEMCTL=/usr/local/bin/sc-nolist run workerd 0.9.11 --settle 3 --unit both; rc=$?
[ $rc = 1 ] && [ "$(ver /opt/wolfpack-workerd)" = "$lv" ] && [ "$(wv)" = "$cv" ] && [ "$(iidof workerd-wolves)" = "$iv" ] && [ "$(iidof workerd)" = "$iw" ] && grep -q "cannot list the active" <<<"$out" && same \
  && ok "list-units failing: --unit both refused (rc 1) before any change: no install, no restart, stand-ins unchanged" || bad "list-units failure rc=$rc"

echo "--- a foreign process in workerd-wolves's cgroup -> restart refused"
mkdir -p /etc/systemd/system/workerd-wolves.service.d
printf '[Service]\nExecStartPost=/bin/bash -c "nohup /usr/bin/tail -f /dev/null >/dev/null 2>&1 &"\n' > /etc/systemd/system/workerd-wolves.service.d/foreign.conf
systemctl daemon-reload; systemctl restart workerd-wolves; wait_active workerd-wolves 20; SS=$(sset); iv=$(iidof workerd-wolves)
systemd-cgls --no-pager -l -u workerd-wolves.service | sed 's/^/    cgls: /' | tail -6
run workerd 0.9.8 --settle 3 --unit wolves; rc=$?
[ $rc = 1 ] && [ "$(wv)" = "$cv" ] && [ "$(iidof workerd-wolves)" = "$iv" ] && grep -q "cgroup holds processes other than" <<<"$out" && ok "foreign process (tail) in the cgroup: refused (rc 1) before any change" || bad "cgls rc=$rc"
rm -rf /etc/systemd/system/workerd-wolves.service.d; systemctl daemon-reload; systemctl restart workerd-wolves; wait_active workerd-wolves 20; SS=$(sset)

echo "--- a supervised wolf unit that the restart kills -> rc 4, no automatic restarts"
mkdir -p /etc/systemd/system/wolfd@hal3.service.d; printf '[Unit]\nPartOf=workerd-wolves.service\n' > /etc/systemd/system/wolfd@hal3.service.d/partof.conf
systemctl daemon-reload; systemctl start wolfd@hal3; wait_active wolfd@hal3 10
clone workerd 0.9.5 0.9.10
run workerd 0.9.10 --settle 3 --unit wolves; rc=$?
[ $rc = 4 ] && grep -q "SURVIVAL: wolfd@hal3.service was restarted" <<<"$out" && grep -q "NOT rolling back" <<<"$out" && [ "$(wv)" = 0.9.10 ] && ok "wolfd@hal3 (PartOf=workerd-wolves) was restarted by the workerd-wolves restart: rc 4, nothing rolled back or restarted further" || bad "survival rc=$rc"
systemctl stop wolfd@hal3; rm -rf /etc/systemd/system/wolfd@hal3.service.d; systemctl daemon-reload
echo "SYSTEMD DEPLOY PROOF OK"
