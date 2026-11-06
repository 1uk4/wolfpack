#!/usr/bin/env bash
# The "wolfd command" of workerd-wolves (--wolfd). workerd calls it as `wolfd-unit.sh --config <registry>/<name>/wolf.yaml --socket <sock>`
# and expects a child that prints "serving unix:<sock>" once the wolf is up and exits when the wolf is gone. This one:
#   1. systemctl start wolfd@<name>  (authorised by polkit; systemd starts it as wolf-<name> under MemoryMax)
#   2. waits for the socket, prints the serving line
#   3. watches the unit; exits non-zero when it is dead/failed so workerd's backoff restarts the cycle
# SIGTERM (workerd stopping/removing the wolf) just exits and leaves the unit running (workerd adopts it again). WOLFD_UNIT_STOP_ON_EXIT=1 stops the unit instead.
set -uo pipefail
cfg="" sock=""
while (($#)); do case "$1" in --config) cfg=$2; shift 2;; --socket) sock=$2; shift 2;; *) shift;; esac; done
[ -n "$cfg" ] && [ -n "$sock" ] || { echo "usage: wolfd-unit.sh --config <dir>/<name>/wolf.yaml --socket <path>" >&2; exit 2; }
name=$(basename "$(dirname "$cfg")")
[[ $name =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "wolfd-unit: bad wolf name '$name'" >&2; exit 2; }
unit="wolfd@$name.service"
on_term() { [ "${WOLFD_UNIT_STOP_ON_EXIT:-}" = 1 ] && systemctl stop "$unit" >/dev/null 2>&1; exit 0; }
trap on_term TERM INT
systemctl start "$unit" || { echo "wolfd-unit: cannot start $unit" >&2; exit 1; }
for _ in $(seq 1 60); do [ -S "$sock" ] && break; sleep 0.5; done
[ -S "$sock" ] || { echo "wolfd-unit: $sock did not appear" >&2; exit 1; }
echo "wolfd-unit: $unit serving unix:$sock"
while :; do
  st=$(systemctl show -p ActiveState --value "$unit" 2>/dev/null)
  case "$st" in active|activating|reloading) ;; *) echo "wolfd-unit: $unit is $st" >&2; exit 1;; esac
  sleep 2 & wait $!
done
