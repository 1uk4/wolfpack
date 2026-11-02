#!/usr/bin/env bash
# Runs INSIDE the container (see deploy-proof.sh). Synthetic releases with the real layout rules (flat wolfd tarball with VERSION + launch.sh,
# hubd/workerd tarball with <comp>/{VERSION,setup.sh}, .sha256). The script under test is run exactly the way the CLI runs it:
# `bash -s -- <args> < deploy-release.sh` (script on stdin), never as a file.
set -uo pipefail
ok() { echo "ok: $*"; }; bad() { echo "FAIL: $*"; exit 1; }
bash /opt/release/deploy-proof-fakes.sh
useradd --create-home --shell /bin/bash wolf-hal2
H=/home/wolf-hal2
printf "CLAUDE_CODE_OAUTH_TOKEN='x'\n" > $H/.env; chmod 600 $H/.env; chown wolf-hal2:wolf-hal2 $H/.env
S=/var/lib/fakesd
export DEPLOY_TEST=1 DEPLOY_BASE_URL=http://127.0.0.1:8099 DEPLOY_SYSTEMCTL=/opt/fakes/systemctl DEPLOY_JOURNALCTL=/opt/fakes/journalctl DEPLOY_LOG=/var/log/deploy-test.log
ln -sf /opt/fakes/systemctl /usr/local/bin/systemctl

# ---- release builders: /srv/www/<comp>/v<ver>/<comp>-v<ver>-linux-x64.tar.gz(.sha256)
sha() { ( cd "$1" && sha256sum "$2" > "$2.sha256" ); }
mkw() { # wolfd <ver> <mode good|crash|flap>
  local ver=$1 mode=$2 d=/srv/www/wolfd/v$1 t; t=$(mktemp -d); mkdir -p $d
  printf '%s+fake\n' "$ver" > $t/VERSION
  case $mode in
    good)  printf '#!/usr/bin/env bash\necho "wolfd: hal2 serving unix:/run/wolfd-hal2/serve.sock"; exec sleep 1000\n' > $t/launch.sh;;
    crash) printf '#!/usr/bin/env bash\necho "<3>boom: cannot start"; exit 1\n' > $t/launch.sh;;
    flap)  printf '#!/usr/bin/env bash\necho "wolfd: hal2 serving unix:/run/wolfd-hal2/serve.sock"; sleep 0.5; echo "<3>died"; exit 1\n' > $t/launch.sh;;
  esac
  chmod +x $t/launch.sh; tar -czf $d/wolfd-v$ver-linux-x64.tar.gz -C $t .; sha $d wolfd-v$ver-linux-x64.tar.gz; rm -rf $t
}
mkevil() { local ver=$1 kind=$2 d=/srv/www/wolfd/v$1; mkdir -p $d; python3 -I /opt/fakes/mk-evil.py $d/wolfd-v$ver-linux-x64.tar.gz $kind $ver; sha $d wolfd-v$ver-linux-x64.tar.gz; }
mkhub() { # <comp> <ver> <mode good|crash|failnoflip|failflip>
  local comp=$1 ver=$2 mode=$3 d=/srv/www/$1/v$2 t; t=$(mktemp -d); mkdir -p $d $t/$comp
  printf '%s+fake\n' "$ver" > $t/$comp/VERSION
  cat > $t/$comp/setup.sh <<EOS
#!/usr/bin/env bash
S=/var/lib/fakesd; OPT=/opt/wolfpack-$comp; U=$comp.service; MODE=$mode
echo "\$1 via \$0" >> \$S/hub.calls
case "\$1" in
install)
  B=\$3; v=\$(head -n1 \$B/VERSION); [ \$MODE = failnoflip ] && { echo "install: simulated failure before the flip"; exit 1; }
  mkdir -p \$OPT/releases/\$v; cp \$B/VERSION \$OPT/releases/\$v/
  [ -L \$OPT/current ] && ln -sfn "\$(readlink -f \$OPT/current)" \$OPT/previous
  ln -sfn \$OPT/releases/\$v \$OPT/current
  if [ -f \$S/\$U.active ]; then echo \$RANDOM\$RANDOM > \$S/\$U.iid; [ \$MODE = crash ] && rm -f \$S/\$U.active; fi
  [ \$MODE = failflip ] && { echo "install: simulated failure after the flip"; exit 1; }
  exit 0;;
