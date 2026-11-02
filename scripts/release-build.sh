#!/usr/bin/env bash
# Build ONE component's linux-x64 release asset, version-stamped. Runs at release time only (release.yml) or by hand.
#   scripts/release-build.sh <component> <version X.Y.Z> <out-dir>
# Writes <out>/<asset> and <out>/<asset>.sha256 (sha256sum format). VERSION inside the artifact: "<version>+<short sha>".
# Asset names come from scripts/release-components.json. To add `console`: add it there and add a case below.
set -euo pipefail
COMP=${1:?component}; VER=${2:?version}; OUT=${3:?out dir}
cd "$(dirname "$0")/.."
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z, got $VER" >&2; exit 2; }
ASSET=$(node -e 'const c=require("./scripts/release-components.json")[process.argv[1]];if(!c){console.error("unknown component "+process.argv[1]);process.exit(2)};console.log(c.asset.replace("{version}",process.argv[2]))' "$COMP" "$VER")
SHA=$(git rev-parse --short HEAD)
STAMP="$VER+$SHA"
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
  *) echo "no build recipe for $COMP" >&2; exit 2;;
esac
[ -f "$OUT/$ASSET" ] || { echo "expected $OUT/$ASSET was not produced" >&2; exit 1; }
node scripts/release-guard.mjs "$OUT/$ASSET"
(cd "$OUT" && { sha256sum "$ASSET" 2>/dev/null || shasum -a 256 "$ASSET"; } > "$ASSET.sha256")
echo "built $OUT/$ASSET ($STAMP)"; cat "$OUT/$ASSET.sha256"
