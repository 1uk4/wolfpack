#!/usr/bin/env bash
# Build ONE component's linux-x64 release asset, version-stamped. Runs at release time only (release.yml) or by hand.
#   scripts/release-build.sh <component> <version X.Y.Z> <out-dir>
# Writes <out>/<asset> and <out>/<asset>.sha256 (sha256sum format). VERSION inside the artifact: scripts/release-version.mjs --release,
# so "<version>" when HEAD is the <component>/v<version> tag (release.yml) and "<version>+<short sha>" for a by-hand build off the tag.
# Asset names come from scripts/release-components.json. 
set -euo pipefail
COMP=${1:?component}; VER=${2:?version}; OUT=${3:?out dir}
cd "$(dirname "$0")/.."
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z, got $VER" >&2; exit 2; }
ASSET=$(node -e 'const c=require("./scripts/release-components.json")[process.argv[1]];if(!c){console.error("unknown component "+process.argv[1]);process.exit(2)};console.log(c.asset.replace("{version}",process.argv[2]))' "$COMP" "$VER")
STAMP=$(node scripts/release-version.mjs "$COMP" --release "$VER")
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
case "$COMP" in
  wolfd)
    scripts/build-wolfd-release.sh --arch x64 --version "$VER" --out "$OUT"
    ;;
  workerd|hubd)
    npx tsc --build
    STAGE=$(mktemp -d)
    node "deploy/$COMP/build-bundle.mjs" "$STAGE/$COMP"
    cp "deploy/$COMP"/{setup.sh,"$COMP.service","$COMP.env.example"} "$STAGE/$COMP/"
    printf '%s\n' "$STAMP" > "$STAGE/$COMP/VERSION"
    tar -czf "$OUT/$ASSET" -C "$STAGE" "$COMP"
    rm -rf "$STAGE"
    ;;
  console)
    # Next standalone server + .next/static + public + traced node_modules (scripts/build-server.mjs), wrapped in the bundle layout deploy/console/setup.sh expects:
    #   console/{setup.sh,console.service,console.env.example,RUNBOOK.md,VERSION,app/{server.js,apps/,node_modules/,...}}
    # node_modules are traced from the BUILD host, so this must run on linux-x64 (release.yml's ubuntu runner). A Mac build would ship darwin natives.
    if [ "$(uname -s)-$(uname -m)" != Linux-x86_64 ] && [ "${CONSOLE_ALLOW_FOREIGN_BUILD:-}" != 1 ]; then
      echo "console must be built on linux-x86_64 (got $(uname -s)-$(uname -m)); CONSOLE_ALLOW_FOREIGN_BUILD=1 overrides for local proofs only" >&2; exit 2
    fi
    npx tsc --build
    STAGE=$(mktemp -d)
    node scripts/build-server.mjs --out "$STAGE/console/app"
    cp deploy/console/{setup.sh,console.service,console.env.example,RUNBOOK.md,50-console-restart.rules,wolfpack-rollback@.service} infra/release/deploy-release.sh "$STAGE/console/"
    printf '%s\n' "$STAMP" > "$STAGE/console/VERSION"
    rm -f "$STAGE/console/app/VERSION"; printf '%s\n' "$STAMP" > "$STAGE/console/app/VERSION"
    scripts/smoke-console-release.sh "$STAGE/console/app"
    tar -czf "$OUT/$ASSET" -C "$STAGE" console
    rm -rf "$STAGE"
    ;;
  *) echo "no build recipe for $COMP" >&2; exit 2;;
esac
[ -f "$OUT/$ASSET" ] || { echo "expected $OUT/$ASSET was not produced" >&2; exit 1; }
node scripts/release-guard.mjs "$OUT/$ASSET"
(cd "$OUT" && { sha256sum "$ASSET" 2>/dev/null || shasum -a 256 "$ASSET"; } > "$ASSET.sha256")
echo "built $OUT/$ASSET ($STAMP)"; cat "$OUT/$ASSET.sha256"
