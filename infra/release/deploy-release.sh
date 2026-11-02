#!/usr/bin/env bash
# Host-side release deploy (C3). Runs AS ROOT on the host; needs only bash, curl, sha256sum, GNU tar, systemctl (+ journalctl for the health check).
# Designed to be piped: `ssh host sudo bash -s -- wolfd 0.1.2 --wolf hal2 < deploy-release.sh`. All code is inside main() and `main "$@"` is the
# last line, so bash has parsed the whole script before running anything; nothing inside reads stdin (every external command gets </dev/null).
#
#   deploy-release.sh <wolfd|hubd|workerd> <X.Y.Z> [--wolf <name>] [--dry-run] [--health-timeout SEC] [--settle SEC]
#
# wolfd (needs --wolf): download -> verify sha256 -> inspect tar members -> unpack into a root-owned 0700 staging dir -> chown -> VERSION check
#   -> switch (release -> release.prev -> older prev kept as release.prev-<ver>-<ts>) -> restart wolfd@<name> -> health check -> automatic swap-back.
# hubd|workerd: same download/verify/inspect/VERSION steps, then the release's own `setup.sh install --bundle` (it keeps `previous`);
#   rollback uses the setup.sh installed by an earlier deploy ($OPT/setup.sh), or swaps current/previous itself when there is none.
# Health (wolfd): unit active, serving line `wolfd: <name> serving unix:/run/wolfd-<name>/serve.sock` in THIS invocation's journal, `-p err` empty,
#   InvocationID and NRestarts unchanged across a settle (a crash loop fails). hubd/workerd: active + same checks + the port accepts a connection.
# Exit: 0 ok / no-op, 1 refused or failed before any change, 2 usage, 3 deploy failed and rolled back, 4 failed AND rollback unhealthy / manual recovery.
# Recovery: a run that finds `release` missing (killed mid-swap) restores release.prev (or the newest release.prev-*) first.
# Test seams (DEPLOY_BASE_URL, DEPLOY_SYSTEMCTL, DEPLOY_JOURNALCTL, DEPLOY_HOME_ROOT, DEPLOY_OPT_ROOT, DEPLOY_ENV_DIR, DEPLOY_LOG) are honoured ONLY when DEPLOY_TEST=1.
# Never prints .env values or tokens.
set -uo pipefail
trap '' PIPE HUP   # an ssh disconnect must not kill a half-done switch

