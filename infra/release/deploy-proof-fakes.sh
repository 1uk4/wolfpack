#!/usr/bin/env bash
# Installed by deploy-proof-inner.sh: writes the systemctl/journalctl doubles + the evil-tarball builder into /opt/fakes.
mkdir -p /opt/fakes /var/lib/fakesd
cat > /opt/fakes/journalctl <<'F'
#!/usr/bin/env bash
# fake: journalctl [_SYSTEMD_INVOCATION_ID=ID | -u UNIT --since @N] [-p err] --no-pager -q. Journal lines: "iid prio msg" (prio 3 = err).
id="" p="" 
while (($#)); do case $1 in _SYSTEMD_INVOCATION_ID=*) id=${1#*=};; -p) p=$2; shift;; esac; shift; done
f=/var/lib/fakesd/journal; [ -n "$id" ] && [ -f "$f" ] || exit 0
awk -v id="$id" -v p="$p" '$1==id && (p=="" || $2<=3){ $1="";$2=""; print substr($0,3) }' "$f"
F
cat > /opt/fakes/systemctl <<'F'
#!/usr/bin/env bash
# fake systemctl. wolfd@N.service runs HOME/release/launch.sh as wolf-N (output -> fake journal, "<3>" prefix = err). Other units: flag file S/<unit>.active.
S=/var/lib/fakesd; verb=$1; shift
case "$verb" in
  show) u=${!#}; [ -f $S/$u.iid ] && v=$(cat $S/$u.iid) || v=""; case "$*" in *InvocationID*) echo "$v";; *NRestarts*) echo 0;; esac; exit 0;;
  reset-failed) exit 0;;
esac
Q=0; [ "${1:-}" = --quiet ] && { Q=1; shift; }; u=${1:-}
case "$verb" in
  is-active)
    if [[ $u == wolfd@* ]]; then [ -f $S/$u.pid ] && kill -0 "$(cat $S/$u.pid)" 2>/dev/null && r=active || r=failed
    else [ -f $S/$u.active ] && r=active || r=failed; fi
    [ "${Q:-}" = 1 ] || echo $r; [ $r = active ];;
  restart)
    iid=$RANDOM$RANDOM; echo $iid > $S/$u.iid
    if [[ $u == wolfd@* ]]; then
      n=${u#wolfd@}; n=${n%.service}
      if [ -f $S/$u.pid ]; then kill -- -"$(cat $S/$u.pid)" 2>/dev/null; sleep 0.3; fi
      setsid bash -c 'exec 3< <(runuser -u wolf-'$n' -- env HOME=/home/wolf-'$n' /home/wolf-'$n'/release/launch.sh 2>&1)
        while IFS= read -r l <&3; do p=6; [[ $l == "<3>"* ]] && { p=3; l=${l#<3>}; }; echo "'$iid' $p $l" >> '$S'/journal; done' >/dev/null 2>&1 </dev/null &
      echo $! > $S/$u.pid
    else touch $S/$u.active; fi;;
esac
F
cat > /opt/fakes/mk-evil.py <<'F'
import io, sys, tarfile
out, kind, ver = sys.argv[1:4]
tf = tarfile.open(out, "w:gz", format=tarfile.GNU_FORMAT)
def add(name, data=b"", mode=0o755):
    ti = tarfile.TarInfo(name); ti.size = len(data); ti.mode = mode; tf.addfile(ti, io.BytesIO(data))
def node(name, typ, target="", major=0, minor=0):
    ti = tarfile.TarInfo(name); ti.type = typ; ti.linkname = target; ti.devmajor = major; ti.devminor = minor; tf.addfile(ti)
add("./VERSION", (ver + "+evil\n").encode(), 0o644)
add("./launch.sh", b'#!/usr/bin/env bash\necho "wolfd: hal2 serving unix:/run/wolfd-hal2/serve.sock"; exec sleep 1000\n')
if kind == "good-links":
    add("./node_modules/x/claude", b"bin")
    node("./tools/bin/claude", tarfile.SYMTYPE, "../../node_modules/x/claude")
    node("./node_modules/y", tarfile.LNKTYPE, "./node_modules/x/claude")
elif kind == "hardlink-abs": node("./hl", tarfile.LNKTYPE, "/etc/hostname")
elif kind == "hardlink-escape": node("./hl", tarfile.LNKTYPE, "../../x")
elif kind == "symlink-abs": node("./sl", tarfile.SYMTYPE, "/etc")
elif kind == "symlink-escape": node("./a/b/sl", tarfile.SYMTYPE, "../../../etc/passwd")
elif kind == "symwrite": node("./evil", tarfile.SYMTYPE, "."); add("./evil/payload", b"x")
elif kind == "chardev": node("./dev0", tarfile.CHRTYPE, "", 1, 3)
elif kind == "fifo": node("./fifo0", tarfile.FIFOTYPE)
elif kind == "dotdot": add("../escape", b"x")
elif kind == "absname": add("/tmp/abs-escape", b"x")
tf.close()
F
chmod +x /opt/fakes/journalctl /opt/fakes/systemctl
