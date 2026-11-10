# Per-run tracer image: ONLY the repo on top of the shared base (see Dockerfile.base). Built by run-tracer.sh from a clean `git archive` export.
#   docker build -f infra/tracer/Dockerfile --build-arg BASE=wolfpack-tracer-base:<hash> <export dir>
ARG BASE
FROM ${BASE}
WORKDIR /opt/wolfpack
# Manifests first (root package.json + lockfile + every workspace package.json, staged by run-tracer.sh via stage-manifests.mjs from the "workspaces" globs),
# so `npm ci` is only invalidated by dependency changes, not by source edits.
COPY .manifests/ ./
# `npm ci` over the whole workspace is deliberate: it is the Linux-clean-lockfile check (git+https bridge dep included). The npm cache is a BuildKit cache mount.
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY extensions ./extensions
RUN npx tsc --build
COPY infra/tracer/kb-ext-entry.ts ./kb-ext-entry.ts
# --kb mode: the real memory/tasks extension sources as one ESM file (packages stay external, resolved from /opt/wolfpack/node_modules)
RUN npx esbuild kb-ext-entry.ts --bundle --platform=node --format=esm --packages=external --outfile=kb-ext.mjs --log-level=warning
COPY scripts/build-server.mjs scripts/release-version.mjs ./scripts/
# --console payload (standalone server built IN the Linux image).
RUN --mount=type=cache,target=/root/.npm node scripts/build-server.mjs --out /opt/console && du -sh /opt/console
# no recursive chmod over /opt (it copied the whole tree into a new 140s layer): root writes with umask 022, so everything is already world-readable
COPY --chmod=755 infra/tracer /opt/tracer
RUN cp /opt/tracer/console-proof.mjs /opt/proof/console-proof.mjs
ENTRYPOINT ["/opt/tracer/entrypoint.sh"]
