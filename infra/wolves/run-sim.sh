#!/usr/bin/env bash
# infra/wolves/run-sim.sh: supervision test in the tracer image (needs Docker; builds wolfpack-tracer first). Not systemd: see fake-systemctl.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; "$ROOT/infra/tracer/run-tracer.sh" --build-only >/dev/null || { echo "FAIL: tracer image build (see infra/tracer/out/result.txt)" >&2; exit 1; }
docker run --rm -v "$ROOT/infra/wolves:/opt/wolves:ro" --entrypoint bash "${TRACER_IMAGE:-wolfpack-tracer}" /opt/wolves/sim-test.sh
