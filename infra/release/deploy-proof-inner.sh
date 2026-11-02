#!/usr/bin/env bash
# Runs INSIDE the container (see deploy-proof.sh). Synthetic wolfd/hubd releases with the real layout rules (flat tarball, VERSION, launch.sh, .sha256).
set -uo pipefail
D=/opt/release/deploy-release.sh
ok() { echo "ok: $*"; }; bad() { echo "FAIL: $*"; exit 1; }
useradd --create-home --shell /bin/bash wolf-hal2
H=/home/wolf-hal2
install -d -o wolf-hal2 -g wolf-hal2 "$H"
printf "CLAUDE_CODE_OAUTH_TOKEN='x'\n" > $H/.env; chmod 600 $H/.env; chown wolf-hal2:wolf-hal2 $H/.env
# ---- doubles
mkdir -p /opt/fakes /var/lib/fakesd /srv/www
cat > /opt/fakes/journalctl <<'F'
#!/usr/bin/env bash
# fake: journalctl -u UNIT [-p err] --since @N --no-pager -q ; journal lines "epoch prio msg"
u="" p="" s=0
while (($#)); do case $1 in -u) u=$2; shift;; -p) p=$2; shift;; --since) s=${2#@}; shift;; esac; shift; done
f=/var/lib/fakesd/$u.journal; [ -f "$f" ] || exit 0
awk -v s="$s" -v p="$p" '$1>=s && (p=="" || $2<=3){ $1="";$2=""; print substr($0,3) }' "$f"
F
cat > /opt/fakes/systemctl <<'F'
#!/usr/bin/env bash
# fake systemctl: wolfd@N.service runs HOME/release/launch.sh as wolf-N, output -> fake journal ("<3>" prefix = err). Other units: flag files.
S=/var/lib/fakesd; verb=$1; shift; q=0; [ "${1:-}" = --quiet ] && { q=1; shift; }; u=${1:-}
case "$verb" in
  reset-failed) exit 0;;
  is-active)
    if [[ $u == wolfd@* ]]; then
      if [ -f $S/$u.pid ] && kill -0 "$(cat $S/$u.pid)" 2>/dev/null; then r=active; else r=failed; fi
    else [ -f $S/$u.active ] && r=active || r=failed; fi
    ((q)) || echo $r; [ $r = active ];;
  restart)
    [[ $u == wolfd@* ]] || exit 0
    n=${u#wolfd@}; n=${n%.service}; [ -f $S/$u.pid ] && pkill -P "$(cat $S/$u.pid)" 2>/dev/null; [ -f $S/$u.pid ] && kill "$(cat $S/$u.pid)" 2>/dev/null; sleep 0.3
    ( setsid bash -c '
        exec 3< <(runuser -u wolf-'$n' -- env HOME=/home/wolf-'$n' /home/wolf-'$n'/release/launch.sh 2>&1)
        while IFS= read -r l <&3; do p=6; [[ $l == "<3>"* ]] && { p=3; l=${l#<3>}; }; echo "$(date +%s) $p $l" >> '$S'/'$u'.journal; done' >/dev/null 2>&1 </dev/null & echo $! > $S/$u.pid ) ;;
esac
F
chmod +x /opt/fakes/*; ln -sf /opt/fakes/systemctl /usr/local/bin/systemctl
export SYSTEMCTL=/opt/fakes/systemctl JOURNALCTL=/opt/fakes/journalctl DEPLOY_BASE_URL=http://127.0.0.1:8099
# ---- synthetic releases: <comp>/v<ver>/<comp>-v<ver>-linux-x64.tar.gz(.sha256); mode = good | crash
mk() { local comp=$1 ver=$2 mode=$3 d=/srv/www/$1/v$2 t; t=$(mktemp -d); mkdir -p $d
  if [ $comp = wolfd ]; then
    printf '%s+fake\n' "$ver" > $t/VERSION
    if [ $mode = good ]; then printf '#!/usr/bin/env bash\necho "wolfd: hal2 serving unix:/run/wolfd-hal2/serve.sock"; exec sleep 1000\n' > $t/launch.sh
    else printf '#!/usr/bin/env bash\necho "<3>boom: cannot start"; exit 1\n' > $t/launch.sh; fi
    chmod +x $t/launch.sh; tar -czf $d/$comp-v$ver-linux-x64.tar.gz -C $t .
  else
    mkdir $t/$comp; printf '%s+fake\n' "$ver" > $t/$comp/VERSION
    printf '#!/usr/bin/env bash\necho "setup $1 $(cat "$(dirname "$0")/VERSION")" >> /var/lib/fakesd/hub.calls\nif [ "$1" = install ] && [ %s = crash ]; then rm -f /var/lib/fakesd/hubd.service.active; else touch /var/lib/fakesd/hubd.service.active; fi\n' "$mode" > $t/$comp/setup.sh
    tar -czf $d/$comp-v$ver-linux-x64.tar.gz -C $t $comp
  fi
  ( cd $d && sha256sum $comp-v$ver-linux-x64.tar.gz > $comp-v$ver-linux-x64.tar.gz.sha256 ); rm -rf $t; }
mk wolfd 0.1.0 good; mk wolfd 0.1.1 good; mk wolfd 0.1.2 good; mk wolfd 0.1.3 crash; mk wolfd 0.1.4 good; mk wolfd 0.1.5 good; mk hubd 0.2.0 good; mk hubd 0.2.2 crash
echo "0000000000000000000000000000000000000000000000000000000000000000  wolfd-v0.1.2-linux-x64.tar.gz" > /srv/www/wolfd/v0.1.2/wolfd-v0.1.2-linux-x64.tar.gz.sha256   # bad hash
rm /srv/www/wolfd/v0.1.4/*.sha256                                                                                                                                   # missing .sha256
sed 's/wolfd-v0.1.5/hubd-v0.1.5/' -i /srv/www/wolfd/v0.1.5/wolfd-v0.1.5-linux-x64.tar.gz.sha256                                                                    # names another component
( cd /srv/www && node -e 'const h=require("http"),fs=require("fs");h.createServer((q,r)=>{try{r.end(fs.readFileSync("/srv/www"+q.url))}catch{r.statusCode=404;r.end()}}).listen(8099,"127.0.0.1")' >/dev/null 2>&1 </dev/null & ) ; sleep 1
T="--health-timeout 6 --settle 1"
run() { out=$("$@" 2>&1); rc=$?; echo "$out" | sed 's/^/    /'; return $rc; }
ver() { head -n1 $H/release/VERSION | cut -d+ -f1; }
echo "--- dry run"
run $D wolfd 0.1.0 --wolf hal2 --dry-run && [ ! -e $H/release ] && ok "dry-run changes nothing"
echo "--- deploy v0.1.0 (first install)"
run $D wolfd v0.1.0 --wolf hal2 $T || bad "first deploy"; [ "$(ver)" = 0.1.0 ] && [ "$(stat -c %U $H/release/launch.sh)" = wolf-hal2 ] && ok "v0.1.0 live, owned by wolf-hal2"
echo "--- idempotent"
pid1=$(cat /var/lib/fakesd/wolfd@hal2.service.pid); run $D wolfd 0.1.0 --wolf hal2 $T; rc=$?
[ $rc = 0 ] && echo "$out" | grep -q no-op && [ "$(cat /var/lib/fakesd/wolfd@hal2.service.pid)" = "$pid1" ] && ok "same version is a no-op (no restart)" || bad "idempotency"
echo "--- upgrade to v0.1.1"
run $D wolfd 0.1.1 --wolf hal2 $T || bad "upgrade"; [ "$(ver)" = 0.1.1 ] && [ "$(head -c5 $H/release.prev/VERSION)" = 0.1.0 ] && systemctl is-active --quiet wolfd@hal2.service && ok "v0.1.1 live, v0.1.0 in release.prev, unit healthy"
echo "--- refusals change nothing"
for c in "0.1.2|sha256 mismatch" "0.1.4|no .*sha256 published" "0.1.5|mismatch"; do v=${c%%|*}; m=${c#*|}
  run $D wolfd $v --wolf hal2 $T; rc=$?; echo "$out" | grep -qi "REFUSED.*$m" && [ $rc = 1 ] && [ "$(ver)" = 0.1.1 ] && ok "v$v refused ($m); release still 0.1.1" || bad "refusal $v rc=$rc"
done
run $D wolfd 0.9.9 --wolf hal2 $T; [ $? = 1 ] && [ "$(ver)" = 0.1.1 ] && ok "unknown release (404) refused"
ls -d /tmp/deploy-release.* $H/.release.new.* 2>/dev/null && bad "temp dirs left behind" || ok "no temp dirs left behind"
echo "--- ANTHROPIC_API_KEY refused (name only)"
echo "ANTHROPIC_API_KEY=sk-ant-SECRETVALUE" >> $H/.env
run $D wolfd 0.1.0 --wolf hal2 $T; rc=$?; [ $rc = 1 ] && echo "$out" | grep -q ANTHROPIC_API_KEY && ! echo "$out" | grep -q SECRETVALUE && ok "refused, value never printed" || bad "api key guard"
sed -i '/ANTHROPIC_API_KEY/d' $H/.env
echo "--- health failure -> automatic rollback"
ps_before=$(cat /var/lib/fakesd/wolfd@hal2.service.pid)
run $D wolfd 0.1.3 --wolf hal2 $T; rc=$?
[ $rc = 3 ] && [ "$(ver)" = 0.1.1 ] && systemctl is-active --quiet wolfd@hal2.service && ls -d $H/release.failed-0.1.3-* >/dev/null && [ "$(head -c5 $H/release.prev/VERSION)" = 0.1.0 ] \
  && grep -q "serving" /var/lib/fakesd/wolfd@hal2.service.journal && ok "v0.1.3 failed health, rolled back to 0.1.1 (rc=3), unit healthy, failed dir kept, prev restored" || bad "rollback rc=$rc ver=$(ver)"
echo "--- upgrade again keeps older prev under a versioned name"
run $D wolfd 0.1.1 --wolf hal2 $T >/dev/null; mk wolfd 0.1.6 good
run $D wolfd 0.1.6 --wolf hal2 $T || bad "deploy 0.1.6"; ls -d $H/release.prev-0.1.0-* >/dev/null && [ "$(head -c5 $H/release.prev/VERSION)" = 0.1.1 ] && ok "release.prev=0.1.1, old prev kept as release.prev-0.1.0-<ts>"
echo "--- hubd via setup.sh install / rollback"
touch /var/lib/fakesd/hubd.service.active
run $D hubd 0.2.0 $T || bad "hubd 0.2.0"; ok "hubd 0.2.0 installed through its setup.sh"
run $D hubd 0.2.2 $T; rc=$?; [ $rc = 3 ] && tail -n2 /var/lib/fakesd/hub.calls | tr '\n' ' ' | grep -q "install 0.2.2.*rollback" && ok "hubd 0.2.2 unhealthy -> setup.sh rollback (rc=3)" || bad "hubd rollback rc=$rc"
echo "DEPLOY PROOF OK"
