#!/usr/bin/env bash
# Build wolfd-<version>-linux-<arch>.tar.gz in Linux Docker (Mac or Linux host). Never run on the droplet.
#   (--version X.Y.Z: release build; VERSION file = "X.Y.Z+<sha>", file wolfd-vX.Y.Z-linux-<arch>.tar.gz)
#   scripts/build-wolfd-release.sh [--arch x64|arm64] [--out DIR] [--with-cli]   (--with-cli: bake the pinned claude CLI in, +310 MB)     default arch x64 (the DigitalOcean droplet), out dist-release/
set -euo pipefail
ARCH=x64; OUT=dist-release; WITH_CLI=0; REL=
while [ $# -gt 0 ]; do case "$1" in --arch) ARCH=$2; shift 2;; --out) OUT=$2; shift 2;; --with-cli) WITH_CLI=1; shift;; --version) REL=$2; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
case "$ARCH" in x64) PLAT=linux/amd64;; arm64) PLAT=linux/arm64;; *) echo "arch must be x64|arm64" >&2; exit 2;; esac
cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./packages/harness/package.json').version")-$(git rev-parse --short HEAD)"
if [ -n "$REL" ]; then NAME="v$REL"; VERSION="$REL+$(git rev-parse --short HEAD)"; else NAME="$VERSION"; fi
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
