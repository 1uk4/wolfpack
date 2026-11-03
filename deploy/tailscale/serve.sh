#!/usr/bin/env bash
# `tailscale serve` routes for sfo-01: console at the origin root, hubd under /hub, HTTPS on 443, tailnet only.
#   serve.sh [--dry-run] on  [--hub-upstream URL] [--console-upstream URL]
#   serve.sh [--dry-run] status
#   serve.sh [--dry-run] off          (removes exactly the two routes this script adds)
# Run as root (or a tailscale operator) ON sfo-01, only after the owner confirms. --dry-run prints the commands and runs nothing.
#
# UNVERIFIED (written without a tailscale binary; the syntax is the 1.52+ `serve` CLI: --bg, --https=PORT, --set-path=PATH, TARGET, `off`).
# Check once on the host with `tailscale version` and `tailscale serve --help` before `on`. Any line marked UNVERIFIED in RUNBOOK.md is a
# step-(b) acceptance check, not an assumption to rely on.
#
# Path stripping: for `--set-path=/hub http://UPSTREAM`, tailscale serve proxies a request for /hub/<rest> to http://UPSTREAM/<rest> (the mount
# path is removed). UNVERIFIED for: `/hub/pair` (no trailing slash) arriving as `/pair`, `/hub/v1/events` (SSE) arriving as `/v1/events` and
# streaming unbuffered, and bare `/hub` arriving as `/`. hubd's pair page derives its POST path from location.pathname, so it works with the
# prefix stripped and with or without a trailing slash; the console (at /) never sees /hub/*, because the longest matching path wins.
set -euo pipefail
DRY=0 CMD="" HUB=http://100.120.154.69:3150 CONSOLE=http://127.0.0.1:3200
TS=${TAILSCALE:-tailscale}
die() { echo "serve.sh: $*" >&2; exit 1; }
run() { if ((DRY)); then printf 'DRY-RUN:'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }
while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --hub-upstream) HUB="${2:?--hub-upstream needs a URL}"; shift ;;
    --console-upstream) CONSOLE="${2:?--console-upstream needs a URL}"; shift ;;
    on | status | off) CMD=$1 ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done
[[ -n $CMD ]] || die "usage: serve.sh [--dry-run] on|status|off [--hub-upstream URL] [--console-upstream URL]"
[[ $HUB =~ ^http://(127\.0\.0\.1|100\.[0-9]+\.[0-9]+\.[0-9]+):[0-9]+$ ]] || die "--hub-upstream must be http://127.0.0.1:PORT or http://<tailscale ip>:PORT"
[[ $CONSOLE =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || die "--console-upstream must be http://127.0.0.1:PORT"
((DRY)) || command -v "$TS" >/dev/null 2>&1 || die "tailscale not found"

case "$CMD" in
  on)
    # NEVER `tailscale funnel`: funnel publishes to the internet. serve is tailnet-only.
    # Order: hub first (so /hub never falls through to the console), then the root. --bg keeps the config after this shell exits.
    run "$TS" serve --bg --https=443 --set-path=/hub "$HUB"
    run "$TS" serve --bg --https=443 --set-path=/ "$CONSOLE"
    echo "now: serve.sh status; then from a tailnet device: curl -sI https://<host>.ts.net/ and curl -s -o /dev/null -w '%{http_code}\n' https://<host>.ts.net/hub/v1/wolves (expect 401)"
    ;;
  status)
    run "$TS" serve status
    ;;
  off)
    # Only our two routes. Do NOT use `serve reset` (it wipes every serve/funnel route on the node).
    run "$TS" serve --https=443 --set-path=/hub off
    run "$TS" serve --https=443 --set-path=/ off
    echo "routes removed; 'serve.sh status' should show no handlers for these paths. Then hubd is again reachable only at its tailnet IP:port."
    ;;
esac
