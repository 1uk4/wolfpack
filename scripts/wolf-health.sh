#!/usr/bin/env bash
# wolf-health.sh - CPU/memory health of a Wolfpack host and the resources each wolf is using.
#
# Wolves are discovered from systemd, not hardcoded: any unit whose Description
# is "Wolfpack - <name>" (see roles/wolf-service/templates/wolf.service.j2) is a
# wolf. Renaming a wolf therefore needs no change here.
#
#   ./wolf-health.sh              one reading, human readable
#   ./wolf-health.sh --json       one reading as JSON (for cron/alerting)
#   ./wolf-health.sh --watch      refresh until Ctrl-C
#   ./wolf-health.sh -i 5         sample CPU over 5s instead of 1s
#
# Exit: 0 healthy, 1 warning, 2 critical. Safe to run as a non-root user
# (the tmux liveness probe is skipped without sudo).

set -uo pipefail

INTERVAL=1
JSON=0
WATCH=0
WATCH_EVERY=5

# thresholds (percent)
CPU_WARN=70;  CPU_CRIT=90
MEM_WARN=75;  MEM_CRIT=90
DISK_WARN=80; DISK_CRIT=90
LOAD_WARN=1.0 LOAD_CRIT=2.0   # per core

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --json)  JSON=1 ;;
    --watch) WATCH=1 ;;
    -i|--interval) INTERVAL="${2:-1}"; shift ;;
    -n|--every)    WATCH_EVERY="${2:-5}"; shift ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 64 ;;
  esac
  shift
done

if [ -t 1 ] && [ "$JSON" -eq 0 ]; then
  B=$'\e[1m'; DIM=$'\e[2m'; R=$'\e[0m'
  GRN=$'\e[32m'; YEL=$'\e[33m'; RED=$'\e[31m'; CYA=$'\e[36m'
else
  B=""; DIM=""; R=""; GRN=""; YEL=""; RED=""; CYA=""
fi

STATUS=0   # worst severity seen: 0 ok, 1 warn, 2 crit
bump() { [ "$1" -gt "$STATUS" ] && STATUS="$1"; return 0; }

# severity of a value against warn/crit thresholds
sev() {
  awk -v v="$1" -v w="$2" -v c="$3" 'BEGIN{ print (v>=c) ? 2 : ((v>=w) ? 1 : 0) }'
}
paint() {
  case "$2" in
    2) printf '%s%s%s' "$RED" "$1" "$R" ;;
    1) printf '%s%s%s' "$YEL" "$1" "$R" ;;
    *) printf '%s%s%s' "$GRN" "$1" "$R" ;;
  esac
}
bar() {   # bar <pct> <width>
  awk -v p="$1" -v w="${2:-10}" 'BEGIN{
    if (p<0) p=0; if (p>100) p=100;
    f=int(p*w/100+0.5); s="";
    for(i=0;i<w;i++) s = s (i<f ? "#" : "-");
    print s
  }'
}
human() {  # bytes -> human
  awk -v b="${1:-0}" 'BEGIN{
    if (b<0) b=0;
    split("B K M G T",u," ");
    i=1; while (b>=1024 && i<5) { b/=1024; i++ }
    printf (i==1 ? "%.0f%s" : "%.1f%s"), b, u[i]
  }'
}

NCPU=$(nproc 2>/dev/null || echo 1)
HOSTNAME_S=$(hostname -s 2>/dev/null || echo unknown)

# ---- discovery -------------------------------------------------------------

# One `systemctl show` over a glob instead of one per unit: on a host with 135
# services that is ~0.3s rather than ~2.3s, which is what made --watch crawl.
# Paragraph mode (RS="") gives one record per unit, so field order is irrelevant.
discover_wolves() {   # -> "unit<TAB>name" per line
  systemctl show '*.service' --property=Id,Description --no-pager 2>/dev/null \
  | awk 'BEGIN{RS=""; FS="\n"} {
      id=""; desc="";
      for (i=1; i<=NF; i++) {
        if ($i ~ /^Id=/)          id   = substr($i, 4);
        if ($i ~ /^Description=/) desc = substr($i, 13);
      }
      if (id != "" && desc ~ /^Wolfpack - /) {
        sub(/^Wolfpack - /, "", desc);
        printf "%s\t%s\n", id, desc;
      }
    }' | sort -u
}

discover_support() {  # infra that competes with the wolves for the same 2 vCPU
  systemctl list-units --type=service --state=active --no-legend --plain 2>/dev/null \
  | awk '{print $1}' \
  | grep -E '^(wolfpack-cc|syncthing@|tailscaled)' | sort -u
}