main() {
  local PROD_URL="https://github.com/1uk4/wolfpack/releases/download"
  local BASE_URL="$PROD_URL" HOME_ROOT=/home OPT_ROOT=/opt ENV_DIR=/etc/wolfpack LOGF=/var/log/deploy-release.log TMPROOT=/tmp LOCKDIR=/run
  local SYSTEMCTL=systemctl JOURNALCTL=journalctl CGLS=systemd-cgls PROTO='=https'
  if [ "${DEPLOY_TEST:-}" = 1 ]; then
    BASE_URL="${DEPLOY_BASE_URL:-$PROD_URL}"; HOME_ROOT="${DEPLOY_HOME_ROOT:-/home}"; OPT_ROOT="${DEPLOY_OPT_ROOT:-/opt}"
    ENV_DIR="${DEPLOY_ENV_DIR:-/etc/wolfpack}"; LOGF="${DEPLOY_LOG:-$LOGF}"
    TMPROOT="${DEPLOY_TMP:-/tmp}"; LOCKDIR="${DEPLOY_LOCK_DIR:-/run}"
    SYSTEMCTL="${DEPLOY_SYSTEMCTL:-systemctl}"; CGLS="${DEPLOY_CGLS:-systemd-cgls}"; JOURNALCTL="${DEPLOY_JOURNALCTL:-journalctl}"; PROTO='=http,https'
  fi
  local COMP="" VER="" WOLF="" UNITSEL=auto UNITSET=0 WUSHA="" DRY=0 HTIMEOUT=60 SETTLE=6
  log() { echo "deploy: $*"; }
  die() { echo "deploy: REFUSED: $1" >&2; exit "${2:-1}"; }
  usage() {
    cat >&2 <<'USAGE'
usage: deploy-release.sh <wolfd|hubd|workerd> <X.Y.Z> [--wolf <name>] [--unit link|wolves|both] [--wolfd-unit-sha256 HEX] [--dry-run] [--health-timeout SEC] [--settle SEC]
  wolfd needs --wolf <name>; hubd/workerd must not have it. --unit (workerd only): link = workerd.service (default; auto means link), wolves = workerd-wolves.service, both. wolves/both restart workerd-wolves and are opt-in. Run as root (not needed for --dry-run).
USAGE
    exit 2
  }
  sc() { "$SYSTEMCTL" "$@" </dev/null 9>&-; }   # 9>&-: children never inherit the deploy lock
  jc() { "$JOURNALCTL" "$@" </dev/null 9>&-; }

  # Member policy (see README). Prints OK, or "BAD: <why>". Input: a tarball path.
  inspect_tar() {
    local listing
    listing=$(tar --quoting-style=escape --numeric-owner -tvzf "$1" </dev/null 9>&-) || { echo "BAD: cannot list the tarball"; return 0; }
    printf '%s\n' "$listing" | awk '
      function bad(m) { print "BAD: " m; failed = 1; exit 1 }
      function count(str, pat,   c, i) { c = 0; while ((i = index(str, pat)) > 0) { c++; str = substr(str, i + length(pat)) } return c }
      function resolve(dir, t,   p, n, i, st, sp, seg, out) {
        if (t ~ /^\//) return "!"
        n = split(dir "/" t, p, "/"); sp = 0
        for (i = 1; i <= n; i++) { seg = p[i]
          if (seg == "" || seg == ".") continue
          if (seg == "..") { if (sp == 0) return "!"; sp-- } else st[++sp] = seg }
        out = ""; for (i = 1; i <= sp; i++) out = out (i > 1 ? "/" : "") st[i]
        return out
      }
      {
        t = substr($0, 1, 1)
        if (t == "c" || t == "b" || t == "p" || t == "s") bad("device/fifo/socket member")
        line = $0; sub(/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ /, "", line)
        if (line ~ /\\/) bad("member name with escaped or control characters")
        name = line; target = ""
        arrows = count(line, " -> ") + count(line, " link to ")
        if (t == "l" || t == "h") {
          if (arrows != 1) bad("ambiguous link line (more than one link separator)")
          if (t == "l") { i = index(line, " -> "); if (!i) bad("unparsable symlink line"); name = substr(line, 1, i - 1); target = substr(line, i + 4) }
          else { i = index(line, " link to "); if (!i) bad("unparsable hardlink line"); name = substr(line, 1, i - 1); target = substr(line, i + 9) }
          if (name ~ / /) bad("link member name contains a space")
        } else if (arrows > 0) bad("member name looks like a link line")
        sub(/^\.\//, "", name); sub(/\/$/, "", name)
        if (name == "" || name == ".") next
        if (name ~ /^\// || name ~ /(^|\/)\.\.(\/|$)/) bad("absolute or parent-relative member name")
        if (name ~ /\/\// || name ~ /(^|\/)\.(\/|$)/) bad("non-canonical member name (// or . component)")
        n = split(name, pp, "/"); pre = ""
        for (j = 1; j < n; j++) { pre = pre (j > 1 ? "/" : "") pp[j]; if (pre in sym) bad("member written beneath a symlink") }
        if (t == "l") {
          dir = name; if (dir ~ /\//) sub(/\/[^\/]*$/, "", dir); else dir = ""
          if (resolve(dir, target) == "!") bad("symlink target is absolute or escapes the tree")
          sym[name] = 1
        } else if (t == "h") {
          tn = target; sub(/^\.\//, "", tn)
          if (tn ~ /^\// || tn ~ /(^|\/)\.\.(\/|$)/ || !(tn in files)) bad("hardlink target is not an earlier member of this archive")
          files[name] = 1
        } else if (t == "-") files[name] = 1
      }
      END { if (!failed) print "OK" }'
  }
  # After extraction: every symlink must canonicalise (readlink -m, so dangling-but-inside links are fine) to a path under the extraction dir.
  contained_check() { # <dir>; 0 = ok
    local xr l r
    xr=$(readlink -f "$1") || return 1
    while IFS= read -r -d '' l; do
      r=$(readlink -m "$l" </dev/null 9>&-) || return 1
      [[ $r == "$xr" || $r == "$xr"/* ]] || { echo "symlink ${l#"$xr"/} resolves outside the release"; return 1; }
    done < <(find "$xr" -type l -print0 </dev/null)
    return 0
  }

  local INSPECT=""
  while (($#)); do
    case "$1" in
      --inspect-only) [ "${DEPLOY_TEST:-}" = 1 ] || usage; INSPECT="${2:-}"; shift ;;
      --wolf) WOLF="${2:-}"; shift ;;
      --unit) UNITSEL="${2:-}"; UNITSET=1; shift ;;
      --wolfd-unit-sha256) WUSHA="${2:-}"; shift ;;
      --dry-run) DRY=1 ;;
      --health-timeout) HTIMEOUT="${2:-}"; shift ;;
      --settle) SETTLE="${2:-}"; shift ;;
      -h|--help) usage ;;
      -*) echo "deploy: unknown option $1" >&2; usage ;;
      *) if [ -z "$COMP" ]; then COMP=$1; elif [ -z "$VER" ]; then VER=$1; else usage; fi ;;
    esac
    shift
  done
  if [ -n "$INSPECT" ]; then # test-only (DEPLOY_TEST=1): run the member policy + extraction containment on a tarball, change nothing
    local iv it; iv=$(inspect_tar "$INSPECT"); echo "inspect: $iv"; [ "$iv" = OK ] || exit 1
    it=$(mktemp -d "$TMPROOT/deploy-inspect.XXXXXX") || exit 1
    tar -xzf "$INSPECT" --no-same-owner --no-same-permissions --no-overwrite-dir -C "$it" </dev/null 9>&- && contained_check "$it"; iv=$?
    rm -rf --one-file-system -- "$it"; echo "contained: rc=$iv"; exit "$iv"
  fi
  [ -n "$COMP" ] && [ -n "$VER" ] || usage
  VER="${VER#v}"
  case "$COMP" in wolfd|hubd|workerd) ;; *) die "unknown component '$COMP' (wolfd|hubd|workerd)" 2 ;; esac
  [[ $VER =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be X.Y.Z, got '$VER'" 2
  [[ $HTIMEOUT =~ ^[0-9]+$ && $SETTLE =~ ^[0-9]+$ ]] || die "--health-timeout/--settle must be integers" 2
  local USR="" HOME_DIR="" UNIT="" REL="" PREV="" ENVF="" SOCK="" OPT="" SVC=""
  if [ "$COMP" = wolfd ]; then
    [[ $WOLF =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "wolfd needs --wolf <name> (lowercase, digits, -)" 2
    ((${#WOLF} <= 27)) || die "wolf name too long (max 27 chars: the Linux user wolf-<name> is limited to 32)" 2
    USR="wolf-$WOLF"; HOME_DIR="$HOME_ROOT/$USR"; UNIT="wolfd@$WOLF.service"
    REL="$HOME_DIR/release"; PREV="$HOME_DIR/release.prev"; ENVF="$HOME_DIR/.env"; SOCK="/run/wolfd-$WOLF/serve.sock"
    id "$USR" >/dev/null 2>&1 </dev/null || die "no Linux user $USR (provision the wolf first: infra/wolves/provision-wolf.sh)"
  else
    [ -z "$WOLF" ] || die "--wolf only applies to wolfd" 2
    SVC="$COMP.service"; OPT="$OPT_ROOT/wolfpack-$COMP"
  fi
  case "$UNITSEL" in auto|link|wolves|both) ;; *) die "--unit must be link|wolves|both" 2 ;; esac
  [ "$COMP" = workerd ] || [ "$UNITSET" = 0 ] || die "--unit only applies to workerd" 2
  [ -z "$WUSHA" ] || [[ $WUSHA =~ ^[0-9a-f]{64}$ ]] || die "--wolfd-unit-sha256 must be 64 hex chars" 2
  [ "$UNITSEL" != auto ] || UNITSEL=link   # auto means link: workerd-wolves is only ever restarted on request
  local WOLVES_DIR="$OPT_ROOT/wolfpack-workerd-wolves"
  if [ "$COMP" != wolfd ] && ((!DRY)); then # deploy only upgrades: refuse a host that was never set up (first install is `setup.sh setup`, an owner step)
    if [ "$UNITSEL" != wolves ] && ! { [ -L "$OPT/current" ] && [ -e "$OPT/current" ]; }; then
      die "no existing $COMP install ($OPT/current is missing): deploy only upgrades. First install: unpack the release and run 'bash $COMP/setup.sh setup' then 'install --bundle' yourself (see infra/release/README.md)"
    fi
    if [ "$UNITSEL" != link ] && [ "$COMP" = workerd ]; then
      [ -d "$WOLVES_DIR" ] || die "no existing workerd-wolves install ($WOLVES_DIR is missing): not set up (infra/wolves/README.md); use --unit link"
      [ -L "$WOLVES_DIR/current" ] || die "$WOLVES_DIR/current is not a symlink (expected releases/<id>); refusing to touch workerd-wolves"
      [ -e "$WOLVES_DIR/current" ] || die "$WOLVES_DIR/current is a dangling symlink; refusing to touch workerd-wolves"
    fi
  fi
  ((DRY)) || [ "$(id -u)" = 0 ] || die "run as root (or --dry-run)" 2

  local TAG="$COMP/v$VER" ASSET="$COMP-v$VER-linux-x64.tar.gz"
  local URL="$BASE_URL/$TAG/$ASSET"
  umask 022

  cur_version() { # <dir> -> X.Y.Z of <dir>/VERSION, or fail
    local f=$1/VERSION v; [ -f "$f" ] || return 1
    v=$(head -n1 "$f" </dev/null); [[ $v =~ ^([0-9]+\.[0-9]+\.[0-9]+) ]] || return 1
    echo "${BASH_REMATCH[1]}"
  }

  local -a SEL=()
  # SEL = full paths of release.<kind>-<ver>-<UTC ts> dirs in the wolf home, newest first BY THE TIMESTAMP IN THE NAME (not mtime).
  # Bash glob + strict name regex + real dirs only (no symlinks): a wolf-writable home can hold any name, including ones with newlines.
  sel_dirs() { # <prev|failed>
    local d b k
    local -a keyed=()
    SEL=()
    for d in "$HOME_DIR"/release."$1"-*; do
      [ -d "$d" ] && [ ! -L "$d" ] || continue
      b=${d##*/}
      [[ $b =~ ^release\.(prev|failed)-[0-9A-Za-z.]+-([0-9]{8}T[0-9]{6}Z)$ ]] || continue
      [ "${BASH_REMATCH[1]}" = "$1" ] || continue
      keyed+=("${BASH_REMATCH[2]} $d")
    done
    ((${#keyed[@]})) || return 0
    while IFS= read -r k; do SEL+=("${k#* }"); done < <(printf '%s\n' "${keyed[@]}" | LC_ALL=C sort -r)
  }

  if ((DRY)); then
    log "DRY RUN for $TAG: nothing is downloaded, written or restarted"
    log "  download  $URL (+ .sha256) into a fresh mktemp -d (curl --proto =https, TLS1.2+)"
    log "  verify    sha256 file names $ASSET and its hash matches; tar members inspected (no devices/fifos, no link escaping the tree)"
    if [ "$COMP" = wolfd ]; then
      local have; have=$(cur_version "$REL" 2>/dev/null || echo none)
      [ -d "$REL" ] || [ ! -d "$HOME_DIR" ] || log "  recovery  $REL is missing: the real run restores release.prev first"
      log "  guard     refuse if $ENVF sets ANTHROPIC_API_KEY (name only reported); $HOME_DIR must be a real dir owned by $USR"
      log "  current   $have -> $VER ($([ "$have" = "$VER" ] && echo 'no-op: already running' || echo 'would deploy'))"
      log "  unpack    root-owned 0700 staging dir, chown $USR; VERSION must start with $VER"
      log "  switch    release.prev -> release.prev-<ver>-<ts> (newest 2 kept); release -> release.prev; staged -> release"
      log "  restart   systemctl restart $UNIT; health <= ${HTIMEOUT}s: serving line for the new InvocationID, no err journal, stable for ${SETTLE}s"
      log "  failure   swap back, restart, re-check, exit 3"
    else
      log "  install   bash <unpacked>/$COMP/setup.sh install --bundle <unpacked>/$COMP   (keeps 'previous'); service was-active is recorded first"
      [ "$COMP" = workerd ] && log "  units     --unit $UNITSEL (auto = link): link = workerd.service (setup.sh), wolves = workerd-wolves.service (own $WOLVES_DIR; same workerd.mjs, wolfd-unit.sh carried over, restarted by this script after the link unit is healthy; refused unless current is a symlink and systemd-cgls shows only workerd.mjs/wolfd-unit.sh/sleep; active wolfd@*/wolf-*.service must keep their InvocationID+MainPID, else rc 4). A real run refuses when an install dir has no 'current' (first install is setup.sh setup)"
      log "  health    $SVC active, no err journal, stable for ${SETTLE}s, port accepts a connection <= ${HTIMEOUT}s; failure after the flip -> rollback, exit 3"
    fi
    exit 0
  fi

  # ---- logging (tee: survives an ssh disconnect because SIGPIPE/HUP are ignored)
  if : >>"$LOGF" 2>/dev/null; then
    local TEEOPT=""
    tee --output-error=warn-nopipe /dev/null </dev/null >/dev/null 2>&1 && TEEOPT="--output-error=warn-nopipe"
    # shellcheck disable=SC2086
    exec > >(tee -a $TEEOPT "$LOGF") 2>&1
    chmod 600 "$LOGF" 2>/dev/null || true
    log "=== $(date -u +%FT%TZ) deploy $TAG${WOLF:+ wolf=$WOLF} (log: $LOGF)"
  else
    echo "deploy: WARNING cannot write $LOGF; continuing without a log file" >&2
  fi

  command -v flock >/dev/null || die "flock (util-linux) is required"
  exec 9>"$LOCKDIR/deploy-release-$COMP-${WOLF:-host}.lock" || die "cannot open the lock file in $LOCKDIR"
  flock -n 9 || die "deploy already running for $COMP${WOLF:+ $WOLF} (lock $LOCKDIR/deploy-release-$COMP-${WOLF:-host}.lock)"
  command -v curl >/dev/null && command -v sha256sum >/dev/null && command -v tar >/dev/null || die "need curl, sha256sum, tar"
  local tv; tv=$(tar --version </dev/null 2>&1 | head -n1)
  [[ $tv == *"GNU tar"* ]] || die "GNU tar required to inspect archive members (got: $tv)"

  local TMP="" STAGE="" SAVED="" HAD_REL=0 cm=""
  cleanup() { [ -n "$TMP" ] && rm -rf --one-file-system -- "$TMP"; [ -n "$STAGE" ] && rm -rf --one-file-system -- "$STAGE"; return 0; }
  trap cleanup EXIT

  # ---- wolfd: preconditions + crash recovery (before anything is downloaded)
  local have=""
  if [ "$COMP" = wolfd ]; then
    [ -d "$HOME_DIR" ] && [ ! -L "$HOME_DIR" ] || die "$HOME_DIR is missing or a symlink"
    [ "$(stat -c %U "$HOME_DIR")" = "$USR" ] || die "$HOME_DIR is not owned by $USR"
    [ ! -L "$REL" ] && [ ! -L "$PREV" ] || die "release / release.prev must be plain directories, not symlinks"
    [ -f "$ENVF" ] || die "$ENVF missing"
    if grep -Eq '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=[^[:space:]"'"'"']' "$ENVF" </dev/null; then
      die "ANTHROPIC_API_KEY is set in $ENVF; a wolfd wolf never runs on a metered key (value not shown). Remove it first."
    fi
    local lo
    for lo in "$HOME_DIR"/.release.new.* "$HOME_DIR"/.deploy-stage-"$WOLF".* "$HOME_ROOT"/.deploy-stage-"$WOLF".*; do
      if [ -e "$lo" ] || [ -L "$lo" ]; then log "removing leftover $lo"; rm -rf --one-file-system -- "$lo"; fi
    done
    if [ ! -e "$REL" ]; then
      local cand=""
      if [ -d "$PREV" ] && [ ! -L "$PREV" ]; then cand=$PREV
      else sel_dirs prev; cand=${SEL[0]:-}; fi
      if [ -n "$cand" ] && [ -f "$cand/launch.sh" ]; then
        log "RECOVERY: $REL is missing (an earlier run died mid-switch); restoring $(basename "$cand")"
        mv -T "$cand" "$REL" || { log "recovery mv failed; manual: mv -T $cand $REL"; exit 4; }
        sc restart "$UNIT" || log "WARNING: restart after recovery failed"
      else
        log "$REL is missing and there is nothing to recover from (first install)"
      fi
    fi
    have=$(cur_version "$REL" 2>/dev/null || true)
    if [ "$have" = "$VER" ]; then
      local st; st=$(sc is-active "$UNIT" 2>/dev/null || true)
      log "no-op: $WOLF already runs wolfd $VER; unit is ${st:-unknown}"
      [ "$st" = active ] || log "WARNING: the unit is not active. This script does not touch a running version; check: systemctl status $UNIT"
      exit 0
    fi
    log "$WOLF: ${have:-none} -> $VER"
  fi

  TMP=$(mktemp -d "$TMPROOT/deploy-release.XXXXXX") || die "mktemp failed"
  fetch() { curl -fsSL --proto "$PROTO" --proto-redir "$PROTO" --tlsv1.2 --max-time 120 -o "$2" "$1" </dev/null; }
  log "download $URL"
  fetch "$URL" "$TMP/$ASSET" || die "download failed: $URL"
  fetch "$URL.sha256" "$TMP/$ASSET.sha256" || die "no $ASSET.sha256 published (refusing an unverified release)"
  [ -s "$TMP/$ASSET" ] || die "empty download"
  local line want name got
  line=$(head -n1 "$TMP/$ASSET.sha256" </dev/null)
  want=${line%% *}; name=${line##* }; name=${name#\*}
  [[ $want =~ ^[0-9a-f]{64}$ ]] || die "malformed .sha256 file"
  [ "$name" = "$ASSET" ] || die "component/version mismatch: .sha256 names '$name', expected '$ASSET'"
  got=$(sha256sum "$TMP/$ASSET" </dev/null | cut -d' ' -f1)
  [ "$got" = "$want" ] || die "sha256 mismatch for $ASSET (expected ${want:0:12}…, got ${got:0:12}…)"
  log "sha256 ok ${want:0:12}…"

  # ---- member inspection (GNU tar listing). Real releases DO contain relative symlinks (node_modules/.bin -> ../x) and hardlinks (esbuild),
  # so links are validated, not banned: no devices/fifos/sockets; a symlink must be relative and stay inside the tree; a hardlink must name an
  # EARLIER regular member of the same archive; no member may be written beneath a symlink; no absolute or `..` member names; no escaped/odd names.
  local verdict
  verdict=$(inspect_tar "$TMP/$ASSET")
  [ "$verdict" = OK ] || die "unsafe tar member (${verdict#BAD: })"

  # ---- stage: root-owned 0700, same filesystem as the wolf home when possible, then chown and rename into place
  if [ "$COMP" = wolfd ]; then
    [ "$(stat -c %d "$HOME_ROOT" </dev/null)" = "$(stat -c %d "$HOME_DIR" </dev/null)" ] \
      || die "$HOME_DIR is on a different filesystem than $HOME_ROOT (a separate mount): an atomic same-filesystem staging rename is impossible; refusing rather than staging inside the wolf-writable home"
    STAGE=$(mktemp -d "$HOME_ROOT/.deploy-stage-$WOLF.XXXXXX")
    [ -n "$STAGE" ] && [ -d "$STAGE" ] || die "cannot create a staging dir"
    chmod 700 "$STAGE"
    local X="$STAGE/rel"; mkdir "$X"
  else
    STAGE=$(mktemp -d "$TMPROOT/deploy-stage.XXXXXX") || die "mktemp failed"
    chmod 700 "$STAGE"; local X="$STAGE/x"; mkdir "$X"
  fi
  tar -xzf "$TMP/$ASSET" --no-same-owner --no-same-permissions --no-overwrite-dir -C "$X" </dev/null || die "unpack failed"
  [ -z "$(find "$X" ! -type f ! -type d ! -type l -print -quit </dev/null)" ] || die "unpacked tree has special files"
  cm=$(contained_check "$X") || die "unsafe symlink after extraction (${cm:-unresolvable})"
  check_version() { # <dir>
    [ -f "$1/VERSION" ] || die "VERSION missing in the release"
    local v; v=$(head -n1 "$1/VERSION" </dev/null)
    [ "${v%%+*}" = "$VER" ] || die "VERSION mismatch: tarball says '$v', requested $VER"
  }

  # ======================================================================== hubd / workerd
  if [ "$COMP" != wolfd ]; then
    local B="$X/$COMP"
    [ -f "$B/setup.sh" ] || die "$COMP/setup.sh not in the release"
    check_version "$B"
    chmod -R u-s,g-s "$X"
    local since irc=0 n i
    # Per-unit state, index-aligned. Unit LINK is the component's own service (hubd, or the link-only workerd) and is installed by the release's
    # setup.sh. Unit WOLVES (workerd only, opt-in) is workerd-wolves: its own install dir, env file and port, NOT known to setup.sh, so this script
    # installs the same workerd.mjs there itself (carrying wolfd-unit.sh over) and restarts it. LINK is deployed and health-checked first, then WOLVES.
    # If either fails, every unit whose release actually changed is rolled back; units that did not change are never restarted.
    local -a U_SVC=("$SVC") U_OPT=("$OPT") U_ENV=("$ENV_DIR/$COMP.env") U_PFX=("${COMP^^}") U_HOST=("") U_WAS=() U_IID=() U_CURB=() U_CHG=() U_NOREST=()
    if [ "$UNITSEL" != link ] && [ "$COMP" = workerd ]; then
      U_SVC+=(workerd-wolves.service); U_OPT+=("$WOLVES_DIR"); U_ENV+=("$ENV_DIR/workerd-wolves.env"); U_PFX+=(WORKERD); U_HOST+=(127.0.0.1)
    fi
    [ "$UNITSEL" != wolves ] || { U_SVC=("${U_SVC[1]}"); U_OPT=("${U_OPT[1]}"); U_ENV=("${U_ENV[1]}"); U_PFX=("${U_PFX[1]}"); U_HOST=("${U_HOST[1]}"); }
    n=${#U_SVC[@]}
    local LINK=-1 WOLVES=-1
    for ((i = 0; i < n; i++)); do case "${U_SVC[i]}" in workerd-wolves.service) WOLVES=$i ;; *) LINK=$i ;; esac; done
    log "unit set: ${U_SVC[*]} (--unit $UNITSEL$([ "$UNITSET" = 1 ] || echo ', default'))"
    for ((i = 0; i < n; i++)); do
      U_WAS[i]=0; U_NOREST[i]=0; U_IID[i]=""; U_CHG[i]=0
      sc is-active --quiet "${U_SVC[i]}" 2>/dev/null && U_WAS[i]=1
      U_CURB[i]=$(readlink -f "${U_OPT[i]}/current" 2>/dev/null || true)
      [ "${U_WAS[i]}" = 1 ] && U_IID[i]=$(sc show -p InvocationID --value "${U_SVC[i]}" 2>/dev/null || true)
      log "${U_SVC[i]} was $([ "${U_WAS[i]}" = 1 ] && echo active || echo NOT active) before the deploy"
    done

    # ---- supervised-wolf survival: what workerd-wolves supervises must outlive its restart (wolfd@* and wolf-*.service are their own units)
    local -a SNAP=()
    snap_take() { # "unit|InvocationID|MainPID" of every active wolfd@*.service and wolf-*.service
      SNAP=(); local u _r
      while read -r u _r; do
        [ -n "$u" ] || continue
        SNAP+=("$u|$(sc show -p InvocationID --value "$u" 2>/dev/null || true)|$(sc show -p MainPID --value "$u" 2>/dev/null || true)")
      done < <(sc list-units 'wolfd@*.service' 'wolf-*.service' --state=active --plain --no-legend --no-pager 2>/dev/null)
    }
    snap_ok() { # same units active with the same InvocationID and MainPID
      local e u iid pid ci cp rc=0
      for e in ${SNAP[@]+"${SNAP[@]}"}; do
        IFS='|' read -r u iid pid <<<"$e"
        if ! sc is-active --quiet "$u" 2>/dev/null; then log "SURVIVAL: $u is no longer active"; rc=1; continue; fi
        ci=$(sc show -p InvocationID --value "$u" 2>/dev/null || true); cp=$(sc show -p MainPID --value "$u" 2>/dev/null || true)
        [ "$ci" = "$iid" ] && [ "$cp" = "$pid" ] || { log "SURVIVAL: $u was restarted or replaced (InvocationID/MainPID changed)"; rc=1; }
      done
      return $rc
    }
    cgls_check() { # only workerd.mjs, wolfd-unit.sh and short-lived sleep/systemctl children may live in workerd-wolves.service's cgroup
      local out odd
      command -v "$CGLS" >/dev/null 2>&1 || { log "$CGLS not found: cannot verify what runs inside workerd-wolves.service"; return 1; }
      out=$("$CGLS" --no-pager -l -u workerd-wolves.service </dev/null 9>&- 2>&1) || { log "$CGLS failed for workerd-wolves.service"; return 1; }
      odd=$(printf '%s\n' "$out" | awk '{ if (match($0, /[0-9]+ /)) { pre = substr($0, 1, RSTART - 1); if (pre !~ /[A-Za-z]/) { cmd = substr($0, RSTART + RLENGTH)
        if (cmd !~ /workerd\.mjs/ && cmd !~ /wolfd-unit\.sh/ && cmd !~ /^(\/usr\/bin\/|\/bin\/)?(sleep|systemctl)( |$)/) print cmd } } }')
      [ -z "$odd" ] || { log "workerd-wolves.service's cgroup holds processes other than workerd.mjs / wolfd-unit.sh / sleep (a restart (KillMode=control-group) would kill them):"; printf '%s\n' "$odd" | head -n 5 | sed 's/^/deploy:   /'; return 1; }
    }
    if [ "$WOLVES" -ge 0 ] && [ "${U_WAS[WOLVES]}" = 1 ]; then
      cgls_check || die "refusing to restart workerd-wolves.service: its cgroup is not just workerd (nothing changed). Use --unit link."
      snap_take; log "survival snapshot taken: ${#SNAP[@]} active wolfd@*/wolf-* unit(s)"
    fi

    # ---- workerd-wolves install (no setup.sh for it). rc 0 = flipped, 1 = failed with nothing left changed here.
    wolves_install() {
      local o=${U_OPT[WOLVES]} ver rel="" live node out old cur prev p got ro
      ver=$(head -n1 "$B/VERSION" </dev/null)
      ro=$(readlink -f "$o" 2>/dev/null || true)
      [ -d "$o" ] && [ ! -L "$o" ] && [ -d "$o/releases" ] && [ ! -L "$o/releases" ] || { log "$o or $o/releases is missing or a symlink"; return 1; }
      live=$(readlink -f "$o/current" 2>/dev/null) || { log "$o/current does not resolve"; return 1; }
      [ -d "$live" ] && [ ! -L "$live" ] && [[ $live == "$ro"/releases/* ]] || { log "live release $live is not a real directory under $o/releases"; return 1; }
      for p in "$o" "$o/releases" "$live"; do [ "$(stat -c %u "$p" </dev/null)" = 0 ] || { log "$p is not root-owned"; return 1; }; done
      [ -f "$live/wolfd-unit.sh" ] && [ ! -L "$live/wolfd-unit.sh" ] || { log "no regular (non-symlink) wolfd-unit.sh in the live workerd-wolves release ($live); the release tarball does not ship it"; return 1; }
      got=$(sha256sum "$live/wolfd-unit.sh" </dev/null | cut -d' ' -f1)
      if [ -n "$WUSHA" ] && [ "$got" != "$WUSHA" ]; then log "WARNING: the live wolfd-unit.sh (${got:0:12}…) differs from infra/wolves/wolfd-unit.sh (${WUSHA:0:12}…); it is carried over unchanged"
      elif [ -z "$WUSHA" ]; then log "note: carrying wolfd-unit.sh ${got:0:12}… over unchanged; compare with sha256sum infra/wolves/wolfd-unit.sh"; fi
      node=$(command -v node || true); [ -n "$node" ] || { log "node not found"; return 1; }
      rel="$o/releases/$(date -u +%Y%m%dT%H%M%SZ)-$ver"
      install -d -m 0755 "$rel" && install -m 0644 "$B/workerd.mjs" "$B/RUNBOOK.md" "$B/VERSION" "$rel/" && install -m 0755 "$live/wolfd-unit.sh" "$rel/" \
        || { rm -rf "$rel"; log "cannot populate $rel"; return 1; }
      out=$("$node" "$rel/workerd.mjs" --help 2>&1 </dev/null || true)
      [[ $out == usage:* ]] || { rm -rf "$rel"; log "workerd-wolves bundle failed its smoke test; nothing changed there"; return 1; }
      cur=$(readlink "$o/current")
      { ln -sfn "$live" "$o/previous.new" && mv -T "$o/previous.new" "$o/previous" && ln -sfn "$rel" "$o/current.new" && mv -T "$o/current.new" "$o/current"; } \
        || { rm -f "$o/previous.new" "$o/current.new"; ln -sfn "$cur" "$o/current.new" && mv -T "$o/current.new" "$o/current"; rm -rf "$rel"; log "cannot flip $o/current; restored"; return 1; }
      return 0
    }
    wolves_prune() { # after success only: keep the newest 5, never current/previous
      local o=${U_OPT[WOLVES]} cur prev old
      cur=$(readlink -f "$o/current"); prev=$(readlink -f "$o/previous" 2>/dev/null || true)
      # shellcheck disable=SC2012
      ls -1dt "$o"/releases/* 2>/dev/null </dev/null | tail -n +6 | while read -r old; do [ "$old" = "$cur" ] || [ "$old" = "$prev" ] || rm -rf "$old"; done
    }

    unit_port_ok() { # <i>: the unit's env-file port accepts a connection (retried ~5s); hubd must additionally answer HTTP 401 to an unauthenticated /v1/wolves
      local f=${U_ENV[$1]} pf=${U_PFX[$1]} h p code="" tries=0 up=0
      if [ ! -r "$f" ]; then log "note: $f not readable; listening check skipped"; return 0; fi
      h=$(sed -n "s/^${pf}_HOST=//p" "$f" </dev/null | tail -n1); p=$(sed -n "s/^${pf}_PORT=//p" "$f" </dev/null | tail -n1)
      [ -n "$h" ] || h=${U_HOST[$1]}
      [ "$h" != localhost ] || h=127.0.0.1
      [[ $h =~ ^[0-9.]+$ && $p =~ ^[0-9]+$ ]] || { log "note: no usable IPv4/localhost host or numeric port in $f (host '${h:-none}'); listening check skipped"; return 0; }
      while ((tries < 5)); do
        if (exec 3<>"/dev/tcp/$h/$p") 2>/dev/null </dev/null; then up=1; break; fi
        tries=$((tries + 1)); sleep 1
      done
      [ $up = 1 ] || { log "nothing is listening on $h:$p"; return 1; }
      if [ "$COMP" = hubd ]; then
        # hubd has no health route; every route but POST /v1/pair answers 401 before 404, so an unauthenticated GET proves the HTTP app is up.
        # (A 401 here is not counted by hubd's failed-pairing limiter, which only watches POST /v1/pair, and writes no ledger/audit entry.)
        command -v curl >/dev/null 2>&1 || { log "note: curl is missing; hubd HTTP probe skipped (port check only)"; return 0; }
        tries=0
        while ((tries < 5)); do
          code=$(curl --noproxy '*' -s -o /dev/null -m 5 -w '%{http_code}' "http://$h:$p/v1/wolves" </dev/null 9>&- 2>/dev/null || true)
          [ "$code" = 401 ] && return 0
          tries=$((tries + 1)); sleep 1
        done
        log "hubd on $h:$p answered HTTP '${code:-none}' to an unauthenticated /v1/wolves (expected 401)"; return 1
      fi
      return 0
    }
    unit_healthy() { # <i>
      local svc=${U_SVC[$1]} t=0 iid iid2 nr1 nr2 errs
      while ((t <= HTIMEOUT)); do
        if sc is-active --quiet "$svc" 2>/dev/null; then
          iid=$(sc show -p InvocationID --value "$svc" 2>/dev/null || true); nr1=$(sc show -p NRestarts --value "$svc" 2>/dev/null || true)
          sleep "$SETTLE"
          sc is-active --quiet "$svc" 2>/dev/null || { log "$svc died during settle"; return 1; }
          iid2=$(sc show -p InvocationID --value "$svc" 2>/dev/null || true); nr2=$(sc show -p NRestarts --value "$svc" 2>/dev/null || true)
          [ "$iid" = "$iid2" ] && [ "$nr1" = "$nr2" ] || { log "$svc restarted during settle (crash loop)"; return 1; }
          if [ -n "$iid" ]; then errs=$(jc "_SYSTEMD_INVOCATION_ID=$iid" -p err --no-pager -q 2>/dev/null || true)
          else errs=$(jc -u "$svc" -p err --since "@$since" --no-pager -q 2>/dev/null || true); fi
          [ -z "$errs" ] || { log "journal has errors for $svc's invocation"; return 1; }
          unit_port_ok "$1" || return 1
          return 0
        fi
        sleep 1; t=$((t + 1))
      done
      log "$svc not active within ${HTIMEOUT}s"; return 1
    }
    swap_links() { # <opt>: swap current/previous by hand
      local o=$1 cur prev
      [ -L "$o/previous" ] || { log "no $o/previous"; return 1; }
      cur=$(readlink -f "$o/current"); prev=$(readlink -f "$o/previous")
      ln -sfn "$prev" "$o/current.new" && mv -T "$o/current.new" "$o/current" || return 1
      ln -sfn "$cur" "$o/previous.new" && mv -T "$o/previous.new" "$o/previous" || return 1
    }
    # Roll back every unit whose release CHANGED (independent swaps), then restart + re-check exactly those that rolled back and were running.
    # Never exits early leaving a rolled-back unit un-restarted. rc 3 = rolled back healthy, rc 4 = something needs a human.
    fail_rollback() {
      local rc=0 i o
      local -a RB=()
      log "FAILED; rolling back the changed unit(s) only"
      if [ "$LINK" -ge 0 ] && [ "${U_CHG[LINK]}" = 1 ]; then
        o=${U_OPT[LINK]}
        if [ -f "$o/setup.sh" ]; then
          log "rollback ${U_SVC[LINK]} via the installed $o/setup.sh"
          if bash "$o/setup.sh" rollback </dev/null 9>&-; then RB+=("$LINK")
          else log "installed setup.sh rollback failed; swapping links myself"; if swap_links "$o"; then RB+=("$LINK"); else log "link swap failed for $o"; rc=1; fi; fi
        else
          log "no installed setup.sh yet; swapping $o/current and previous myself"
          if swap_links "$o"; then RB+=("$LINK"); else log "link swap failed for $o"; rc=1; fi
        fi
      fi
      if [ "$WOLVES" -ge 0 ] && [ "${U_CHG[WOLVES]}" = 1 ]; then
        log "rollback ${U_SVC[WOLVES]}: swapping ${U_OPT[WOLVES]}/current and previous"
        if swap_links "${U_OPT[WOLVES]}"; then RB+=("$WOLVES"); else log "link swap failed for ${U_OPT[WOLVES]}"; rc=1; fi
      fi
      sleep 1; since=$(date +%s)
      local ran=0
      for i in ${RB[@]+"${RB[@]}"}; do
        [ "${U_WAS[i]}" = 1 ] || continue
        ran=1; sc reset-failed "${U_SVC[i]}" >/dev/null 2>&1 || true
        sc restart "${U_SVC[i]}" || { log "restart of ${U_SVC[i]} after rollback failed"; rc=1; }
      done
      if [ "$WOLVES" -ge 0 ] && [ "${U_CHG[WOLVES]}" = 1 ] && [ "${U_WAS[WOLVES]}" = 1 ] && [ ${#SNAP[@]} -gt 0 ]; then
        snap_ok || { log "SURVIVAL FAILED after the rollback restart; no further automatic restarts"; rc=1; }
      fi
      for i in ${RB[@]+"${RB[@]}"}; do
        [ "${U_WAS[i]}" = 1 ] || continue
        unit_healthy "$i" || rc=1
      done
      if [ $rc != 0 ]; then log "ROLLBACK INCOMPLETE OR UNHEALTHY: ${U_SVC[*]} need a human"; exit 4; fi
      if [ $ran = 0 ]; then log "no changed unit was running before the deploy; rolled back and left stopped"; exit 3; fi
      log "rolled back; $COMP healthy again"; exit 3
    }

    # ---- phase 1: the link unit (hubd, or the link-only workerd) via the release's own setup.sh
    since=$(date +%s)
    if [ "$LINK" -ge 0 ]; then
      log "setup.sh install (keeps previous for rollback)"
      bash "$B/setup.sh" install --bundle "$B" </dev/null 9>&- || irc=$?
      since=$(date +%s)
      [ "$(readlink -f "${U_OPT[LINK]}/current" 2>/dev/null || true)" != "${U_CURB[LINK]}" ] && U_CHG[LINK]=1
      if [ $irc != 0 ] && [ "${U_CHG[LINK]}" = 0 ]; then
        log "install failed (rc=$irc) and ${U_OPT[LINK]}/current did not change: the old release is still live; nothing to roll back"; exit 1
      fi
      [ $irc = 0 ] || log "install exited rc=$irc AFTER flipping ${U_OPT[LINK]}/current: treating the deploy as failed"
      if [ $irc = 0 ] && [ "${U_WAS[LINK]}" = 1 ] && [ -n "${U_IID[LINK]}" ] \
        && [ "$(sc show -p InvocationID --value "${U_SVC[LINK]}" 2>/dev/null || true)" = "${U_IID[LINK]}" ]; then
        U_NOREST[LINK]=1; log "${U_SVC[LINK]} was active but its InvocationID did not change: install did not restart it, so the new release is not running. Treating the deploy as failed."
      fi
      if [ $irc != 0 ] || [ "${U_NOREST[LINK]}" = 1 ]; then fail_rollback; fi
      if [ "${U_WAS[LINK]}" = 1 ]; then unit_healthy "$LINK" || fail_rollback
      else log "${U_SVC[LINK]} was not running before this deploy and is left stopped: installed $VER, no health check possible. Start when ready: systemctl start ${U_SVC[LINK]}"; fi
    fi

    # ---- phase 2: workerd-wolves (opt-in), only after the link unit is healthy
    if [ "$WOLVES" -ge 0 ]; then
      if wolves_install; then
        U_CHG[WOLVES]=1; log "${U_SVC[WOLVES]}: ${U_OPT[WOLVES]}/current -> $(basename "$(readlink -f "${U_OPT[WOLVES]}/current")")"
      elif [ "$LINK" -ge 0 ]; then log "workerd-wolves install failed: ${U_SVC[WOLVES]} is NOT restarted; undoing the link unit"; fail_rollback
      else log "workerd-wolves install failed before any change: nothing to roll back"; exit 1; fi
      if [ "${U_WAS[WOLVES]}" = 1 ]; then
        since=$(date +%s)
        sc reset-failed "${U_SVC[WOLVES]}" >/dev/null 2>&1 || true
        sc restart "${U_SVC[WOLVES]}" || { log "restart of ${U_SVC[WOLVES]} failed"; fail_rollback; }
        if ! snap_ok; then
          log "SURVIVAL FAILED: the workerd-wolves restart disturbed supervised wolf units. NOT rolling back or restarting anything else (a human must decide). Releases: ${U_OPT[WOLVES]}/current is $VER, previous kept."
          exit 4
        fi
        if [ -n "${U_IID[WOLVES]}" ] && [ "$(sc show -p InvocationID --value "${U_SVC[WOLVES]}" 2>/dev/null || true)" = "${U_IID[WOLVES]}" ]; then
          log "${U_SVC[WOLVES]} InvocationID did not change after the restart"; fail_rollback
        fi
        unit_healthy "$WOLVES" || fail_rollback
      else
        log "${U_SVC[WOLVES]} was not running before this deploy and is left stopped: installed $VER, no health check possible. Start when ready: systemctl start ${U_SVC[WOLVES]}"
      fi
      wolves_prune
    fi
    if [ "$LINK" -ge 0 ]; then install -m 0755 "$B/setup.sh" "${U_OPT[LINK]}/setup.sh" || log "note: could not save ${U_OPT[LINK]}/setup.sh (rollback will swap links itself)"; fi
    log "OK: $COMP $VER deployed (${U_SVC[*]})"; exit 0
  fi

  # ======================================================================== wolfd
  check_version "$X"
  [ -f "$X/launch.sh" ] || die "launch.sh not in the release"
  chmod +x "$X/launch.sh"
  chown -R -h "$USR:$USR" "$X" || die "chown failed"
  chmod -R u-s,g-s "$X" || die "chmod failed"
  log "staged $(head -n1 "$X/VERSION" </dev/null) (owner $USR); nothing has changed yet"

  local TS pv oldver
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  oldver=${have:-none}
  if [ -d "$PREV" ]; then
    pv=$(cur_version "$PREV" 2>/dev/null || true); [ -n "$pv" ] || pv=unknown
    SAVED="$HOME_DIR/release.prev-$pv-$TS"
  fi
  # -------- the switch: three renames, each checked
  if [ -n "$SAVED" ]; then mv -T "$PREV" "$SAVED" || die "cannot set aside $PREV (nothing changed)"; fi
  if [ -d "$REL" ]; then
    HAD_REL=1
    mv -T "$REL" "$PREV" || { [ -n "$SAVED" ] && mv -T "$SAVED" "$PREV"; die "cannot move $REL aside (nothing changed)"; }
  fi
  if ! mv -T "$X" "$REL"; then
    log "FATAL: cannot move the staged release into place"
    [ $HAD_REL = 1 ] && { mv -T "$PREV" "$REL" || { log "manual: mv -T $PREV $REL"; exit 4; }; }
    [ -n "$SAVED" ] && { mv -T "$SAVED" "$PREV" || log "manual: mv -T $SAVED $PREV"; }
    exit 4
  fi
  log "switched: release=$VER, release.prev=$oldver${SAVED:+ (older prev kept as $(basename "$SAVED"))}"

  local SINCE=0
  wolf_healthy() { # <timeout>
    local to=$1 t=0 iid iid2 nr1 nr2 st jl errs
    SINCE=$(date +%s)
    sc reset-failed "$UNIT" >/dev/null 2>&1 || true
    sc restart "$UNIT" || { log "systemctl restart failed"; return 1; }
    iid=$(sc show -p InvocationID --value "$UNIT" 2>/dev/null || true)
    jlog() { if [ -n "$iid" ]; then jc "_SYSTEMD_INVOCATION_ID=$iid" --no-pager -q "$@" 2>/dev/null; else jc -u "$UNIT" --since "@$SINCE" --no-pager -q "$@" 2>/dev/null; fi; }
    while ((t <= to)); do
      st=$(sc is-active "$UNIT" 2>/dev/null || true)
      [ "$st" = failed ] && { log "unit is failed"; return 1; }
      if [ "$st" = active ]; then
        jl=$(jlog || true)
        if [[ $jl == *"wolfd: $WOLF serving unix:$SOCK"* ]]; then
          nr1=$(sc show -p NRestarts --value "$UNIT" 2>/dev/null || true)
          sleep "$SETTLE"
          [ "$(sc is-active "$UNIT" 2>/dev/null || true)" = active ] || { log "unit died during settle"; return 1; }
          iid2=$(sc show -p InvocationID --value "$UNIT" 2>/dev/null || true); nr2=$(sc show -p NRestarts --value "$UNIT" 2>/dev/null || true)
          [ "$iid" = "$iid2" ] && [ "$nr1" = "$nr2" ] || { log "unit restarted during settle (crash loop)"; return 1; }
          errs=$(jlog -p err || true)
          [ -z "$errs" ] || { log "journal has errors since the restart"; return 1; }
          return 0
        fi
      fi
      sleep 1; t=$((t + 1))
    done
    log "no serving line within ${to}s (unit ${st:-unknown})"; return 1
  }
  prune() { # keep the newest 2 of release.prev-* and release.failed-* (by the timestamp in the name)
    local k i
    for k in prev failed; do
      sel_dirs "$k"
      for ((i = 2; i < ${#SEL[@]}; i++)); do rm -rf --one-file-system -- "${SEL[i]}"; done
    done
  }

  if wolf_healthy "$HTIMEOUT"; then
    prune
    log "OK: $UNIT runs wolfd $VER (previous $oldver kept in release.prev)"
    exit 0
  fi
  log "FAILED: rolling back to $oldver"
  local BAD="$HOME_DIR/release.failed-$VER-$TS"
  mv -T "$REL" "$BAD" || { log "FATAL: cannot move the failed release aside; manual: swap $REL and $PREV"; exit 4; }
  if [ $HAD_REL = 1 ]; then mv -T "$PREV" "$REL" || { log "FATAL: cannot restore; manual: mv -T $PREV $REL"; exit 4; }; fi
  if [ -n "$SAVED" ]; then mv -T "$SAVED" "$PREV" || log "WARNING: could not restore the older prev; manual: mv -T $SAVED $PREV"; fi
  log "failed release kept for inspection at $BAD"
  if [ $HAD_REL = 0 ]; then log "no previous release to restore; $UNIT is down"; exit 4; fi
  sleep 1   # journalctl --since has 1 s resolution
  if wolf_healthy "$HTIMEOUT"; then prune; log "rolled back: $UNIT healthy on $oldver"; exit 3; fi
  log "ROLLBACK UNHEALTHY: $UNIT needs a human"; exit 4
}

main "$@"
