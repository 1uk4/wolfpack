#!/usr/bin/env bash
# infra/wolves/run-sim.sh: supervision test in the tracer image (needs Docker; builds wolfpack-tracer first). Not systemd: see fake-systemctl.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; docker build -q -f "$ROOT/infra/tracer/Dockerfile" -t "${TRACER_IMAGE:-wolfpack-tracer}" "$ROOT" >/dev/null
docker run --rm -v "$ROOT/infra/wolves:/opt/wolves:ro" --entrypoint bash "${TRACER_IMAGE:-wolfpack-tracer}" /opt/wolves/sim-test.sh