# ---- per-unit sampling -----------------------------------------------------

# Properties for every unit of interest are fetched in one call and cached in
# PROPS, keyed "unit:Property". unit_num then costs nothing.
declare -A PROPS
load_props() {
  local units=("$@")
  [ "${#units[@]}" -eq 0 ] && return 0
  PROPS=()
  local u k v
  while IFS=$'\t' read -r u k v; do
    [ -n "$u" ] && PROPS["$u:$k"]="$v"
  done < <(
    systemctl show "${units[@]}" \
      --property=Id,ActiveState,MemoryCurrent,TasksCurrent,NRestarts,MemoryPeak \
      --no-pager 2>/dev/null \
    | awk 'BEGIN{RS=""; FS="\n"} {
        id="";
        for (i=1; i<=NF; i++) if ($i ~ /^Id=/) id = substr($i, 4);
        if (id == "") next;
        for (i=1; i<=NF; i++) {
          eq = index($i, "=");
          if (eq == 0) continue;
          k = substr($i, 1, eq-1);
          if (k == "Id") continue;
          printf "%s\t%s\t%s\n", id, k, substr($i, eq+1);
        }
      }'
  )
}

unit_num() {  # unit prop -> integer (0 when unset/inactive)
  local v="${PROPS["$1:$2"]:-}"
  case "$v" in ''|'[not set]'|infinity|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac
}

unit_state() { printf '%s' "${PROPS["$1:ActiveState"]:-unknown}"; }

cpu_snapshot() {   # -> "unit<TAB>nsec" for all UNITS, in one call
  [ "${#UNITS[@]}" -eq 0 ] && return 0
  systemctl show "${UNITS[@]}" --property=Id,CPUUsageNSec --no-pager 2>/dev/null \
  | awk 'BEGIN{RS=""; FS="\n"} {
      id=""; ns="0";
      for (i=1; i<=NF; i++) {
        if ($i ~ /^Id=/)            id = substr($i, 4);
        if ($i ~ /^CPUUsageNSec=/)  ns = substr($i, 14);
      }
      if (ns !~ /^[0-9]+$/) ns = "0";
      if (id != "") printf "%s\t%s\n", id, ns;
    }'
}

# Samples every unit's cumulative CPU-nanoseconds, sleeps, samples again, and
# turns the delta into a share of total machine capacity (all cores).
sample_units() {   # sample_units <unit...>  -> "unit<TAB>cpu_pct" per line
  local units=("$@") t0 t1 u
  [ "${#units[@]}" -eq 0 ] && return 0
  local -a a b
  t0=$(date +%s.%N)
  for u in "${units[@]}"; do a+=("$(unit_num "$u" CPUUsageNSec)"); done
  sleep "$INTERVAL"
  t1=$(date +%s.%N)
  for u in "${units[@]}"; do b+=("$(unit_num "$u" CPUUsageNSec)"); done
  local i=0
  for u in "${units[@]}"; do
    awk -v unit="$u" -v x="${a[$i]}" -v y="${b[$i]}" -v t0="$t0" -v t1="$t1" -v n="$NCPU" 'BEGIN{
      el = t1 - t0; if (el <= 0) el = 1;
      d = y - x; if (d < 0) d = 0;
      printf "%s\t%.1f\n", unit, (d / (el * 1e9 * n)) * 100
    }'
    i=$((i+1))
  done
}

host_cpu_pct() {   # /proc/stat delta across the same window
  local a b
  a=$(awk '/^cpu /{idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; print idle, tot}' /proc/stat)
  sleep "$INTERVAL"
  b=$(awk '/^cpu /{idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; print idle, tot}' /proc/stat)
  awk -v a="$a" -v b="$b" 'BEGIN{
    split(a,x," "); split(b,y," ");
    di = y[1]-x[1]; dt = y[2]-x[2];
    printf "%.1f", (dt<=0) ? 0 : (1 - di/dt) * 100
  }'
}

tmux_up() {   # a wolf can be "active" in systemd while its tmux pane is gone
  local sess="$1" wu="${2:-wolf}" sock=""
  # Wolves from `wolfpack add` run their own tmux server.
  [ -d "/home/${wu}/wolves/${sess}" ] && sock="-L ${sess}"
  if [ "$(id -u)" = "0" ]; then
    sudo -iu "$wu" tmux $sock has-session -t "$sess" >/dev/null 2>&1 && echo up || echo DOWN
  elif [ "$(id -un)" = "$wu" ]; then
    tmux $sock has-session -t "$sess" >/dev/null 2>&1 && echo up || echo DOWN
  else
    echo "?"
  fi
}

