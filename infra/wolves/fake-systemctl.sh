#!/usr/bin/env bash
# TEST DOUBLE for systemctl (no systemd in the sandboxed Docker here): implements only what wolfd-unit.sh calls, and mimics what systemd does for
# wolfd@<n>.service: runtime dir /run/wolfd-<n> (0750 wolf-<n>), run as wolf-<n>, UMask 0007, Restart=on-failure. NOT evidence about systemd itself.
# Privilege model: the CALLER is unprivileged (workerd-wolves). start/stop are requests dropped in /var/spool/fake-pid1 and carried out by a ROOT loop
# (fake-pid1.sh, the stand-in for PID 1 + polkit), exactly as the real thing has to be done by systemd, not by workerd.
set -u
verb=$1; shift
if [ "${FAKE_PID1:-}" != 1 ] && { [ "$verb" = start ] || [ "$verb" = stop ]; }; then
  d=/var/spool/fake-pid1; f=$d/$$.req; echo "$verb $1" > $f.tmp; mv $f.tmp $f
  for _ in $(seq 1 100); do [ -e $f ] || exit 0; sleep 0.1; done; exit 1
fi
unitname() { local u=${1%.service}; echo "${u#wolfd@}"; }
case "$verb" in
  start)
    n=$(unitname "$1"); u=wolf-$n; run=/run/wolfd-$n
    pgrep -u "$u" -f "stub-wolfd.mjs" >/dev/null && exit 0
    install -d -o "$u" -g "$u" -m 0750 "$run"
    ( umask 0007; setsid runuser -u "$u" -- env HOME=/home/$u WOLF_HOME=/home/$u TRACER_REPLY=tracer-pong \
        bash -c "while :; do node /opt/tracer/stub-wolfd.mjs --config /home/$u/wolf.yaml --socket $run/serve.sock; [ \$? = 0 ] && break; sleep 1; done" >>/tmp/fake-$n.log 2>&1 & )
    ;;
  show) n=$(unitname "${@: -1}"); pgrep -u "wolf-$n" -f "^node /opt/tracer/stub-wolfd.mjs --config" >/dev/null && echo active || echo inactive ;;
  stop) n=$(unitname "$1"); pkill -u "wolf-$n" -f "while :" ; pkill -u "wolf-$n" -f stub-wolfd.mjs ;;
esac
