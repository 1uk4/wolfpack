#!/usr/bin/env bash
# Build wolfd-<version>-linux-<arch>.tar.gz in Linux Docker (Mac or Linux host). Never run on the droplet.
#   (--version X.Y.Z: release build, file wolfd-vX.Y.Z-linux-<arch>.tar.gz; VERSION = release-version.mjs --release: "X.Y.Z" at the tag, else "X.Y.Z+<sha>")
#   scripts/build-wolfd-release.sh [--arch x64|arm64] [--out DIR] [--with-cli]   (--with-cli: bake the pinned claude CLI in, +310 MB)     default arch x64 (the DigitalOcean droplet), out dist-release/
set -euo pipefail
ARCH=x64; OUT=dist-release; WITH_CLI=0; REL=
while [ $# -gt 0 ]; do case "$1" in --arch) ARCH=$2; shift 2;; --out) OUT=$2; shift 2;; --with-cli) WITH_CLI=1; shift;; --version) REL=$2; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
case "$ARCH" in x64) PLAT=linux/amd64;; arm64) PLAT=linux/arm64;; *) echo "arch must be x64|arm64" >&2; exit 2;; esac
cd "$(dirname "$0")/.."
# VERSION (read by wolfd's /healthz): with --version, the release stamp; else the nearest wolfd/vX.Y.Z tag version (scripts/release-version.mjs),
# "<package version>-dev+<sha>" when untagged.
if [ -n "$REL" ]; then
  NAME="v$REL"
  VERSION="$(node scripts/release-version.mjs wolfd --release "$REL")"
else
  SHA=$(git rev-parse --short HEAD); PKG=$(node -p "require('./packages/harness/package.json').version")
  NAME="$PKG-$SHA"
  VERSION="$(node scripts/release-version.mjs wolfd || echo "$PKG-dev+$SHA")"
fi
mkdir -p "$OUT"
IMG="wolfd-release-build:$ARCH"
docker build --platform "$PLAT" -f infra/release/Dockerfile --build-arg RELEASE_VERSION="$VERSION" --build-arg WITH_CLI="$WITH_CLI" -t "$IMG" .
CID=$(docker create --platform "$PLAT" "$IMG")
trap 'docker rm -f "$CID" >/dev/null' EXIT
FILE="$OUT/wolfd-$NAME-linux-$ARCH.tar.gz"
docker cp "$CID:/out/release.tar.gz" "$FILE"
# Hard rule: templates only, never a value.
if tar -tzf "$FILE" | grep -E '(^|/)\.env$' >/dev/null; then echo "FATAL: tarball contains a .env" >&2; rm -f "$FILE"; exit 1; fi
echo "$FILE ($(du -h "$FILE" | cut -f1))"