# du over a large den is slow and its size barely moves, so in watch mode the
# result is reused for DEN_TTL seconds rather than recomputed every frame.
declare -A DEN_VAL DEN_TS
DEN_TTL="${DEN_TTL:-60}"
den_size() {
  local w="$1" u="${2:-wolf}" p now v
  # Wolves from `wolfpack add` keep their den under wolves/<name>/; the first
  # wolf on a host is still at workspace/den.
  p="/home/${u}/wolves/${w}/den"
  [ -d "$p" ] || p="/home/${u}/workspace/den"
  [ -d "$p" ] || { echo "-"; return; }
  now=$(date +%s)
  if [ -n "${DEN_TS[$w]:-}" ] && [ $(( now - ${DEN_TS[$w]} )) -lt "$DEN_TTL" ]; then
    echo "${DEN_VAL[$w]}"; return
  fi
  v=$(du -sh "$p" 2>/dev/null | awk '{print $1}')
  [ -n "$v" ] || v="-"
  DEN_VAL[$w]="$v"; DEN_TS[$w]="$now"
  echo "$v"
}

# ---- collect ---------------------------------------------------------------

collect() {
  MEM_TOTAL=$(awk '/^MemTotal:/{print $2*1024}'     /proc/meminfo)
  MEM_AVAIL=$(awk '/^MemAvailable:/{print $2*1024}' /proc/meminfo)
  MEM_USED=$((MEM_TOTAL - MEM_AVAIL))
  MEM_PCT=$(awk -v u="$MEM_USED" -v t="$MEM_TOTAL" 'BEGIN{printf "%.1f", t?u*100/t:0}')

  SWAP_TOTAL=$(awk '/^SwapTotal:/{print $2*1024}' /proc/meminfo)
  SWAP_FREE=$(awk '/^SwapFree:/{print $2*1024}'  /proc/meminfo)
  SWAP_USED=$((SWAP_TOTAL - SWAP_FREE))
  SWAP_PCT=$(awk -v u="$SWAP_USED" -v t="$SWAP_TOTAL" 'BEGIN{printf "%.1f", t?u*100/t:0}')

  read -r LOAD1 LOAD5 LOAD15 _ < /proc/loadavg
  LOAD_PER_CORE=$(awk -v l="$LOAD1" -v n="$NCPU" 'BEGIN{printf "%.2f", l/n}')

  local dline; dline=$(df -P / | awk 'NR==2{gsub("%","",$5); print $3*1024, $2*1024, $5}')
  DISK_USED_H=$(human "$(echo "$dline" | awk '{print $1}')")
  DISK_SIZE_H=$(human "$(echo "$dline" | awk '{print $2}')")
  DISK_PCT=$(echo "$dline" | awk '{print $3}')

  UP=$(awk '{d=int($1/86400); h=int(($1%86400)/3600); printf "%dd %dh", d, h}' /proc/uptime)

  mapfile -t WOLF_ROWS < <(discover_wolves)
  mapfile -t SUPPORT   < <(discover_support)

  UNITS=()
  for row in "${WOLF_ROWS[@]}"; do [ -n "$row" ] && UNITS+=("${row%%$'\t'*}"); done
  for u in "${SUPPORT[@]}";   do [ -n "$u" ]   && UNITS+=("$u"); done

  # host CPU and per-unit CPU share one sampling window
  local ha hb ta tb snap_a snap_b
  ha=$(awk '/^cpu /{idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; print idle, tot}' /proc/stat)
  ta=$(date +%s.%N)
  snap_a=$(cpu_snapshot)
  sleep "$INTERVAL"
  tb=$(date +%s.%N)
  snap_b=$(cpu_snapshot)
  hb=$(awk '/^cpu /{idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; print idle, tot}' /proc/stat)

  # everything except CPU comes from a single batched read
  load_props "${UNITS[@]}"

  local -A SNAP_A SNAP_B
  while IFS=$'\t' read -r k v; do [ -n "$k" ] && SNAP_A["$k"]="$v"; done <<< "$snap_a"
  while IFS=$'\t' read -r k v; do [ -n "$k" ] && SNAP_B["$k"]="$v"; done <<< "$snap_b"

  HOST_CPU=$(awk -v a="$ha" -v b="$hb" 'BEGIN{
    split(a,x," "); split(b,y," ");
    di=y[1]-x[1]; dt=y[2]-x[2];
    printf "%.1f", (dt<=0) ? 0 : (1-di/dt)*100
  }')

  CPU_BY_UNIT=()
  for u in "${UNITS[@]}"; do
    CPU_BY_UNIT["$u"]=$(awk -v x="${SNAP_A[$u]:-0}" -v y="${SNAP_B[$u]:-0}" \
                            -v t0="$ta" -v t1="$tb" -v n="$NCPU" 'BEGIN{
      el=t1-t0; if(el<=0) el=1;
      d=y-x; if(d<0) d=0;
      printf "%.1f", (d/(el*1e9*n))*100
    }')
  done
}
declare -A CPU_BY_UNIT

