#!/usr/bin/env bash
# wolfd launcher (ships in the release tarball). Loads the wolf's .env (what systemd EnvironmentFile= does too), enforces the
# billing guards, then execs the bundled wolfd with the bundled node_modules. Uses no npm and nothing outside the release.
#   env: WOLF_HOME (default $HOME)  WOLF_ENV_FILE (default $WOLF_HOME/.env)  WOLF_CONFIG (default $WOLF_HOME/wolf.yaml)
#   extra args are passed to wolfd (e.g. --socket PATH | --port N)
set -euo pipefail
REL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WOLF_HOME="${WOLF_HOME:-$HOME}"
ENV_FILE="${WOLF_ENV_FILE:-$WOLF_HOME/.env}"
CONFIG="${WOLF_CONFIG:-$WOLF_HOME/wolf.yaml}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "launch.sh: FATAL ANTHROPIC_API_KEY is set; a wolfd wolf never runs on a metered key (the claude CLI would prefer it). Unset it." >&2; exit 78
fi
[ -f "$CONFIG" ] || { echo "launch.sh: $CONFIG missing" >&2; exit 1; }
transport="${WOLF_TRANSPORT:-}"
if [ -z "$transport" ] && [ -f "$(dirname "$CONFIG")/models.json" ]; then
  transport="$(sed -n 's/.*"transport"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$(dirname "$CONFIG")/models.json" | head -1)"
fi
if [ "$transport" = subscription ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "launch.sh: FATAL transport is subscription but CLAUDE_CODE_OAUTH_TOKEN is not set in $ENV_FILE" >&2; exit 78
fi
# Extension bundles: this release carries the bundles it was built with (extensions/<dir>/index.js, extensions/KEYS = "key dir" lines,
# extensions/STAMP = "<version> <content hash>"). wolfd loads $WOLF_HOME/den/extensions/<dir>/index.js, which nothing else refreshes, so
# install them here, before wolfd starts. launch.sh ships per release, so a rollback to release.prev runs the old one and puts the old
# bundles back. Which dirs: the ones the den already has plus the keys in wolf.yaml `extensions:` (inline [a, b] or a block list),
# mapped to dirs through KEYS. Skipped when the den's .release-stamp has the same content hash (the version part is ignored).
# Nothing is deleted: the old dir is MOVED to den/extensions.bak-<UTC ts>; the newest 3 stay in den/, older ones are moved into
# den/extensions.bak-old/. A crash between the two moves (den/extensions missing) is healed by restoring the newest backup, and a
# half-built .extensions.new-* is moved aside to .extensions.stale-*. Any failure is logged and wolfd starts on the existing extensions.
extension_keys() {
  awk '
    /^extensions:/ { v=$0; sub(/^extensions:[ \t]*/, "", v)
      if (match(v, /\[[^]]*\]/)) { s=substr(v, RSTART+1, RLENGTH-2); n=split(s, a, ","); for (i=1;i<=n;i++) print a[i]; blk=0 } else blk=1; next }
    blk && /^[ \t]*-([ \t]|$)/ { v=$0; sub(/^[ \t]*-[ \t]*/, "", v); sub(/[ \t]*#.*/, "", v); print v; next }
    blk && /^[ \t]*(#.*)?$/ { next }
    { blk=0 }
  ' "$1" 2>/dev/null | tr -d "\"' \t" | grep -v '^$' || true
}
refresh_extensions() {
  local src="$REL/extensions" den="$WOLF_HOME/den" ext stamp hash cur ts n new d k b newest keys want=""
  [ -f "$src/STAMP" ] || return 0
  ext="$den/extensions"; stamp="$(cat "$src/STAMP")"; hash="${stamp##* }"
  if [ -d "$den" ]; then
    if [ ! -d "$ext" ]; then
      newest="$(find "$den" -maxdepth 1 -type d -name 'extensions.bak-*' ! -name extensions.bak-old | LC_ALL=C sort | tail -1)"
      if [ -n "$newest" ] && mv "$newest" "$ext"; then echo "launch.sh: den/extensions was missing; restored $(basename "$newest")" >&2; fi
    fi
    while IFS= read -r b; do mv "$b" "$den/.extensions.stale-$$-$(basename "$b" | tr -d '.')" 2>/dev/null || true
    done < <(find "$den" -maxdepth 1 -type d -name '.extensions.new-*')
  fi
  cur="$(cat "$ext/.release-stamp" 2>/dev/null || true)"
  [ "${cur##* }" != "$hash" ] || return 0
  ts="$(date -u +%Y%m%d%H%M%S)"; n=0
  # never mv into an existing backup, nor reuse a name already moved to bak-old (the newest backup must sort last)
  while [ -e "$den/extensions.bak-$ts" ] || [ -e "$den/extensions.bak-old/extensions.bak-$ts" ]; do n=$((n + 1)); ts="$(date -u +%Y%m%d%H%M%S)-$(printf %02d "$n")"; done
  new="$den/.extensions.new-$ts"
  if [ -d "$ext" ]; then
    while IFS= read -r d; do want="$want$d"$'\n'; done < <(find "$ext" -mindepth 1 -maxdepth 1 -type d -exec basename {} \;)
  fi
  keys="$(extension_keys "$CONFIG")"
  if [ -z "$keys" ] && grep -q '^extensions:' "$CONFIG" 2>/dev/null; then echo "launch.sh: wolf.yaml has extensions: but no keys could be read from it" >&2; fi
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    d="$(awk -v k="$k" '$1 == k { print $2; exit }' "$src/KEYS" 2>/dev/null || true)"
    [ -n "$d" ] || d="$k"
    want="$want$d"$'\n'
  done <<< "$keys"
  rm -rf "$new" && mkdir -p "$new" || return 1
  if [ -d "$ext" ]; then cp -R "$ext"/. "$new"/ || { rm -rf "$new"; return 1; }; fi
  while IFS= read -r d; do
    case "$d" in ""|.*|*/*) continue ;; esac
    [ -f "$src/$d/index.js" ] || continue
    rm -rf "${new:?}/$d" && cp -R "$src/$d" "$new/$d" || { rm -rf "$new"; return 1; }
  done < <(printf '%s' "$want" | LC_ALL=C sort -u)
  chmod -R u+rwX,go+rX-w "$new" 2>/dev/null || true
  printf '%s' "$stamp" > "$new/.release-stamp" || { rm -rf "$new"; return 1; }
  if [ -d "$ext" ]; then mv "$ext" "$den/extensions.bak-$ts" || { rm -rf "$new"; return 1; }; fi
  mv "$new" "$ext" || { [ ! -d "$den/extensions.bak-$ts" ] || mv "$den/extensions.bak-$ts" "$ext"; return 1; }
  n=0
  while IFS= read -r b; do
    n=$((n + 1))
    if [ "$n" -gt 3 ]; then mkdir -p "$den/extensions.bak-old" && mv "$b" "$den/extensions.bak-old/" || true; fi
  done < <(find "$den" -maxdepth 1 -type d -name 'extensions.bak-*' ! -name extensions.bak-old | LC_ALL=C sort -r)
}
refresh_extensions || echo "launch.sh: extensions NOT refreshed (could not install this release's bundles into $WOLF_HOME/den/extensions; starting wolfd on the existing ones)" >&2

export PATH="$REL/tools/node_modules/.bin:$REL/tools/bin:$PATH"
exec node "$REL/packages/harness/dist/bin/wolfd.js" --config "$CONFIG" "$@"