rollback)
  c=\$(readlink -f \$OPT/current); p=\$(readlink -f \$OPT/previous)
  ln -sfn \$p \$OPT/current; ln -sfn \$c \$OPT/previous
  # like the real setup.sh: restarts only a service that is active
  [ -f \$S/\$U.active ] && echo \$RANDOM\$RANDOM > \$S/\$U.iid
  exit 0;;
esac
EOS
  tar -czf $d/$comp-v$ver-linux-x64.tar.gz -C $t $comp; sha $d $comp-v$ver-linux-x64.tar.gz; rm -rf $t
}
mkw 0.1.0 good; mkw 0.1.1 good; mkw 0.1.2 good; mkw 0.1.3 crash; mkw 0.1.4 good; mkw 0.1.5 good; mkw 0.1.6 good; mkw 0.1.8 flap; mkw 0.1.9 good; mkw 0.1.10 good; mkw 0.1.11 good
mkevil 0.1.7 good-links
i=0; for k in hardlink-abs hardlink-escape symlink-abs symlink-escape symwrite chardev fifo dotdot absname; do i=$((i+1)); mkevil 0.3.$i $k; done
echo "0000000000000000000000000000000000000000000000000000000000000000  wolfd-v0.1.2-linux-x64.tar.gz" > /srv/www/wolfd/v0.1.2/wolfd-v0.1.2-linux-x64.tar.gz.sha256
rm /srv/www/wolfd/v0.1.4/*.sha256
sed -i 's/wolfd-v0.1.5/hubd-v0.1.5/' /srv/www/wolfd/v0.1.5/wolfd-v0.1.5-linux-x64.tar.gz.sha256
for v in 0.2.0:good 0.2.1:failnoflip 0.2.2:failflip 0.2.3:crash 0.2.4:good 0.2.5:good 0.2.6:failflip 0.2.7:crash; do mkhub hubd ${v%%:*} ${v#*:}; done
mkhub workerd 0.2.0 good
( cd /srv/www && node -e 'const h=require("http"),fs=require("fs");h.createServer((q,r)=>{try{r.end(fs.readFileSync("/srv/www"+q.url))}catch{r.statusCode=404;r.end()}}).listen(8099,"127.0.0.1")' >/dev/null 2>&1 </dev/null & ); sleep 1

T="--health-timeout 8 --settle 2"
D() { bash -s -- "$@" < /opt/release/deploy-release.sh; }       # exactly how the CLI feeds it
run() { out=$("$@" 2>&1); rc=$?; echo "$out" | sed 's/^/    /'; return $rc; }
ver() { head -n1 $H/release/VERSION | cut -d+ -f1; }
leftovers() { ls -d /tmp/deploy-release.* /tmp/deploy-stage.* $H/.release.new.* $H/.deploy-stage-* /home/.deploy-stage-* 2>/dev/null; }
active() { systemctl is-active --quiet wolfd@hal2.service; }

echo "--- dry run (stdin script)"
run D wolfd 0.1.0 --wolf hal2 --dry-run && [ ! -e $H/release ] && ok "dry-run changes nothing"
echo "--- argument checks before any download"
run D wolfd 0.1.0 --wolf aaaaaaaaaaaaaaaaaaaaaaaaaaaa $T; [ $? = 2 ] && ok "wolf name of 28 chars refused (rc 2)" || bad "long name"
run D wolfd 0.1.0 --wolf ghost $T; rc=$?; [ $rc = 1 ] && echo "$out" | grep -q "no Linux user" && ! echo "$out" | grep -q "download" && ok "unknown Linux user refused before download" || bad "ghost user rc=$rc"
useradd -M wolf-lnk; mkdir /home/real-lnk; ln -s /home/real-lnk /home/wolf-lnk; useradd -M wolf-own; install -d -o root -g root /home/wolf-own
run D wolfd 0.1.0 --wolf lnk $T; [ $? = 1 ] && echo "$out" | grep -q "symlink" && ok "symlinked wolf home refused" || bad "symlink home"
run D wolfd 0.1.0 --wolf own $T; [ $? = 1 ] && echo "$out" | grep -q "not owned" && ok "wolf home not owned by wolf-<name> refused" || bad "owner check"
echo "--- test seams are off without DEPLOY_TEST"
out=$(env -u DEPLOY_TEST bash -s -- wolfd 9.9.9 --wolf hal2 $T < /opt/release/deploy-release.sh 2>&1); rc=$?
[ $rc = 1 ] && echo "$out" | grep -q "https://github.com/1uk4/wolfpack/releases/download/wolfd/v9.9.9" && ! echo "$out" | grep -q 127.0.0.1 && ok "DEPLOY_BASE_URL ignored in production mode (url is github https)" || { echo "$out"; bad "seam leak"; }
echo "--- deploy v0.1.0 (first install)"
run D wolfd v0.1.0 --wolf hal2 $T || bad "first deploy"; [ "$(ver)" = 0.1.0 ] && [ "$(stat -c %U $H/release/launch.sh)" = wolf-hal2 ] && ok "v0.1.0 live, owned by wolf-hal2" || bad "first deploy state"
grep -q "deploy wolfd/v0.1.0 wolf=hal2" /var/log/deploy-test.log && ok "output teed to the log file"
echo "--- idempotent"
pid1=$(cat $S/wolfd@hal2.service.pid); run D wolfd 0.1.0 --wolf hal2 $T; rc=$?
[ $rc = 0 ] && echo "$out" | grep -q no-op && [ "$(cat $S/wolfd@hal2.service.pid)" = "$pid1" ] && ok "same version is a no-op (no restart)" || bad "idempotency"
echo "--- upgrade to v0.1.1 (via stdin)"
run D wolfd 0.1.1 --wolf hal2 $T || bad "upgrade"; [ "$(ver)" = 0.1.1 ] && [ "$(head -c5 $H/release.prev/VERSION)" = 0.1.0 ] && active && ok "v0.1.1 live, v0.1.0 in release.prev, unit healthy" || bad "upgrade state"
echo "--- refusals change nothing"
for c in "0.1.2|sha256 mismatch" "0.1.4|no .*sha256 published" "0.1.5|mismatch" "0.9.9|download failed"; do v=${c%%|*}; m=${c#*|}
  run D wolfd $v --wolf hal2 $T; rc=$?; echo "$out" | grep -qi "REFUSED.*$m" && [ $rc = 1 ] && [ "$(ver)" = 0.1.1 ] && ok "v$v refused ($m); release still 0.1.1" || bad "refusal $v rc=$rc"
done
echo "--- hostile tar members are refused before anything changes"
i=0; for k in hardlink-abs hardlink-escape symlink-abs symlink-escape symwrite chardev fifo dotdot absname; do i=$((i+1))
  before=$(ls $H | tr '\n' ' ')
  run D wolfd 0.3.$i --wolf hal2 $T; rc=$?
  echo "$out" | grep -q "unsafe tar member" && [ $rc = 1 ] && [ "$(ver)" = 0.1.1 ] && [ "$(ls $H | tr '\n' ' ')" = "$before" ] && [ -z "$(leftovers)" ] && ok "$k refused (rc 1), home untouched, no temp dirs" || bad "evil $k rc=$rc"
done
[ ! -e /tmp/abs-escape ] && [ ! -e /srv/escape ] && ok "nothing was written outside the staging dir"
echo "--- a release with ordinary relative symlinks + an in-archive hardlink (like the real wolfd tarball) is accepted"
run D wolfd 0.1.7 --wolf hal2 $T || bad "good-links"; [ "$(ver)" = 0.1.7 ] && [ -L $H/release/tools/bin/claude ] && [ "$(stat -c %U $H/release/node_modules/x/claude)" = wolf-hal2 ] && ok "v0.1.7 (symlink + hardlink) deployed, links kept, owned by wolf-hal2"
echo "--- ANTHROPIC_API_KEY refused (name only)"
echo "ANTHROPIC_API_KEY=sk-ant-SECRETVALUE" >> $H/.env
run D wolfd 0.1.6 --wolf hal2 $T; rc=$?; [ $rc = 1 ] && echo "$out" | grep -q ANTHROPIC_API_KEY && ! echo "$out" | grep -q SECRETVALUE && ! grep -q SECRETVALUE /var/log/deploy-test.log && ok "refused, value never printed or logged" || bad "api key guard"
sed -i '/ANTHROPIC_API_KEY/d' $H/.env
echo "--- health failure -> automatic rollback (stdin script)"
run D wolfd 0.1.3 --wolf hal2 $T; rc=$?
[ $rc = 3 ] && [ "$(ver)" = 0.1.7 ] && active && ls -d $H/release.failed-0.1.3-* >/dev/null && [ "$(head -c5 $H/release.prev/VERSION)" = 0.1.1 ] \
  && ok "v0.1.3 failed health -> rolled back to 0.1.7 (rc=3), unit healthy, failed dir kept, prev restored" || bad "rollback rc=$rc ver=$(ver)"
echo "--- serves, then dies inside the settle window -> rollback"
run D wolfd 0.1.8 --wolf hal2 $T; rc=$?
[ $rc = 3 ] && [ "$(ver)" = 0.1.7 ] && active && ok "v0.1.8 (serving line then crash) rolled back, unit healthy" || bad "flap rc=$rc"
echo "--- an ssh disconnect (SIGHUP) mid-deploy does not interrupt the switch"
bash -s -- wolfd 0.1.6 --wolf hal2 $T < /opt/release/deploy-release.sh > /tmp/hup.out 2>&1 & hp=$!; sleep 1; kill -HUP $hp 2>/dev/null; wait $hp; rc=$?
[ $rc = 0 ] && [ "$(ver)" = 0.1.6 ] && active && ok "SIGHUP ignored: deploy completed, v0.1.6 live" || { cat /tmp/hup.out; bad "hup rc=$rc"; }
echo "--- junk in release.prev/VERSION is sanitized in the saved name"
printf '../../etc/x$(touch /tmp/pwn)\n' > $H/release.prev/VERSION
run D wolfd 0.1.9 --wolf hal2 $T || bad "deploy 0.1.9"; ls -d $H/release.prev-unknown-* >/dev/null && [ ! -e /tmp/pwn ] && ok "prev with a junk VERSION saved as release.prev-unknown-<ts>"
echo "--- crash recovery: release missing, release.prev present"
mkdir -p $H/.release.new.77 $H/.deploy-stage-hal2.zz /home/.deploy-stage-hal2.yy; touch $H/.release.new.77/x
prevv=$(head -n1 $H/release.prev/VERSION | cut -d+ -f1); rm -rf $H/release
run D wolfd 0.1.10 --wolf hal2 $T; rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "RECOVERY" && [ "$(ver)" = 0.1.10 ] && [ "$(head -c5 $H/release.prev/VERSION)" = "$prevv" ] && active && [ -z "$(leftovers)" ] \
  && ok "missing release restored from release.prev ($prevv), leftover .release.new/stage dirs removed, then deployed 0.1.10" || bad "recovery rc=$rc"
echo "--- crash recovery: only a versioned release.prev-* is left; no-op run still restores and restarts"
rm -rf $H/release $H/release.prev; ls -d $H/release.prev-* >/dev/null || bad "no versioned prevs"
run D wolfd 0.1.11 --wolf hal2 $T; rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "RECOVERY" && [ "$(ver)" = 0.1.11 ] && active && ok "recovered from the newest release.prev-* then deployed 0.1.11" || bad "recovery 2 rc=$rc"
n1=$(ls -d $H/release.prev-* 2>/dev/null | wc -l); n2=$(ls -d $H/release.failed-* 2>/dev/null | wc -l)
[ $n1 -le 2 ] && [ $n2 -le 2 ] && ok "old release.prev-*/release.failed-* pruned to the newest 2 ($n1/$n2)" || bad "prune $n1/$n2"
echo "--- hubd via setup.sh (fake unit flag; env file points at the listening http server)"
install -d /etc/wolfpack /opt/wolfpack-hubd/releases /opt/wolfpack-workerd/releases
printf 'HUBD_HOST=127.0.0.1\nHUBD_PORT=8099\nWORKERD_HOST=127.0.0.1\nWORKERD_PORT=8099\n' > /etc/wolfpack/hubd.env; cp /etc/wolfpack/hubd.env /etc/wolfpack/workerd.env
touch $S/hubd.service.active; echo 1 > $S/hubd.service.iid; cur() { basename "$(readlink -f /opt/wolfpack-hubd/current)" | cut -d+ -f1; }
run D hubd 0.2.0 $T || bad "hubd 0.2.0"; [ "$(cur)" = 0.2.0 ] && [ -f /opt/wolfpack-hubd/setup.sh ] && ok "hubd 0.2.0 installed, healthy (listening), setup.sh saved for rollback"
: > $S/hub.calls
run D hubd 0.2.1 $T; rc=$?; [ $rc = 1 ] && [ "$(cur)" = 0.2.0 ] && ! grep -q rollback $S/hub.calls && echo "$out" | grep -q "did not change" && ok "install fails before the flip -> rc 1, old release live, NO rollback" || { cat $S/hub.calls; readlink -f /opt/wolfpack-hubd/current; bad "failnoflip rc=$rc"; }
run D hubd 0.2.2 $T; rc=$?; [ $rc = 3 ] && [ "$(cur)" = 0.2.0 ] && grep -q "rollback via the installed /opt/wolfpack-hubd/setup.sh" <<<"$out" && ok "install fails AFTER the flip -> health/rollback path (rc 3) with the installed setup.sh, back on 0.2.0" || bad "failflip rc=$rc"
run D hubd 0.2.3 $T; rc=$?; [ $rc = 3 ] && [ "$(cur)" = 0.2.0 ] && systemctl is-active --quiet hubd.service && ok "service dies after install -> rolled back (rc 3) and restarted: hubd active again" || bad "crash rc=$rc"
sed -i 's/HUBD_PORT=8099/HUBD_PORT=8097/' /etc/wolfpack/hubd.env
run D hubd 0.2.4 $T; rc=$?; [ $rc = 4 ] && [ "$(cur)" = 0.2.0 ] && echo "$out" | grep -q "nothing is listening" && echo "$out" | grep -q "ROLLBACK UNHEALTHY" && ok "active but not listening -> rolled back, re-check also fails (shared bad port) -> rc 4 flagged for a human" || bad "listen rc=$rc"
sed -i 's/HUBD_PORT=8097/HUBD_PORT=8099/' /etc/wolfpack/hubd.env
rm -f $S/hubd.service.active
run D hubd 0.2.5 $T; rc=$?; [ $rc = 0 ] && [ "$(cur)" = 0.2.5 ] && echo "$out" | grep -q "not running" && ! systemctl is-active --quiet hubd.service && ok "service was stopped: installed, reported, left stopped, not treated as a failure" || bad "stopped rc=$rc"
run D hubd 0.2.6 $T; rc=$?; [ $rc = 3 ] && [ "$(cur)" = 0.2.5 ] && echo "$out" | grep -q "left stopped" && ok "stopped service + install fails after flip -> rolled back, left stopped (rc 3)" || bad "stopped failflip rc=$rc"
touch $S/hubd.service.active; rm -f /opt/wolfpack-hubd/setup.sh
run D hubd 0.2.7 $T; rc=$?; [ $rc = 3 ] && [ "$(cur)" = 0.2.5 ] && echo "$out" | grep -q "swapping /opt/wolfpack-hubd/current and previous myself" && ok "no installed setup.sh yet -> script swaps the links itself (rc 3)" || bad "native rollback rc=$rc"
touch $S/workerd.service.active; echo 1 > $S/workerd.service.iid
run D workerd 0.2.0 $T || bad "workerd"; [ "$(basename "$(readlink -f /opt/wolfpack-workerd/current)" | cut -d+ -f1)" = 0.2.0 ] && ok "workerd 0.2.0 installed through the same path"
[ -z "$(leftovers)" ] && ok "no temp dirs left behind"
echo "DEPLOY PROOF OK"