cpu_for() { printf '%s' "${CPU_BY_UNIT[$1]:-0.0}"; }

# ---- render ----------------------------------------------------------------

render_human() {
  local ts; ts=$(date '+%Y-%m-%d %H:%M:%S')
  printf '%s🐺 WOLFPACK HEALTH%s  %s%s%s  %s%s%s\n' \
    "$B" "$R" "$CYA" "$HOSTNAME_S" "$R" "$DIM" "$ts" "$R"
  printf '%s\n' "────────────────────────────────────────────────────────────────────────────"

  local s
  s=$(sev "$HOST_CPU" "$CPU_WARN" "$CPU_CRIT"); bump "$s"
  printf '  %-8s %s  [%s]  %s vCPU\n' "CPU" \
    "$(paint "$(printf '%5s%%' "$HOST_CPU")" "$s")" "$(bar "$HOST_CPU")" "$NCPU"

  s=$(sev "$LOAD_PER_CORE" "$LOAD_WARN" "$LOAD_CRIT"); bump "$s"
  printf '  %-8s %s  %s / %s / %s  %s(1m per core)%s\n' "Load" \
    "$(paint "$(printf '%5s ' "$LOAD_PER_CORE")" "$s")" "$LOAD1" "$LOAD5" "$LOAD15" "$DIM" "$R"

  s=$(sev "$MEM_PCT" "$MEM_WARN" "$MEM_CRIT"); bump "$s"
  printf '  %-8s %s  [%s]  %s / %s   avail %s\n' "Memory" \
    "$(paint "$(printf '%5s%%' "$MEM_PCT")" "$s")" "$(bar "$MEM_PCT")" \
    "$(human "$MEM_USED")" "$(human "$MEM_TOTAL")" "$(human "$MEM_AVAIL")"

  s=$(sev "$SWAP_PCT" 25 60); bump "$s"
  printf '  %-8s %s  [%s]  %s / %s\n' "Swap" \
    "$(paint "$(printf '%5s%%' "$SWAP_PCT")" "$s")" "$(bar "$SWAP_PCT")" \
    "$(human "$SWAP_USED")" "$(human "$SWAP_TOTAL")"

  s=$(sev "$DISK_PCT" "$DISK_WARN" "$DISK_CRIT"); bump "$s"
  printf '  %-8s %s  [%s]  %s / %s\n' "Disk /" \
    "$(paint "$(printf '%5s%%' "$DISK_PCT")" "$s")" "$(bar "$DISK_PCT")" \
    "$DISK_USED_H" "$DISK_SIZE_H"

  printf '  %-8s %s\n' "Uptime" "$UP"

  printf '\n%sWOLVES%s\n' "$B" "$R"
  printf '  %-14s %-9s %7s %10s %7s %6s %5s %5s %5s\n' \
    NAME STATE CPU MEM "%HOST" TASKS RSTRT TMUX DEN
  if [ "${#WOLF_ROWS[@]}" -eq 0 ] || [ -z "${WOLF_ROWS[0]:-}" ]; then
    printf '  %sno wolves found on this host%s\n' "$DIM" "$R"
  fi
  local wolf_mem_sum=0 wolf_cpu_sum=0
  for row in "${WOLF_ROWS[@]}"; do
    [ -n "$row" ] || continue
    local unit name state mem mempct cpu tasks tm den ms cs restarts peak
    unit="${row%%$'\t'*}"; name="${row#*$'\t'}"
    state=$(unit_state "$unit")
    mem=$(unit_num "$unit" MemoryCurrent)
    tasks=$(unit_num "$unit" TasksCurrent)
    restarts=$(unit_num "$unit" NRestarts)
    peak=$(unit_num "$unit" MemoryPeak)
    cpu=$(cpu_for "$unit")
    mempct=$(awk -v m="$mem" -v t="$MEM_TOTAL" 'BEGIN{printf "%.1f", t?m*100/t:0}')
    wolf_mem_sum=$((wolf_mem_sum + mem))
    wolf_cpu_sum=$(awk -v a="$wolf_cpu_sum" -v b="$cpu" 'BEGIN{printf "%.1f", a+b}')
    tm=$(tmux_up "$name")
    den=$(den_size "$name")

    cs=$(sev "$cpu" "$CPU_WARN" "$CPU_CRIT")
    ms=$(sev "$mempct" 30 50)
    [ "$state" = "active" ] || bump 2
    [ "$tm" = "DOWN" ] && bump 2
    # An unattended restart means the wolf lost its session and resumed from a
    # checkpoint at best. Never silent, even when everything is green now.
    [ "$restarts" -gt 0 ] && bump 1

    printf '  %-14s %s %s %10s %s %6s %s %s %5s\n' \
      "$name" \
      "$( [ "$state" = active ] && printf '%s%-9s%s' "$GRN" "$state" "$R" || printf '%s%-9s%s' "$RED" "$state" "$R" )" \
      "$(paint "$(printf '%6s%%' "$cpu")" "$cs")" \
      "$(human "$mem")" \
      "$(paint "$(printf '%6s%%' "$mempct")" "$ms")" \
      "$tasks" \
      "$(paint "$(printf '%5s' "$restarts")" "$( [ "$restarts" -gt 0 ] && echo 1 || echo 0 )")" \
      "$( [ "$tm" = up ] && printf '%s%5s%s' "$GRN" up "$R" || printf '%s%5s%s' "$RED" "$tm" "$R" )" \
      "$den"
    if [ "$restarts" -gt 0 ]; then
      printf '  %s   ^ %s unattended restart(s); peak mem %s of %s%s\n' \
        "$DIM" "$restarts" "$(human "$peak")" "$(human "$MEM_TOTAL")" "$R"
    fi
  done

  if [ "${#SUPPORT[@]}" -gt 0 ] && [ -n "${SUPPORT[0]:-}" ]; then
    printf '\n%sSUPPORT%s %s(competing for the same %s vCPU)%s\n' "$B" "$R" "$DIM" "$NCPU" "$R"
    for u in "${SUPPORT[@]}"; do
      [ -n "$u" ] || continue
      local mem cpu tasks mempct
      mem=$(unit_num "$u" MemoryCurrent); tasks=$(unit_num "$u" TasksCurrent)
      cpu=$(cpu_for "$u")
      mempct=$(awk -v m="$mem" -v t="$MEM_TOTAL" 'BEGIN{printf "%.1f", t?m*100/t:0}')
      printf '  %-14s %-9s %6s%% %10s %6s%% %6s\n' \
        "${u%.service}" "$(unit_state "$u")" "$cpu" "$(human "$mem")" "$mempct" "$tasks"
    done
  fi

  printf '\n  %sPack total: %s CPU, %s memory (%s of host)%s\n' "$DIM" \
    "$(printf '%s%%' "$wolf_cpu_sum")" "$(human "$wolf_mem_sum")" \
    "$(awk -v m="$wolf_mem_sum" -v t="$MEM_TOTAL" 'BEGIN{printf "%.0f%%", t?m*100/t:0}')" "$R"

  case "$STATUS" in
    0) printf '  %sstatus: OK%s\n'       "$GRN" "$R" ;;
    1) printf '  %sstatus: WARNING%s\n'  "$YEL" "$R" ;;
    2) printf '  %sstatus: CRITICAL%s\n' "$RED" "$R" ;;
  esac
}

render_json() {
  local first=1
  printf '{"ts":"%s","host":"%s","ncpu":%s,' "$(date -Is)" "$HOSTNAME_S" "$NCPU"
  printf '"cpu_pct":%s,"load1":%s,"load5":%s,"load15":%s,"load_per_core":%s,' \
    "$HOST_CPU" "$LOAD1" "$LOAD5" "$LOAD15" "$LOAD_PER_CORE"
  printf '"mem_used":%s,"mem_total":%s,"mem_pct":%s,"mem_avail":%s,' \
    "$MEM_USED" "$MEM_TOTAL" "$MEM_PCT" "$MEM_AVAIL"
  printf '"swap_pct":%s,"swap_used":%s,"swap_total":%s,' "$SWAP_PCT" "$SWAP_USED" "$SWAP_TOTAL"
  printf '"disk_pct":%s,"disk_used_h":"%s","disk_size_h":"%s","uptime":"%s","wolves":[' \
    "$DISK_PCT" "$DISK_USED_H" "$DISK_SIZE_H" "$UP"
  for row in "${WOLF_ROWS[@]}"; do
    [ -n "$row" ] || continue
    local unit name state mem tasks cpu tm
    unit="${row%%$'\t'*}"; name="${row#*$'\t'}"
    state=$(unit_state "$unit")
    mem=$(unit_num "$unit" MemoryCurrent); tasks=$(unit_num "$unit" TasksCurrent)
    cpu=$(cpu_for "$unit"); tm=$(tmux_up "$name")
    local restarts peak den
    restarts=$(unit_num "$unit" NRestarts); peak=$(unit_num "$unit" MemoryPeak)
    den=$(den_size "$name")
    [ "$state" = "active" ] || bump 2
    [ "$tm" = "DOWN" ] && bump 2
    [ "$restarts" -gt 0 ] && bump 1
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{"name":"%s","unit":"%s","state":"%s","cpu_pct":%s,"mem_bytes":%s,"mem_pct":%s,"tasks":%s,"restarts":%s,"mem_peak_bytes":%s,"tmux":"%s","den":"%s"}' \
      "$name" "$unit" "$state" "$cpu" "$mem" \
      "$(awk -v m="$mem" -v t="$MEM_TOTAL" 'BEGIN{printf "%.1f", t?m*100/t:0}')" "$tasks" "$restarts" "$peak" "$tm" "$den"
  done

  # The support units share the host's 2 vCPU with the wolves, so /health has
  # to show them for the CPU numbers above to mean anything.
  printf '],"support":['
  first=1
  for u in "${SUPPORT[@]}"; do
    [ -n "$u" ] || continue
    local smem stasks scpu
    smem=$(unit_num "$u" MemoryCurrent); stasks=$(unit_num "$u" TasksCurrent)
    scpu=$(cpu_for "$u")
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{"name":"%s","state":"%s","cpu_pct":%s,"mem_bytes":%s,"mem_pct":%s,"tasks":%s}' \
      "${u%.service}" "$(unit_state "$u")" "$scpu" "$smem" \
      "$(awk -v m="$smem" -v t="$MEM_TOTAL" 'BEGIN{printf "%.1f", t?m*100/t:0}')" "$stasks"
  done
  bump "$(sev "$HOST_CPU" "$CPU_WARN" "$CPU_CRIT")"
  bump "$(sev "$MEM_PCT" "$MEM_WARN" "$MEM_CRIT")"
  bump "$(sev "$DISK_PCT" "$DISK_WARN" "$DISK_CRIT")"
  printf '],"status":%s}\n' "$STATUS"
}

run_once() {
  STATUS=0
  collect
  if [ "$JSON" -eq 1 ]; then render_json; else render_human; fi
}

if [ "$WATCH" -eq 1 ]; then
  # Each frame takes ~1s to gather (the CPU sample window). Clearing the screen
  # first would leave it blank for that whole second, so the frame is rendered
  # to a buffer while the previous one stays on screen, then swapped in.
  FRAME=$(mktemp) || { echo "wolf-health: cannot create frame buffer" >&2; exit 1; }
  ALT=0
  restore() {                                      # idempotent
    [ "$ALT" = 1 ] && printf '\e[?25h\e[?1049l'   # show cursor, leave alt screen
    ALT=0
  }
  # Leaving the alt screen discards everything drawn there, so the last frame is
  # reprinted on the normal screen — the reading survives quitting. Order
  # matters: restore, print, *then* delete the buffer.
  on_signal() {
    restore
    [ -s "$FRAME" ] && cat "$FRAME"
    rm -f "$FRAME"
    exit 0
  }
  trap on_signal INT TERM
  trap 'restore; rm -f "$FRAME"' EXIT

  if [ -t 1 ]; then
    printf '\e[?1049h\e[?25l'   # alt screen, hide cursor
    ALT=1
  fi

  while :; do
    STATUS=0
    run_once > "$FRAME"
    # \e[?2026h/l is synchronized output: terminals that support it apply the
    # whole repaint at once instead of tearing. Others ignore it harmlessly.
    printf '\e[?2026h\e[H\e[J'
    cat "$FRAME"
    printf '\e[?2026l'
    sleep "$WATCH_EVERY"
  done
else
  run_once
fi
exit "$STATUS"
